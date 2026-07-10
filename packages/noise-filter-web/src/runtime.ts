export const DEEP_FILTER_SAMPLE_RATE = 48_000
export const DEEP_FILTER_HOP_SIZE = 480

export type DeepFilterLatencyMode = 'low' | 'balanced' | 'resilient'

declare const sampleRate: number
declare const AudioWorkletProcessor: {
  new(options?: AudioWorkletNodeOptions): { readonly port: MessagePort }
}
declare function registerProcessor(
  name: string,
  processor: new(options: AudioWorkletNodeOptions) => { readonly port: MessagePort },
): void

export interface DeepFilterRuntimeOptions {
  assetBaseUrl?: string
  suppressionLevel?: number
  enabled?: boolean
  latencyMode?: DeepFilterLatencyMode
  onEvent?: (event: DeepFilterRuntimeEvent) => void
}

export type DeepFilterRuntimeEvent =
  | { type: 'ready' }
  | { type: 'error', error: Error }
  | { type: 'overload', avgFrameTimeMs: number }
  | ({ type: 'stats' } & DeepFilterRuntimeStats)

export interface DeepFilterRuntimeStats {
  processedFrames: number
  lateFrames: number
  droppedFrames: number
  underruns: number
  queueDepth: number
  maxQueueDepth: number
  avgFrameTimeMs: number
  p95FrameTimeMs: number
}

interface RuntimeController {
  setEnabled(enabled: boolean): void
  setSuppressionLevel(level: number): void
  waitUntilPrimed(): Promise<void>
  destroy(): void
}

const PROCESSOR_NAME = 'meetbridge-deepfilternet3'
const DEFAULT_ASSET_BASE_URL = '/deepfilternet/'
const DEFAULT_SUPPRESSION_LEVEL = 70
const DEFAULT_LATENCY_MODE: DeepFilterLatencyMode = 'low'
const LOG_PREFIX = '[MeetBridge DeepFilterNet3]'
const workletModules = new WeakMap<AudioContext, Promise<void>>()
const controllers = new WeakMap<AudioWorkletNode, RuntimeController>()

function logRuntime(level: 'info' | 'warn' | 'error', message: string, detail?: unknown) {
  const logger = console[level] || console.info
  if (typeof detail === 'undefined') logger(`${LOG_PREFIX} ${message}`)
  else logger(`${LOG_PREFIX} ${message}`, detail)
}

function clampLevel(value: number | undefined) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_SUPPRESSION_LEVEL
  return Math.max(0, Math.min(100, Math.round(numeric)))
}

export function resolveDeepFilterLatencyMode(value: unknown): DeepFilterLatencyMode {
  if (value === 'balanced' || value === 'resilient') return value
  return DEFAULT_LATENCY_MODE
}

export function deepFilterTransportHops(mode: DeepFilterLatencyMode) {
  if (mode === 'resilient') return 4
  if (mode === 'balanced') return 3
  return 2
}

function resolveAssetUrl(file: string, assetBaseUrl?: string) {
  const base = (assetBaseUrl || DEFAULT_ASSET_BASE_URL).endsWith('/')
    ? assetBaseUrl || DEFAULT_ASSET_BASE_URL
    : (assetBaseUrl || DEFAULT_ASSET_BASE_URL) + '/'

  if (/^[a-z][a-z\d+.-]*:/i.test(base)) return new URL(file, base).toString()
  if (typeof window !== 'undefined') return new URL(base + file, window.location.origin).toString()
  return base + file
}

export function getDeepFilterAssetUrls(assetBaseUrl?: string) {
  return {
    manifestUrl: resolveAssetUrl('manifest.json', assetBaseUrl),
    moduleUrl: resolveAssetUrl('deep_filter.js', assetBaseUrl),
    wasmUrl: resolveAssetUrl('deep_filter_bg.wasm', assetBaseUrl),
    // The .bin suffix prevents static servers from attaching
    // Content-Encoding:gzip and transparently inflating the model before the
    // Rust core's GzDecoder receives it.
    modelUrl: resolveAssetUrl('DeepFilterNet3_onnx.tar.gz.bin', assetBaseUrl),
  }
}

export function canUseDeepFilterRuntime() {
  return typeof window !== 'undefined'
    && typeof AudioWorkletNode !== 'undefined'
    && typeof Worker !== 'undefined'
    && typeof MessageChannel !== 'undefined'
    && typeof WebAssembly !== 'undefined'
    && typeof Blob !== 'undefined'
    && typeof URL !== 'undefined'
    && typeof URL.createObjectURL === 'function'
}

export async function preflightDeepFilterRuntime(assetBaseUrl?: string) {
  if (!canUseDeepFilterRuntime()) {
    logRuntime('warn', 'UNAVAILABLE: this renderer does not support AudioWorklet, Worker, or WebAssembly.')
    return false
  }
  const assets = getDeepFilterAssetUrls(assetBaseUrl)
  try {
    // The committed manifest is an explicit deployment gate. It avoids noisy
    // asset 404s in source-only checkouts and makes a partial copy fail closed.
    const manifestResponse = await fetch(assets.manifestUrl, { cache: 'no-cache' })
    if (!manifestResponse.ok) {
      logRuntime('warn', `UNAVAILABLE: deployment manifest returned HTTP ${manifestResponse.status}.`, assets.manifestUrl)
      return false
    }
    const manifest = await manifestResponse.json() as { available?: unknown, files?: unknown }
    const manifestFiles = Array.isArray(manifest.files) ? manifest.files : []
    const expectedFiles = ['deep_filter.js', 'deep_filter_bg.wasm', 'DeepFilterNet3_onnx.tar.gz.bin']
    if (manifest.available !== true
      || !expectedFiles.every(file => manifestFiles.includes(file))) {
      logRuntime('warn', 'UNAVAILABLE: WASM/model artefacts have not been staged; browser noise suppression fallback remains active.', manifest)
      return false
    }

    const responses = await Promise.all([
      fetch(assets.moduleUrl, { cache: 'force-cache' }),
      fetch(assets.wasmUrl, { cache: 'force-cache' }),
      fetch(assets.modelUrl, { cache: 'force-cache' }),
    ])
    const ready = responses.every(response => response.ok)
    if (ready) logRuntime('info', 'ASSETS READY: model and WASM passed preflight.', assets)
    else logRuntime('warn', 'UNAVAILABLE: one or more staged assets could not be fetched.', responses.map(response => response.status))
    return ready
  } catch (error) {
    logRuntime('error', 'UNAVAILABLE: preflight failed unexpectedly; using browser fallback.', error)
    return false
  }
}

function workletBootstrap() {
  class MeetBridgeDeepFilterWorklet extends AudioWorkletProcessor {
    sourceHop: number
    primeHops = 3
    // The committed DF3 model has one STFT hop plus two configured lookahead
    // hops. A result returned for capture sequence N therefore represents the
    // audio from sequence N - 3.
    coreDelayHops = 3
    maxBacklog = 3
    fallbackHoldHops = 2
    crossfadeSamples: number
    dataPort: MessagePort | null = null
    enabled: boolean
    destroyed = false

    rawFrames: Float32Array[]
    rawSequences: Int32Array
    rawSlotCount = 8
    captureOffset = 0
    captureSequence = 0
    activeCaptureSlot = -1

    slotBuffers: Array<Float32Array | null>
    freeSlotStack: Int16Array
    freeSlotCount: number
    frameMessages: Array<Record<string, any>>
    frameTransfers: Array<ArrayBuffer[]>
    slotCount = 8
    inFlight = 0

    resultFrames: Array<Float32Array | null>
    resultSequences: Int32Array
    resultFiltered: Uint8Array
    resultQueued: Uint8Array
    resultCaptureSlots: Int16Array
    resultSlotCount = 5
    queueDepth = 0
    maxQueueDepth = 0

    playbackStarted = false
    primed = false
    playbackSequence = 0
    playbackOffset = 0
    playbackResultIndex = -1
    playbackRawIndex = -1
    playbackHasFiltered = false
    playbackModeFiltered = false

    fadeCurve: Float32Array
    transitionActive = false
    transitionToFiltered = false
    transitionOffset = 0
    transitionCorrection = 0
    fallbackHoldRemaining = 0
    lastOutput = 0

    lateFrames = 0
    droppedFrames = 0
    underruns = 0
    telemetryCountdown: number
    telemetryMessage: Record<string, any>
    primedMessage = { type: 'primed' }

    constructor(options: AudioWorkletNodeOptions) {
      super()
      const config = options.processorOptions as {
        enabled?: boolean
        latencyMode?: DeepFilterLatencyMode
      } | undefined
      const latencyMode = config?.latencyMode === 'balanced' || config?.latencyMode === 'resilient'
        ? config.latencyMode
        : 'low'
      this.primeHops = latencyMode === 'resilient' ? 4 : latencyMode === 'balanced' ? 3 : 2
      this.maxBacklog = this.primeHops
      this.fallbackHoldHops = latencyMode === 'resilient' ? 3 : 2
      this.rawSlotCount = Math.max(8, this.primeHops + this.coreDelayHops + 2)
      this.resultSlotCount = this.maxBacklog + 3
      this.sourceHop = Math.max(1, Math.round(sampleRate / 100))
      this.crossfadeSamples = this.sourceHop
      this.enabled = config?.enabled !== false

      this.rawFrames = []
      for (let index = 0; index < this.rawSlotCount; index += 1) {
        this.rawFrames.push(new Float32Array(this.sourceHop))
      }
      this.rawSequences = new Int32Array(this.rawSlotCount)
      this.rawSequences.fill(-1)

      this.slotBuffers = []
      this.freeSlotStack = new Int16Array(this.slotCount)
      this.frameMessages = []
      this.frameTransfers = []
      for (let index = 0; index < this.slotCount; index += 1) {
        const buffer = new Float32Array(this.sourceHop)
        this.slotBuffers.push(buffer)
        this.freeSlotStack[index] = index
        this.frameMessages.push({
          type: 'frame',
          sequence: 0,
          captureTimestampMs: 0,
          slotId: index,
          samples: buffer,
        })
        this.frameTransfers.push([buffer.buffer])
      }
      this.freeSlotCount = this.slotCount

      this.resultFrames = []
      for (let index = 0; index < this.resultSlotCount; index += 1) this.resultFrames.push(null)
      this.resultSequences = new Int32Array(this.resultSlotCount)
      this.resultSequences.fill(-1)
      this.resultFiltered = new Uint8Array(this.resultSlotCount)
      this.resultQueued = new Uint8Array(this.resultSlotCount)
      this.resultCaptureSlots = new Int16Array(this.resultSlotCount)
      this.resultCaptureSlots.fill(-1)

      this.fadeCurve = new Float32Array(this.crossfadeSamples)
      for (let index = 0; index < this.crossfadeSamples; index += 1) {
        const position = this.crossfadeSamples === 1
          ? 1
          : index / (this.crossfadeSamples - 1)
        // A raised-cosine curve has zero slope at both ends. It avoids the
        // small envelope corner that a linear fade can make audible on speech.
        this.fadeCurve[index] = 0.5 - 0.5 * Math.cos(Math.PI * position)
      }
      this.telemetryCountdown = Math.round(sampleRate * 5)
      this.telemetryMessage = {
        type: 'telemetry',
        lateFrames: 0,
        droppedFrames: 0,
        underruns: 0,
        queueDepth: 0,
        maxQueueDepth: 0,
      }

      this.port.onmessage = (event: MessageEvent) => {
        const data = event.data as Record<string, any> | undefined
        if (!data) return
        if (data.type === 'connect-worker' && data.port) {
          this.dataPort = data.port as MessagePort
          this.dataPort.onmessage = message => this.handleWorkerMessage(message)
          this.dataPort.start()
          return
        }
        if (data.type === 'enabled') {
          this.enabled = data.enabled !== false
          return
        }
        if (data.type === 'worker-error' || data.type === 'bypass') {
          this.enabled = false
          return
        }
        if (data.type === 'destroy') {
          this.destroyed = true
          this.dataPort?.close()
          this.dataPort = null
        }
      }
    }

    acquireCaptureSlot() {
      if (!this.dataPort
        || this.inFlight + this.queueDepth >= this.maxBacklog
        || this.freeSlotCount <= 0) return -1
      this.freeSlotCount -= 1
      return this.freeSlotStack[this.freeSlotCount]
    }

    releaseCaptureSlot(slotId: number) {
      if (slotId < 0 || slotId >= this.slotCount || this.freeSlotCount >= this.slotCount) return
      this.freeSlotStack[this.freeSlotCount] = slotId
      this.freeSlotCount += 1
    }

    releaseResult(resultIndex: number) {
      if (resultIndex < 0 || this.resultSequences[resultIndex] < 0) return
      const slotId = this.resultCaptureSlots[resultIndex]
      this.resultFrames[resultIndex] = null
      this.resultSequences[resultIndex] = -1
      this.resultFiltered[resultIndex] = 0
      if (this.resultQueued[resultIndex] === 1 && this.queueDepth > 0) this.queueDepth -= 1
      this.resultQueued[resultIndex] = 0
      this.resultCaptureSlots[resultIndex] = -1
      this.releaseCaptureSlot(slotId)
    }

    handleWorkerMessage(event: MessageEvent) {
      const data = event.data as Record<string, any> | undefined
      if (!data || data.type !== 'result' || !data.samples) return
      if (this.inFlight > 0) this.inFlight -= 1

      const sequence = Number(data.sequence)
      const slotId = Number(data.slotId)
      if (!Number.isInteger(sequence) || !Number.isInteger(slotId) || slotId < 0 || slotId >= this.slotCount) return

      const frame = data.samples as Float32Array
      this.slotBuffers[slotId] = frame
      if (frame.length !== this.sourceHop) {
        this.droppedFrames += 1
        this.releaseCaptureSlot(slotId)
        return
      }

      const playbackAlreadyStarted = this.playbackStarted
        && (sequence < this.playbackSequence
          || (sequence === this.playbackSequence && this.playbackOffset > 0))
      if (playbackAlreadyStarted) {
        this.lateFrames += 1
        this.releaseCaptureSlot(slotId)
        return
      }

      if (this.queueDepth >= this.primeHops) {
        let oldestIndex = -1
        let oldestSequence = Number.MAX_SAFE_INTEGER
        for (let index = 0; index < this.resultSlotCount; index += 1) {
          const queuedSequence = this.resultSequences[index]
          if (this.resultQueued[index] === 1 && queuedSequence < oldestSequence) {
            oldestSequence = queuedSequence
            oldestIndex = index
          }
        }
        if (oldestIndex >= 0) {
          this.droppedFrames += 1
          this.releaseResult(oldestIndex)
        }
      }

      const resultIndex = sequence % this.resultSlotCount
      if (this.resultSequences[resultIndex] >= 0) {
        this.droppedFrames += 1
        this.releaseResult(resultIndex)
      }
      this.resultFrames[resultIndex] = frame
      this.resultSequences[resultIndex] = sequence
      this.resultFiltered[resultIndex] = data.filtered === true ? 1 : 0
      this.resultQueued[resultIndex] = 1
      this.resultCaptureSlots[resultIndex] = slotId
      this.queueDepth += 1
      if (this.queueDepth > this.maxQueueDepth) this.maxQueueDepth = this.queueDepth
    }

    beginCaptureFrame() {
      const rawIndex = this.captureSequence % this.rawSlotCount
      this.rawSequences[rawIndex] = this.captureSequence
      this.activeCaptureSlot = this.acquireCaptureSlot()
    }

    finishCaptureFrame() {
      const sequence = this.captureSequence
      const slotId = this.activeCaptureSlot
      const buffer = slotId >= 0 ? this.slotBuffers[slotId] : null
      if (slotId >= 0
        && buffer
        && this.dataPort
        && this.inFlight + this.queueDepth < this.maxBacklog) {
        const message = this.frameMessages[slotId]
        const transfer = this.frameTransfers[slotId]
        message.sequence = sequence
        message.captureTimestampMs = sequence * this.sourceHop * 1000 / sampleRate
        message.samples = buffer
        transfer[0] = buffer.buffer as ArrayBuffer
        this.slotBuffers[slotId] = null
        this.inFlight += 1
        const backlogDepth = this.inFlight + this.queueDepth
        if (backlogDepth > this.maxQueueDepth) this.maxQueueDepth = backlogDepth
        try {
          this.dataPort.postMessage(message, transfer)
        } catch {
          this.inFlight -= 1
          this.slotBuffers[slotId] = buffer
          this.releaseCaptureSlot(slotId)
          this.droppedFrames += 1
        }
      } else {
        if (slotId >= 0) this.releaseCaptureSlot(slotId)
        this.droppedFrames += 1
      }
      this.activeCaptureSlot = -1
      this.captureOffset = 0
      this.captureSequence += 1

      if (!this.playbackStarted && this.captureSequence >= this.primeHops) {
        this.playbackStarted = true
        this.playbackSequence = 0
        this.playbackOffset = 0
        this.beginPlaybackFrame()
      }
    }

    beginPlaybackFrame() {
      const rawSequence = this.playbackSequence - this.coreDelayHops
      this.playbackRawIndex = rawSequence >= 0 ? rawSequence % this.rawSlotCount : -1
      if (rawSequence >= 0 && this.rawSequences[this.playbackRawIndex] !== rawSequence) {
        this.playbackRawIndex = -1
        this.underruns += 1
      }

      const resultIndex = this.playbackSequence % this.resultSlotCount
      const hasResult = this.resultSequences[resultIndex] === this.playbackSequence
      this.playbackResultIndex = hasResult ? resultIndex : -1
      if (hasResult && this.resultQueued[resultIndex] === 1) {
        this.resultQueued[resultIndex] = 0
        if (this.queueDepth > 0) this.queueDepth -= 1
      }
      this.playbackHasFiltered = hasResult && this.resultFiltered[resultIndex] === 1
      if (this.enabled && !hasResult) this.underruns += 1

      if (this.enabled && !this.playbackHasFiltered) {
        // A single missed hop must not create a raw/filtered/raw flutter. Stay
        // on the aligned raw timeline until three consecutive filtered hops
        // have arrived, then make one smooth transition back.
        this.fallbackHoldRemaining = this.fallbackHoldHops
      } else if (this.fallbackHoldRemaining > 0) {
        this.fallbackHoldRemaining -= 1
      }

      const targetFiltered = this.enabled
        && this.playbackHasFiltered
        && this.fallbackHoldRemaining === 0
      if (targetFiltered !== this.playbackModeFiltered) {
        this.transitionActive = true
        this.transitionToFiltered = targetFiltered
        this.transitionOffset = 0
        if (targetFiltered) {
          this.transitionCorrection = 0
        } else {
          const rawFrame = this.playbackRawIndex >= 0 ? this.rawFrames[this.playbackRawIndex] : null
          const rawStart = rawFrame ? rawFrame[0] : this.lastOutput
          this.transitionCorrection = this.lastOutput - rawStart
        }
      }

      // Do not expose the destination track until both the bounded transport
      // jitter and DF3's inherent STFT/lookahead delay have elapsed. From this
      // point on, every missing result has a real time-aligned raw counterpart.
      if (!this.primed && this.playbackSequence >= this.coreDelayHops) {
        this.primed = true
        this.port.postMessage(this.primedMessage)
      }
    }

    renderPlaybackSample() {
      const rawFrame = this.playbackRawIndex >= 0 ? this.rawFrames[this.playbackRawIndex] : null
      const raw = rawFrame ? rawFrame[this.playbackOffset] : this.lastOutput
      const filteredFrame = this.playbackResultIndex >= 0 ? this.resultFrames[this.playbackResultIndex] : null
      const filtered = filteredFrame && this.playbackHasFiltered
        ? filteredFrame[this.playbackOffset]
        : raw

      let next = this.playbackModeFiltered && this.playbackHasFiltered ? filtered : raw
      if (this.transitionActive) {
        const mix = this.fadeCurve[this.transitionOffset]
        if (this.transitionToFiltered && this.playbackHasFiltered) {
          next = raw * (1 - mix) + filtered * mix
        } else {
          // Preserve the current raw waveform and decay only the boundary
          // offset. Unlike recursive blending, this does not smear consonants
          // or flatten the speech waveform during a fallback transition.
          next = raw + this.transitionCorrection * (1 - mix)
        }
        this.transitionOffset += 1
        if (this.transitionOffset >= this.crossfadeSamples) {
          this.transitionActive = false
          this.playbackModeFiltered = this.transitionToFiltered
          this.transitionCorrection = 0
        }
      }

      this.lastOutput = next
      this.playbackOffset += 1
      if (this.playbackOffset >= this.sourceHop) {
        if (this.playbackResultIndex >= 0) this.releaseResult(this.playbackResultIndex)
        this.playbackResultIndex = -1
        this.playbackOffset = 0
        this.playbackSequence += 1
      }
      return next
    }

    emitTelemetryIfDue(outputLength: number) {
      this.telemetryCountdown -= outputLength
      if (this.telemetryCountdown > 0) return
      this.telemetryCountdown += Math.round(sampleRate * 5)
      const message = this.telemetryMessage
      message.lateFrames = this.lateFrames
      message.droppedFrames = this.droppedFrames
      message.underruns = this.underruns
      message.queueDepth = this.inFlight + this.queueDepth
      message.maxQueueDepth = this.maxQueueDepth
      this.port.postMessage(message)
    }

    process(inputs: Float32Array[][], outputs: Float32Array[][]) {
      if (this.destroyed) return false
      const input = inputs[0]
      const output = outputs[0]
      const outputLength = output?.[0]?.length || 0
      for (let index = 0; index < outputLength; index += 1) {
        if (this.captureOffset === 0) this.beginCaptureFrame()
        let sample = 0
        if (input?.length) {
          for (let channel = 0; channel < input.length; channel += 1) sample += input[channel]?.[index] || 0
          sample /= input.length
        }
        const rawIndex = this.captureSequence % this.rawSlotCount
        this.rawFrames[rawIndex][this.captureOffset] = sample
        if (this.activeCaptureSlot >= 0) {
          const captureBuffer = this.slotBuffers[this.activeCaptureSlot]
          if (captureBuffer) captureBuffer[this.captureOffset] = sample
        }
        this.captureOffset += 1
        if (this.captureOffset >= this.sourceHop) this.finishCaptureFrame()

        const next = this.playbackStarted ? this.renderPlaybackSample() : 0
        if (this.playbackStarted && this.playbackOffset === 0) this.beginPlaybackFrame()
        for (let channel = 0; channel < output.length; channel += 1) output[channel][index] = next
      }
      this.emitTelemetryIfDue(outputLength)
      return true
    }
  }
  registerProcessor('meetbridge-deepfilternet3', MeetBridgeDeepFilterWorklet)
}

function workerBootstrap() {
  const workerScope = self as typeof self & {
    __meetbridgeImport: (url: string) => Promise<Record<string, any>>
  }
  let state: number | null = null
  let bindings: Record<string, any> | null = null
  let dataPort: MessagePort | null = null
  let requestedEnabled = true
  let autoBypassed = false
  let autoBypassFrames = 0
  let recoveryWarmupFrames = 0
  let modelInput: Float32Array<ArrayBufferLike> = new Float32Array(480)
  let frameCount = 0
  let frameTimeTotal = 0
  let guardFrameCount = 0
  let rollingFrameTimeMs = 0
  let overDeadlineStreak = 0
  let sustainedHighAverageFrames = 0
  let phase = 'idle'
  let lastSequence = -1
  let errorReported = false
  const processingHistogram = new Uint32Array(40)

  function resetOverloadGuard() {
    guardFrameCount = 0
    rollingFrameTimeMs = 0
    overDeadlineStreak = 0
    sustainedHighAverageFrames = 0
  }

  function toAttenuation(level: number) {
    return -Math.max(0, Math.min(100, Number(level) || 0)) * 0.8
  }

  function sinc(value: number) {
    if (Math.abs(value) < 0.00000001) return 1
    const piValue = Math.PI * value
    return Math.sin(piValue) / piValue
  }

  function resampleInto(input: Float32Array, output: Float32Array) {
    if (input.length === output.length) {
      output.set(input)
      return
    }
    const ratio = input.length / output.length
    const halfTaps = 16
    for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
      const center = (outputIndex + 0.5) * ratio - 0.5
      const left = Math.floor(center) - halfTaps + 1
      let sum = 0
      let weightSum = 0
      for (let tap = 0; tap < halfTaps * 2; tap += 1) {
        const sourceIndex = left + tap
        if (sourceIndex < 0 || sourceIndex >= input.length) continue
        const distance = sourceIndex - center
        const windowWeight = 0.5 + 0.5 * Math.cos(Math.PI * distance / halfTaps)
        const weight = sinc(distance) * windowWeight
        sum += input[sourceIndex] * weight
        weightSum += weight
      }
      output[outputIndex] = weightSum ? sum / weightSum : 0
    }
  }

  function processingP95() {
    const target = Math.max(1, Math.ceil(frameCount * 0.95))
    let cumulative = 0
    for (let index = 0; index < processingHistogram.length; index += 1) {
      cumulative += processingHistogram[index]
      if (cumulative >= target) return (index + 1) * 0.5
    }
    return processingHistogram.length * 0.5
  }

  function postWorkerStats() {
    postMessage({
      type: 'worker-stats',
      processedFrames: frameCount,
      avgFrameTimeMs: frameCount ? frameTimeTotal / frameCount : 0,
      p95FrameTimeMs: processingP95(),
    })
  }

  async function initialise(config: Record<string, any>) {
    modelInput = new Float32Array(480)
    requestedEnabled = config.enabled !== false
    resetOverloadGuard()
    phase = 'importing-bindings'
    bindings = await workerScope.__meetbridgeImport(config.moduleUrl)
    const initialiseWasm = bindings?.default || bindings?.init
    if (typeof initialiseWasm !== 'function') throw new Error('DeepFilterNet3 WASM init is unavailable')
    phase = 'initializing-wasm'
    await initialiseWasm(config.wasmUrl)
    phase = 'fetching-model'
    const response = await fetch(config.modelUrl, { cache: 'force-cache' })
    if (!response.ok) throw new Error('DeepFilterNet3 model asset is unavailable')
    phase = 'reading-model'
    const model = new Uint8Array(await response.arrayBuffer())
    if (model[0] !== 0x1f || model[1] !== 0x8b) {
      throw new Error('DeepFilterNet3 model response is not gzip-compressed; check Content-Encoding')
    }
    phase = 'creating-state'
    const configuredLevel = Number(config.suppressionLevel)
    const suppressionLevel = Number.isFinite(configuredLevel)
      ? configuredLevel
      : 70
    state = bindings?.df_create(model, toAttenuation(suppressionLevel))
    if (!state) throw new Error('DeepFilterNet3 state could not initialise')
    phase = 'ready'
    postMessage({ type: 'ready', modelBytes: model.byteLength })
  }

  function returnRawFrame(data: Record<string, any>, input: Float32Array) {
    dataPort?.postMessage({
      type: 'result',
      sequence: data.sequence,
      captureTimestampMs: data.captureTimestampMs,
      slotId: data.slotId,
      samples: input,
      filtered: false,
    }, [input.buffer])
  }

  function handleFrame(data: Record<string, any>) {
    if (data.type !== 'frame' || !data.samples || !dataPort) return
    const input = data.samples as Float32Array
    try {
      const sequence = Number(data.sequence)
      if (!Number.isInteger(sequence) || sequence <= lastSequence) {
        returnRawFrame(data, input)
        return
      }
      lastSequence = sequence

      if (autoBypassed) {
        autoBypassFrames += 1
        if (autoBypassFrames >= 100) {
          autoBypassed = false
          autoBypassFrames = 0
          recoveryWarmupFrames = 20
          resetOverloadGuard()
          postMessage({ type: 'recovering' })
        }
      }

      const shouldProcess = requestedEnabled && !autoBypassed && Boolean(bindings) && Boolean(state)
      if (!shouldProcess || !bindings || !state) {
        returnRawFrame(data, input)
        return
      }

      phase = 'processing-frame'
      const startedAt = performance.now()
      if (input.length === 480) modelInput = input
      else resampleInto(input, modelInput)
      const processed = bindings.df_process_frame(state, modelInput)
      if (input.length === processed.length) input.set(processed)
      else resampleInto(processed, input)
      const frameTimeMs = performance.now() - startedAt
      frameCount += 1
      frameTimeTotal += frameTimeMs
      const histogramIndex = Math.max(0, Math.min(processingHistogram.length - 1, Math.floor(frameTimeMs * 2)))
      processingHistogram[histogramIndex] += 1
      guardFrameCount += 1
      rollingFrameTimeMs = guardFrameCount === 1
        ? frameTimeMs
        : rollingFrameTimeMs * 0.95 + frameTimeMs * 0.05
      overDeadlineStreak = frameTimeMs > 9.5 ? overDeadlineStreak + 1 : 0
      sustainedHighAverageFrames = guardFrameCount > 100 && rollingFrameTimeMs > 8
        ? sustainedHighAverageFrames + 1
        : 0
      const avgFrameTimeMs = frameTimeTotal / frameCount
      const sustainedOverload = guardFrameCount > 100
        && (overDeadlineStreak >= 8 || sustainedHighAverageFrames >= 50)
      if (sustainedOverload) {
        autoBypassed = true
        autoBypassFrames = 0
        postMessage({
          type: 'overload',
          avgFrameTimeMs,
          rollingFrameTimeMs,
          overDeadlineStreak,
        })
      }

      let filtered = !autoBypassed && recoveryWarmupFrames <= 0
      if (recoveryWarmupFrames > 0) {
        recoveryWarmupFrames -= 1
        filtered = false
        if (recoveryWarmupFrames === 0) postMessage({ type: 'recovered' })
      }
      const shouldPostStats = frameCount % 500 === 0
      phase = 'ready'
      dataPort.postMessage({
        type: 'result',
        sequence,
        captureTimestampMs: data.captureTimestampMs,
        slotId: data.slotId,
        samples: input,
        filtered,
      }, [input.buffer])
      if (shouldPostStats) {
        // Audio delivery has priority over telemetry. A telemetry failure must
        // never re-enter the audio fallback path after the buffer was moved.
        try {
          postWorkerStats()
        } catch {
          // The next rate-limited window will retry.
        }
      }
    } catch (error) {
      returnRawFrame(data, input)
      const message = error instanceof Error ? error.message : String(error)
      const stack = error instanceof Error ? error.stack : undefined
      requestedEnabled = false
      if (!errorReported) {
        errorReported = true
        postMessage({ type: 'error', message, phase, stack })
      }
    }
  }

  self.onmessage = async (event: MessageEvent) => {
    const data = event.data as Record<string, any>
    try {
      if (data.type === 'connect-worklet' && data.port) {
        dataPort = data.port as MessagePort
        dataPort.onmessage = message => handleFrame(message.data as Record<string, any>)
        dataPort.start()
        return
      }
      if (data.type === 'init') {
        await initialise(data)
        return
      }
      if (data.type === 'enabled') {
        const nextEnabled = data.enabled !== false
        if (nextEnabled && !requestedEnabled) {
          recoveryWarmupFrames = 20
          resetOverloadGuard()
          errorReported = false
        }
        requestedEnabled = nextEnabled
        if (!nextEnabled) {
          autoBypassed = false
          recoveryWarmupFrames = 0
        }
        return
      }
      if (data.type === 'suppression-level') {
        if (bindings && state) bindings.df_set_atten_lim(state, toAttenuation(Number(data.level) || 0))
        return
      }
      if (data.type === 'destroy') {
        dataPort?.close()
        dataPort = null
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const stack = error instanceof Error ? error.stack : undefined
      postMessage({ type: 'error', message, phase, stack })
    }
  }
}

function sourceFromBootstrap(bootstrap: Function) {
  const text = bootstrap.toString()
  return '(' + text + ')()'
}

async function installWorkletModule(audioContext: AudioContext) {
  let pending = workletModules.get(audioContext)
  if (!pending) {
    const source = sourceFromBootstrap(workletBootstrap)
    const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    pending = audioContext.audioWorklet.addModule(blobUrl).finally(() => URL.revokeObjectURL(blobUrl))
    workletModules.set(audioContext, pending)
  }
  await pending
}

export async function createDeepFilterRuntimeNode(
  audioContext: AudioContext,
  options: DeepFilterRuntimeOptions = {},
) {
  if (!canUseDeepFilterRuntime()) throw new Error('AudioWorklet or WebAssembly is unavailable')
  await installWorkletModule(audioContext)
  const latencyMode = resolveDeepFilterLatencyMode(options.latencyMode)
  const node = new AudioWorkletNode(audioContext, PROCESSOR_NAME, {
    channelCount: 1,
    channelCountMode: 'explicit',
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: {
      enabled: options.enabled !== false,
      latencyMode,
    },
  })
  // Keep the import expression inside generated worker source. If it appears
  // as renderer syntax, Vite rewrites it to __vite__injectQuery, which does
  // not exist when the serialized bootstrap executes in its Blob Worker.
  const workerSource = 'self.__meetbridgeImport = (url) => import(url);\n'
    + sourceFromBootstrap(workerBootstrap)
  const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }))
  const worker = new Worker(workerUrl, { type: 'module', name: PROCESSOR_NAME })
  const audioChannel = new MessageChannel()
  node.port.postMessage({ type: 'connect-worker', port: audioChannel.port1 }, [audioChannel.port1])
  worker.postMessage({ type: 'connect-worklet', port: audioChannel.port2 }, [audioChannel.port2])
  const assets = getDeepFilterAssetUrls(options.assetBaseUrl)
  logRuntime('info', 'INITIALISING: worker is loading the model before microphone publication.', {
    sampleRate: audioContext.sampleRate,
    assetBaseUrl: options.assetBaseUrl || DEFAULT_ASSET_BASE_URL,
    latencyMode,
    transportHops: deepFilterTransportHops(latencyMode),
  })
  let destroyed = false
  let resolveReady: (() => void) | null = null
  let rejectReady: ((error: Error) => void) | null = null
  let resolvePrimed: (() => void) | null = null
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const primed = new Promise<void>(resolve => {
    resolvePrimed = resolve
  })
  const telemetry: DeepFilterRuntimeStats = {
    processedFrames: 0,
    lateFrames: 0,
    droppedFrames: 0,
    underruns: 0,
    queueDepth: 0,
    maxQueueDepth: 0,
    avgFrameTimeMs: 0,
    p95FrameTimeMs: 0,
  }
  let lastTelemetryLogAt = 0
  let lastLoggedLateFrames = 0
  let lastLoggedDroppedFrames = 0
  let lastLoggedUnderruns = 0
  const emit = (event: DeepFilterRuntimeEvent) => {
    if (!destroyed) options.onEvent?.(event)
  }
  const publishTelemetry = () => {
    emit({ type: 'stats', ...telemetry })
    const now = performance.now()
    if (now - lastTelemetryLogAt < 5000 || telemetry.processedFrames < 100) return
    const hasNewFallback = telemetry.lateFrames > lastLoggedLateFrames
      || telemetry.droppedFrames > lastLoggedDroppedFrames
      || telemetry.underruns > lastLoggedUnderruns
    const detail = { ...telemetry }
    if (hasNewFallback) {
      logRuntime('warn', 'AUDIO FALLBACK: late or missing frames used time-aligned raw audio.', detail)
    } else {
      logRuntime('info', 'AUDIO STABLE', detail)
    }
    lastTelemetryLogAt = now
    lastLoggedLateFrames = telemetry.lateFrames
    lastLoggedDroppedFrames = telemetry.droppedFrames
    lastLoggedUnderruns = telemetry.underruns
  }
  const fail = (error: Error) => {
    node.port.postMessage({ type: 'worker-error' })
    rejectReady?.(error)
    rejectReady = null
    logRuntime('error', 'ERROR: worker initialisation or processing failed; audio is bypassed.', error)
    emit({ type: 'error', error })
  }

  worker.onmessage = event => {
    const data = event.data as Record<string, any>
    if (data.type === 'ready') {
      resolveReady?.()
      resolveReady = null
      rejectReady = null
      logRuntime('info', 'ACTIVE: DeepFilterNet3 worker is ready and filtering local microphone audio.', {
        sampleRate: audioContext.sampleRate,
        modelBytes: Number(data.modelBytes || 0),
      })
      emit({ type: 'ready' })
      return
    }
    if (data.type === 'worker-stats') {
      telemetry.processedFrames = Number(data.processedFrames || 0)
      telemetry.avgFrameTimeMs = Number(data.avgFrameTimeMs || 0)
      telemetry.p95FrameTimeMs = Number(data.p95FrameTimeMs || 0)
      publishTelemetry()
      return
    }
    if (data.type === 'overload') {
      logRuntime('warn', 'OVERLOAD: sustained processing load exceeded the real-time budget; using delayed raw audio during cooldown.', {
        avgFrameTimeMs: Number(data.avgFrameTimeMs || 0),
        rollingFrameTimeMs: Number(data.rollingFrameTimeMs || 0),
        overDeadlineStreak: Number(data.overDeadlineStreak || 0),
      })
      emit({ type: 'overload', avgFrameTimeMs: Number(data.avgFrameTimeMs || 0) })
      return
    }
    if (data.type === 'recovering') {
      logRuntime('info', 'RECOVERY: worker cooldown completed; warming model state on delayed raw audio.')
      return
    }
    if (data.type === 'recovered') {
      logRuntime('info', 'RECOVERED: filtered output resumed with a short crossfade.')
      return
    }
    if (data.type === 'error') {
      const error = new Error(`[${String(data.phase || 'worker')}] ${String(data.message || 'DeepFilterNet3 worker failed')}`)
      if (data.stack) error.stack = `${error.stack}\nWorker: ${String(data.stack)}`
      fail(error)
    }
  }
  worker.onerror = event => fail(new Error(event.message || 'DeepFilterNet3 worker failed'))
  node.port.onmessage = event => {
    const data = event.data as Record<string, any>
    if (data.type === 'primed') {
      resolvePrimed?.()
      resolvePrimed = null
      return
    }
    if (data.type === 'telemetry') {
      telemetry.lateFrames = Number(data.lateFrames || 0)
      telemetry.droppedFrames = Number(data.droppedFrames || 0)
      telemetry.underruns = Number(data.underruns || 0)
      telemetry.queueDepth = Number(data.queueDepth || 0)
      telemetry.maxQueueDepth = Number(data.maxQueueDepth || 0)
      publishTelemetry()
    }
  }

  worker.postMessage({
    type: 'init',
    ...assets,
    enabled: options.enabled !== false,
    suppressionLevel: clampLevel(options.suppressionLevel),
  })
  try {
    await ready
  } catch (error) {
    worker.terminate()
    node.disconnect()
    URL.revokeObjectURL(workerUrl)
    throw error
  }

  controllers.set(node, {
    setEnabled(enabled) {
      node.port.postMessage({ type: 'enabled', enabled })
      worker.postMessage({ type: 'enabled', enabled })
    },
    setSuppressionLevel(level) {
      worker.postMessage({ type: 'suppression-level', level: clampLevel(level) })
    },
    waitUntilPrimed() {
      return primed
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      controllers.delete(node)
      resolvePrimed?.()
      resolvePrimed = null
      node.port.postMessage({ type: 'destroy' })
      worker.postMessage({ type: 'destroy' })
      node.port.onmessage = null
      node.disconnect()
      worker.terminate()
      URL.revokeObjectURL(workerUrl)
    },
  })
  return node
}

export function controlDeepFilterRuntimeNode(node: AudioWorkletNode) {
  return controllers.get(node) || null
}
