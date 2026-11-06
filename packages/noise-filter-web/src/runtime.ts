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

const assetManifests = new Map<string, {
  expiresAt: number
  pending: Promise<ReturnType<typeof getDeepFilterAssetUrls>>
}>()

async function resolveDeepFilterAssets(assetBaseUrl?: string) {
  const assets = getDeepFilterAssetUrls(assetBaseUrl)
  const cached = assetManifests.get(assets.manifestUrl)
  if (cached && cached.expiresAt > Date.now()) return cached.pending
  const pending = (async () => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    try {
      // Preflight reads only the small deployment manifest. The Worker owns
      // the single validated model/WASM download when a microphone is used.
      const response = await fetch(assets.manifestUrl, {
        cache: 'no-cache', signal: controller.signal,
      })
      if (!response.ok) throw new Error(`Deployment manifest returned HTTP ${response.status}`)
      const manifest = await response.json() as {
        available?: unknown
        files?: unknown
        revisions?: Record<string, unknown>
      }
      const files = Array.isArray(manifest.files) ? manifest.files : []
      const expectedFiles = ['deep_filter.js', 'deep_filter_bg.wasm', 'DeepFilterNet3_onnx.tar.gz.bin']
      if (manifest.available !== true || !expectedFiles.every(file => files.includes(file))) {
        throw new Error('WASM/model assets have not been staged')
      }
      const versioned = (url: string, file: string) => {
        const revision = manifest.revisions?.[file]
        return typeof revision === 'string' && /^[a-f0-9]{64}$/.test(revision)
          ? `${url}?v=${revision}` : url
      }
      return {
        ...assets,
        moduleUrl: versioned(assets.moduleUrl, expectedFiles[0]),
        wasmUrl: versioned(assets.wasmUrl, expectedFiles[1]),
        modelUrl: versioned(assets.modelUrl, expectedFiles[2]),
      }
    } finally {
      clearTimeout(timeout)
    }
  })()
  assetManifests.set(assets.manifestUrl, { expiresAt: Date.now() + 60_000, pending })
  try {
    return await pending
  } catch (error) {
    if (assetManifests.get(assets.manifestUrl)?.pending === pending) assetManifests.delete(assets.manifestUrl)
    throw error
  }
}

export async function preflightDeepFilterRuntime(assetBaseUrl?: string) {
  if (!canUseDeepFilterRuntime()) {
    logRuntime('warn', 'UNAVAILABLE: this renderer does not support AudioWorklet, Worker, or WebAssembly.')
    return false
  }
  try {
    const assets = await resolveDeepFilterAssets(assetBaseUrl)
    logRuntime('info', 'ASSETS READY: deployment manifest validated; model and WASM load when the microphone starts.', assets)
    return true
  } catch (error) {
    logRuntime('warn', 'UNAVAILABLE: asset manifest could not be prepared; using browser fallback.', error)
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
        || this.inFlight >= this.maxBacklog
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
    }

    finishCaptureFrame() {
      const sequence = this.captureSequence
      // Reserve a transferable slot only after capture is complete. A result
      // that arrives during this hop can free capacity; deciding at hop start
      // unnecessarily dropped the entire 10 ms frame. Ready playback results
      // occupy their own bounded ring and must not block worker admission.
      const slotId = this.acquireCaptureSlot()
      const buffer = slotId >= 0 ? this.slotBuffers[slotId] : null
      if (slotId >= 0 && buffer && this.dataPort) {
        buffer.set(this.rawFrames[sequence % this.rawSlotCount])
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
      this.captureOffset = 0
      this.captureSequence += 1

      if (!this.playbackStarted && this.captureSequence >= this.primeHops) {
        this.playbackStarted = true
        this.playbackSequence = 0
        this.playbackOffset = 0
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
        this.captureOffset += 1
        if (this.captureOffset >= this.sourceHop) this.finishCaptureFrame()

        // Choose the result at the first sample of its playback hop, not at
        // the last sample of the preceding hop. Worker messages may arrive
        // between render callbacks and still meet this frame's deadline.
        if (this.playbackStarted && this.playbackOffset === 0) this.beginPlaybackFrame()
        const next = this.playbackStarted ? this.renderPlaybackSample() : 0
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
  const modelInput = new Float32Array(480)
  let consecutiveProcessedFrames = 3
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

  const resamplePlans = new Map<string, { indices: Int32Array, weights: Float32Array }>()

  function getResamplePlan(inputLength: number, outputLength: number) {
    const key = inputLength + ':' + outputLength
    const existing = resamplePlans.get(key)
    if (existing) return existing
    const ratio = inputLength / outputLength
    const cutoff = Math.min(1, outputLength / inputLength)
    const halfTaps = 16
    const taps = halfTaps * 2
    const indices = new Int32Array(outputLength * taps)
    const weights = new Float32Array(outputLength * taps)
    for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
      const center = (outputIndex + 0.5) * ratio - 0.5
      const left = Math.floor(center) - halfTaps + 1
      let weightSum = 0
      const offset = outputIndex * taps
      for (let tap = 0; tap < taps; tap += 1) {
        const sourceIndex = left + tap
        if (sourceIndex < 0 || sourceIndex >= inputLength) continue
        const distance = sourceIndex - center
        const windowWeight = 0.5 + 0.5 * Math.cos(Math.PI * distance / halfTaps)
        const weight = cutoff * sinc(distance * cutoff) * windowWeight
        indices[offset + tap] = sourceIndex
        weights[offset + tap] = weight
        weightSum += weight
      }
      if (weightSum) {
        for (let tap = 0; tap < taps; tap += 1) weights[offset + tap] /= weightSum
      }
    }
    const plan = { indices, weights }
    resamplePlans.set(key, plan)
    return plan
  }

  function resampleInto(input: Float32Array, output: Float32Array) {
    if (input.length === output.length) {
      output.set(input)
      return
    }
    // Each worker has a fixed capture rate. Cache its two coefficient tables
    // instead of evaluating thousands of sin/cos functions every 10 ms.
    const { indices, weights } = getResamplePlan(input.length, output.length)
    for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
      const offset = outputIndex * 32
      let sum = 0
      for (let tap = 0; tap < 32; tap += 1) {
        sum += input[indices[offset + tap]] * weights[offset + tap]
      }
      output[outputIndex] = sum
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

  async function loadAssetBytes(url: string, kind: 'wasm' | 'model') {
    // Versioned URLs are immutable content identities. Never persist legacy
    // unversioned URLs, whose files can change underneath a deployment.
    const revision = new URL(url).searchParams.get('v')
    const versioned = Boolean(revision && /^[a-f0-9]{64}$/.test(revision))
    const canVerify = versioned && typeof crypto !== 'undefined' && Boolean(crypto.subtle)
    let cache: Cache | null = null
    if (canVerify && typeof caches !== 'undefined') {
      try {
        cache = await caches.open('meetbridge-deepfilternet-assets-v1')
      } catch {
        // Private browsing, storage policy and quota must not prevent calls.
      }
    }
    const valid = async (bytes: Uint8Array<ArrayBuffer>) => {
      const headerValid = kind === 'wasm'
        ? bytes[0] === 0 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d
        : bytes[0] === 0x1f && bytes[1] === 0x8b
      if (!headerValid || !canVerify) return headerValid
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
      const actual = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
      return actual === revision
    }
    if (cache) {
      try {
        const cached = await cache.match(url)
        if (cached?.ok) {
          const bytes = new Uint8Array(await cached.arrayBuffer())
          if (await valid(bytes)) return bytes
          await cache.delete(url)
        }
      } catch {
        // Retry from HTTP if reading the persistent cache fails.
      }
    }
    const response = await fetch(url, { cache: 'no-cache' })
    if (!response.ok) throw new Error('DeepFilterNet3 ' + kind + ' asset returned HTTP ' + response.status)
    const persistentResponse = cache ? response.clone() : null
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (!await valid(bytes)) {
      throw new Error('DeepFilterNet3 ' + kind + ' asset failed binary/revision verification; deploy matching manifest and assets and check Content-Encoding')
    }
    if (cache && persistentResponse) {
      try {
        await cache.put(url, persistentResponse)
        // Keep one revision per asset path so package upgrades do not retain
        // another full model indefinitely on storage-constrained devices.
        const current = new URL(url)
        for (const request of await cache.keys()) {
          const previous = new URL(request.url)
          if (previous.origin === current.origin && previous.pathname === current.pathname && request.url !== url) {
            await cache.delete(request)
          }
        }
      } catch {
        // Cache writes are an optimisation; the validated bytes remain usable.
      }
    }
    return bytes
  }

  async function initialise(config: Record<string, any>) {
    requestedEnabled = config.enabled !== false
    resetOverloadGuard()
    phase = 'loading-assets'
    const [loadedBindings, wasmBytes, model] = await Promise.all([
      workerScope.__meetbridgeImport(config.moduleUrl),
      loadAssetBytes(config.wasmUrl, 'wasm'),
      loadAssetBytes(config.modelUrl, 'model'),
    ])
    bindings = loadedBindings
    const initialiseWasm = bindings?.default || bindings?.init
    if (typeof initialiseWasm !== 'function') throw new Error('DeepFilterNet3 WASM init is unavailable')
    phase = 'initializing-wasm'
    await initialiseWasm({ module_or_path: wasmBytes })
    phase = 'creating-state'
    const configuredLevel = Number(config.suppressionLevel)
    const suppressionLevel = Number.isFinite(configuredLevel)
      ? configuredLevel
      : 70
    state = bindings?.df_create(model, toAttenuation(suppressionLevel))
    if (!state) throw new Error('DeepFilterNet3 state could not initialise')
    if (bindings.df_get_frame_length(state) !== 480) {
      throw new Error('DeepFilterNet3 requires a 480-sample core hop')
    }
    phase = 'warming-model'
    // Pay cold inference and resampler setup costs before capture publication.
    // Silent warmup preserves the three-hop alignment of the fresh stream.
    for (let index = 0; index < 3; index += 1) bindings.df_process_frame(state, modelInput)
    const sourceHop = Math.round(Number(config.sampleRate) / 100)
    if (Number.isFinite(sourceHop) && sourceHop > 0 && sourceHop !== 480) {
      getResamplePlan(sourceHop, 480)
      getResamplePlan(480, sourceHop)
    }
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
      if (sequence !== lastSequence + 1) consecutiveProcessedFrames = 0
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
        consecutiveProcessedFrames = 0
        returnRawFrame(data, input)
        return
      }

      phase = 'processing-frame'
      const startedAt = performance.now()
      if (input.length !== 480) resampleInto(input, modelInput)
      const processed = bindings.df_process_frame(state, input.length === 480 ? input : modelInput)
      consecutiveProcessedFrames = Math.min(4, consecutiveProcessedFrames + 1)
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

      // DF3 retains three hops of delayed audio. After a dropped capture or
      // bypass, those outputs belong to the previous timeline; keep aligned
      // raw playback until three fresh consecutive inputs flush that delay.
      let filtered = !autoBypassed && recoveryWarmupFrames <= 0 && consecutiveProcessedFrames > 3
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
      consecutiveProcessedFrames = 0
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
    pending = audioContext.audioWorklet.addModule(blobUrl)
      .catch(error => {
        workletModules.delete(audioContext)
        throw error
      })
      .finally(() => URL.revokeObjectURL(blobUrl))
    workletModules.set(audioContext, pending)
  }
  await pending
}

export async function createDeepFilterRuntimeNode(
  audioContext: AudioContext,
  options: DeepFilterRuntimeOptions = {},
) {
  if (!canUseDeepFilterRuntime()) throw new Error('AudioWorklet or WebAssembly is unavailable')
  const assets = await resolveDeepFilterAssets(options.assetBaseUrl)
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
  logRuntime('info', 'INITIALISING: worker is loading the model for microphone processing.', {
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
      // The worklet's five-second report publishes a single combined snapshot;
      // worker timing updates must not log against stale fallback counters.
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

  const readyTimeout = setTimeout(() => {
    fail(new Error('DeepFilterNet3 worker initialisation timed out after 60 seconds'))
  }, 60_000)
  worker.postMessage({
    type: 'init',
    ...assets,
    sampleRate: audioContext.sampleRate,
    enabled: options.enabled !== false,
    suppressionLevel: clampLevel(options.suppressionLevel),
  })
  try {
    await ready
  } catch (error) {
    node.port.postMessage({ type: 'destroy' })
    node.port.onmessage = null
    node.port.close()
    worker.terminate()
    node.disconnect()
    URL.revokeObjectURL(workerUrl)
    throw error
  } finally {
    clearTimeout(readyTimeout)
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
