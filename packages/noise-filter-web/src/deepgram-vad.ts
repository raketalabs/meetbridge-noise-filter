declare const sampleRate: number
declare const AudioWorkletProcessor: {
  new(options?: AudioWorkletNodeOptions): { readonly port: MessagePort }
}
declare function registerProcessor(
  name: string,
  processor: new(options: AudioWorkletNodeOptions) => { readonly port: MessagePort },
): void

export const DEEPGRAM_PCM_SAMPLE_RATE = 16_000
export const DEEPGRAM_PCM_FRAME_MS = 20

export interface DeepgramVadStats {
  capturedFrames: number
  sentFrames: number
  suppressedFrames: number
  droppedFrames: number
  noiseFloorDbfs: number
  openThresholdDbfs: number
  speaking: boolean
}

export interface DeepgramVadPcmStreamOptions {
  track: MediaStreamTrack
  preRollMs?: number
  hangoverMs?: number
  absoluteThresholdDbfs?: number
  speechMarginDb?: number
  onAudioFrame: (
    buffer: ArrayBuffer,
    sequence: number,
    captureTimestampMs: number,
    dbfs: number,
  ) => void
  onSpeechState?: (speaking: boolean) => void
  onStats?: (stats: DeepgramVadStats) => void
  onError?: (error: Error) => void
}

export interface DeepgramVadPcmStream {
  readonly encoding: 'linear16'
  readonly sampleRate: number
  readonly channels: 1
  getStats(): DeepgramVadStats
  stop(): void
}

const PROCESSOR_NAME = 'meetbridge-deepgram-vad-pcm'
const FRAME_POOL_SIZE = 64

function clampNumber(value: number | undefined, fallback: number, min: number, max: number) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, numeric))
}

function sourceFromBootstrap(bootstrap: Function) {
  return '(' + bootstrap.toString() + ')()'
}

function deepgramVadWorkletBootstrap() {
  class MeetBridgeDeepgramVadProcessor extends AudioWorkletProcessor {
    targetSampleRate: number
    frameMs: number
    frameSamples: number
    preRollFrames: number
    hangoverFrames: number
    speechMarginDb: number
    absoluteThresholdDbfs: number
    closeHysteresisDb = 4

    slotCount = 64
    slotFrames: Array<Int16Array | null>
    freeSlots: Int16Array
    freeSlotCount: number
    frameMessages: Array<Record<string, any>>
    frameTransfers: Array<ArrayBuffer[]>
    currentSlot = -1
    currentOffset = 0
    currentEnergy = 0

    preRollSlots: Int16Array
    preRollSequences: Float64Array
    preRollDbfs: Float32Array
    preRollWrite = 0
    preRollCount = 0

    resamplePhase = 0
    resampleSum = 0
    resampleCount = 0
    sequence = 0
    speaking = false
    attackFrames = 1
    attackCount = 0
    hangoverRemaining = 0
    noiseFloorDbfs = -70
    openThresholdDbfs = -55
    destroyed = false

    capturedFrames = 0
    sentFrames = 0
    suppressedFrames = 0
    droppedFrames = 0
    telemetryFrameCountdown: number
    speechStartMessage = { type: 'speech-state', speaking: true }
    speechEndMessage = { type: 'speech-state', speaking: false }
    telemetryMessage: Record<string, any>

    constructor(options: AudioWorkletNodeOptions) {
      super()
      const config = options.processorOptions as Record<string, number> | undefined
      this.targetSampleRate = Math.max(8_000, Math.round(Number(config?.targetSampleRate) || 16_000))
      this.frameMs = Math.max(10, Math.round(Number(config?.frameMs) || 20))
      this.frameSamples = Math.max(1, Math.round(this.targetSampleRate * this.frameMs / 1000))
      this.preRollFrames = Math.max(1, Math.round((Number(config?.preRollMs) || 160) / this.frameMs))
      this.hangoverFrames = Math.max(1, Math.round((Number(config?.hangoverMs) || 160) / this.frameMs))
      this.speechMarginDb = Math.max(3, Number(config?.speechMarginDb) || 10)
      this.absoluteThresholdDbfs = Math.max(-70, Math.min(-35, Number(config?.absoluteThresholdDbfs) || -55))

      this.slotFrames = []
      this.freeSlots = new Int16Array(this.slotCount)
      this.frameMessages = []
      this.frameTransfers = []
      for (let index = 0; index < this.slotCount; index += 1) {
        const frame = new Int16Array(this.frameSamples)
        this.slotFrames.push(frame)
        this.freeSlots[index] = index
        this.frameMessages.push({
          type: 'audio',
          slotId: index,
          sequence: 0,
          captureTimestampMs: 0,
          dbfs: -120,
          samples: frame,
        })
        this.frameTransfers.push([frame.buffer])
      }
      this.freeSlotCount = this.slotCount

      this.preRollSlots = new Int16Array(this.preRollFrames)
      this.preRollSlots.fill(-1)
      this.preRollSequences = new Float64Array(this.preRollFrames)
      this.preRollDbfs = new Float32Array(this.preRollFrames)
      this.telemetryFrameCountdown = Math.max(1, Math.round(5000 / this.frameMs))
      this.telemetryMessage = {
        type: 'stats',
        capturedFrames: 0,
        sentFrames: 0,
        suppressedFrames: 0,
        droppedFrames: 0,
        noiseFloorDbfs: -70,
        openThresholdDbfs: -55,
        speaking: false,
      }

      this.port.onmessage = (event: MessageEvent) => {
        const data = event.data as Record<string, any> | undefined
        if (!data) return
        if (data.type === 'recycle') {
          const slotId = Number(data.slotId)
          if (!Number.isInteger(slotId) || slotId < 0 || slotId >= this.slotCount || !data.samples) return
          if (this.slotFrames[slotId] !== null || this.freeSlotCount >= this.slotCount) return
          this.slotFrames[slotId] = data.samples as Int16Array
          this.freeSlots[this.freeSlotCount] = slotId
          this.freeSlotCount += 1
          return
        }
        if (data.type === 'destroy') this.destroyed = true
      }
    }

    acquireSlot() {
      if (this.freeSlotCount <= 0) return -1
      this.freeSlotCount -= 1
      return this.freeSlots[this.freeSlotCount]
    }

    releaseLocalSlot(slotId: number) {
      if (slotId < 0 || slotId >= this.slotCount || !this.slotFrames[slotId]) return
      if (this.freeSlotCount >= this.slotCount) return
      this.freeSlots[this.freeSlotCount] = slotId
      this.freeSlotCount += 1
    }

    sendSlot(slotId: number, sequence: number, dbfs: number) {
      const frame = slotId >= 0 ? this.slotFrames[slotId] : null
      if (!frame) {
        this.droppedFrames += 1
        return
      }
      const message = this.frameMessages[slotId]
      const transfer = this.frameTransfers[slotId]
      message.sequence = sequence
      message.captureTimestampMs = sequence * this.frameMs
      message.dbfs = dbfs
      message.samples = frame
      transfer[0] = frame.buffer as ArrayBuffer
      this.slotFrames[slotId] = null
      this.sentFrames += 1
      try {
        this.port.postMessage(message, transfer)
      } catch {
        this.slotFrames[slotId] = frame
        this.releaseLocalSlot(slotId)
        this.sentFrames -= 1
        this.droppedFrames += 1
      }
    }

    pushPreRoll(slotId: number, sequence: number, dbfs: number) {
      if (slotId < 0) return
      if (this.preRollCount >= this.preRollFrames) {
        const oldestSlot = this.preRollSlots[this.preRollWrite]
        this.releaseLocalSlot(oldestSlot)
        this.preRollCount -= 1
      }
      this.preRollSlots[this.preRollWrite] = slotId
      this.preRollSequences[this.preRollWrite] = sequence
      this.preRollDbfs[this.preRollWrite] = dbfs
      this.preRollWrite = (this.preRollWrite + 1) % this.preRollFrames
      this.preRollCount += 1
    }

    flushPreRoll() {
      let readIndex = (this.preRollWrite - this.preRollCount + this.preRollFrames) % this.preRollFrames
      for (let count = 0; count < this.preRollCount; count += 1) {
        const slotId = this.preRollSlots[readIndex]
        this.sendSlot(slotId, this.preRollSequences[readIndex], this.preRollDbfs[readIndex])
        this.preRollSlots[readIndex] = -1
        readIndex = (readIndex + 1) % this.preRollFrames
      }
      this.preRollCount = 0
    }

    calculateOpenThreshold() {
      return Math.min(-35, Math.max(this.absoluteThresholdDbfs, this.noiseFloorDbfs + this.speechMarginDb))
    }

    finishFrame() {
      const slotId = this.currentSlot
      const sequence = this.sequence
      const rms = Math.sqrt(this.currentEnergy / this.frameSamples)
      const dbfs = rms > 0.000001 ? 20 * Math.log10(rms) : -120
      this.capturedFrames += 1
      this.sequence += 1
      this.currentSlot = -1
      this.currentOffset = 0
      this.currentEnergy = 0

      const openThreshold = this.calculateOpenThreshold()
      this.openThresholdDbfs = openThreshold
      const closeThreshold = openThreshold - this.closeHysteresisDb

      if (!this.speaking) {
        this.pushPreRoll(slotId, sequence, dbfs)
        if (dbfs >= openThreshold) {
          this.attackCount += 1
        } else {
          this.attackCount = 0
          const boundedDbfs = Math.max(-100, Math.min(-30, dbfs))
          this.noiseFloorDbfs = this.noiseFloorDbfs * 0.98 + boundedDbfs * 0.02
        }

        if (this.attackCount >= this.attackFrames) {
          this.speaking = true
          this.attackCount = 0
          this.hangoverRemaining = this.hangoverFrames
          this.port.postMessage(this.speechStartMessage)
          this.flushPreRoll()
        } else {
          this.suppressedFrames += 1
        }
      } else {
        this.sendSlot(slotId, sequence, dbfs)
        if (dbfs >= closeThreshold) this.hangoverRemaining = this.hangoverFrames
        else this.hangoverRemaining -= 1

        if (this.hangoverRemaining <= 0) {
          this.speaking = false
          this.hangoverRemaining = 0
          this.port.postMessage(this.speechEndMessage)
        }
      }

      this.telemetryFrameCountdown -= 1
      if (this.telemetryFrameCountdown <= 0) {
        this.telemetryFrameCountdown += Math.max(1, Math.round(5000 / this.frameMs))
        const message = this.telemetryMessage
        message.capturedFrames = this.capturedFrames
        message.sentFrames = this.sentFrames
        message.suppressedFrames = this.suppressedFrames
        message.droppedFrames = this.droppedFrames
        message.noiseFloorDbfs = this.noiseFloorDbfs
        message.openThresholdDbfs = this.openThresholdDbfs
        message.speaking = this.speaking
        this.port.postMessage(message)
      }
    }

    writeTargetSample(sample: number) {
      if (this.currentOffset === 0) this.currentSlot = this.acquireSlot()
      const bounded = Math.max(-1, Math.min(1, sample))
      if (this.currentSlot >= 0) {
        const frame = this.slotFrames[this.currentSlot]
        if (frame) frame[this.currentOffset] = bounded < 0 ? bounded * 32768 : bounded * 32767
      }
      this.currentEnergy += bounded * bounded
      this.currentOffset += 1
      if (this.currentOffset >= this.frameSamples) this.finishFrame()
    }

    process(inputs: Float32Array[][]) {
      if (this.destroyed) return false
      const input = inputs[0]
      const inputLength = input?.[0]?.length || 0
      for (let index = 0; index < inputLength; index += 1) {
        let mono = 0
        if (input?.length) {
          for (let channel = 0; channel < input.length; channel += 1) mono += input[channel]?.[index] || 0
          mono /= input.length
        }
        this.resampleSum += mono
        this.resampleCount += 1
        this.resamplePhase += this.targetSampleRate
        if (this.resamplePhase >= sampleRate) {
          this.resamplePhase -= sampleRate
          this.writeTargetSample(this.resampleSum / this.resampleCount)
          this.resampleSum = 0
          this.resampleCount = 0
        }
      }
      return true
    }
  }

  registerProcessor('meetbridge-deepgram-vad-pcm', MeetBridgeDeepgramVadProcessor)
}

export async function createDeepgramVadPcmStream(
  options: DeepgramVadPcmStreamOptions,
): Promise<DeepgramVadPcmStream> {
  if (typeof window === 'undefined'
    || typeof AudioContext === 'undefined'
    || typeof AudioWorkletNode === 'undefined'
    || typeof Blob === 'undefined'
    || typeof URL === 'undefined') {
    throw new Error('Deepgram speech-gated PCM requires AudioWorklet support')
  }
  if (!options.track || options.track.readyState !== 'live') {
    throw new Error('Deepgram speech-gated PCM requires a live microphone track')
  }

  const preRollMs = Math.round(clampNumber(options.preRollMs, 160, 80, 400))
  const hangoverMs = Math.round(clampNumber(options.hangoverMs, 160, 120, 400))
  const clone = options.track.clone()
  clone.enabled = true
  const context = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' })
  const moduleSource = sourceFromBootstrap(deepgramVadWorkletBootstrap)
  const moduleUrl = URL.createObjectURL(new Blob([moduleSource], { type: 'text/javascript' }))
  try {
    await context.audioWorklet.addModule(moduleUrl)
  } catch (error) {
    clone.stop()
    void context.close()
    throw error
  } finally {
    URL.revokeObjectURL(moduleUrl)
  }

  const node = new AudioWorkletNode(context, PROCESSOR_NAME, {
    channelCount: 1,
    channelCountMode: 'explicit',
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: {
      targetSampleRate: DEEPGRAM_PCM_SAMPLE_RATE,
      frameMs: DEEPGRAM_PCM_FRAME_MS,
      preRollMs,
      hangoverMs,
      absoluteThresholdDbfs: clampNumber(options.absoluteThresholdDbfs, -55, -70, -35),
      speechMarginDb: clampNumber(options.speechMarginDb, 10, 3, 20),
    },
  })
  const source = context.createMediaStreamSource(new MediaStream([clone]))
  const silentSink = context.createGain()
  silentSink.gain.value = 0

  const stats: DeepgramVadStats = {
    capturedFrames: 0,
    sentFrames: 0,
    suppressedFrames: 0,
    droppedFrames: 0,
    noiseFloorDbfs: -70,
    openThresholdDbfs: -55,
    speaking: false,
  }
  let stopped = false
  const recycleMessages = Array.from({ length: FRAME_POOL_SIZE }, (_, slotId) => ({
    type: 'recycle',
    slotId,
    samples: null as Int16Array | null,
  }))
  const recycleTransfers = Array.from({ length: FRAME_POOL_SIZE }, () => [] as ArrayBuffer[])

  node.port.onmessage = (event: MessageEvent) => {
    if (stopped) return
    const data = event.data as Record<string, any> | undefined
    if (!data) return
    if (data.type === 'audio' && data.samples) {
      const slotId = Number(data.slotId)
      const samples = data.samples as Int16Array
      try {
        options.onAudioFrame(
          samples.buffer as ArrayBuffer,
          Number(data.sequence || 0),
          Number(data.captureTimestampMs || 0),
          Number(data.dbfs || -120),
        )
      } catch (error) {
        options.onError?.(error instanceof Error ? error : new Error(String(error)))
      } finally {
        if (!stopped && slotId >= 0 && slotId < recycleMessages.length) {
          const message = recycleMessages[slotId]
          const transfer = recycleTransfers[slotId]
          message.samples = samples
          transfer[0] = samples.buffer as ArrayBuffer
          node.port.postMessage(message, transfer)
        }
      }
      return
    }
    if (data.type === 'speech-state') {
      stats.speaking = data.speaking === true
      options.onSpeechState?.(stats.speaking)
      return
    }
    if (data.type === 'stats') {
      stats.capturedFrames = Number(data.capturedFrames || 0)
      stats.sentFrames = Number(data.sentFrames || 0)
      stats.suppressedFrames = Number(data.suppressedFrames || 0)
      stats.droppedFrames = Number(data.droppedFrames || 0)
      stats.noiseFloorDbfs = Number(data.noiseFloorDbfs || -70)
      stats.openThresholdDbfs = Number(data.openThresholdDbfs || -55)
      stats.speaking = data.speaking === true
      options.onStats?.({ ...stats })
    }
  }
  node.onprocessorerror = () => {
    options.onError?.(new Error('Deepgram speech-gated PCM AudioWorklet failed'))
  }
  clone.onended = () => {
    if (!stopped) options.onError?.(new Error('Deepgram speech-gated microphone track ended'))
  }

  try {
    source.connect(node)
    node.connect(silentSink)
    silentSink.connect(context.destination)
    if (context.state === 'suspended') await context.resume()
  } catch (error) {
    stopped = true
    try { source.disconnect() } catch { /* no-op */ }
    try { node.disconnect() } catch { /* no-op */ }
    try { silentSink.disconnect() } catch { /* no-op */ }
    clone.stop()
    void context.close()
    throw error
  }

  console.info('[MeetBridge Deepgram VAD] ACTIVE: 20 ms speech-gated linear16 PCM is ready.', {
    sampleRate: DEEPGRAM_PCM_SAMPLE_RATE,
    preRollMs,
    hangoverMs,
  })

  return {
    encoding: 'linear16',
    sampleRate: DEEPGRAM_PCM_SAMPLE_RATE,
    channels: 1,
    getStats() {
      return { ...stats }
    },
    stop() {
      if (stopped) return
      stopped = true
      node.port.postMessage({ type: 'destroy' })
      node.port.onmessage = null
      node.onprocessorerror = null
      source.disconnect()
      node.disconnect()
      silentSink.disconnect()
      clone.onended = null
      clone.stop()
      void context.close()
    },
  }
}
