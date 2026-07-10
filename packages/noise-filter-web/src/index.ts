import type { AudioCaptureOptions } from 'livekit-client'
import {
  canUseDeepFilterRuntime,
  controlDeepFilterRuntimeNode,
  createDeepFilterRuntimeNode,
  DEEP_FILTER_HOP_SIZE,
  DEEP_FILTER_SAMPLE_RATE,
  deepFilterTransportHops,
  preflightDeepFilterRuntime,
  resolveDeepFilterLatencyMode,
  type DeepFilterLatencyMode,
  type DeepFilterRuntimeEvent,
} from './runtime'

export {
  createDeepgramVadPcmStream,
  DEEPGRAM_PCM_FRAME_MS,
  DEEPGRAM_PCM_SAMPLE_RATE,
} from './deepgram-vad'
export type {
  DeepgramVadPcmStream,
  DeepgramVadPcmStreamOptions,
  DeepgramVadStats,
} from './deepgram-vad'

export type DeepFilterEventName = 'overload' | 'ready' | 'error'

export interface DeepFilterStats {
  processedFrames: number
  lateFrames: number
  avgFrameTimeMs: number
  p95FrameTimeMs: number
  algorithmicLatencyMs: number
  droppedFrames: number
  underruns: number
  queueDepth: number
  maxQueueDepth: number
}

export interface DeepFilterProcessorOptions {
  suppressionLevel?: number
  enabled?: boolean
  assetBaseUrl?: string
  latencyMode?: DeepFilterLatencyMode
}

export type CreateNoiseFilterNodeOptions = DeepFilterProcessorOptions

export const recommendedAudioCaptureOptions: AudioCaptureOptions = {
  echoCancellation: true,
  autoGainControl: true,
  noiseSuppression: false,
  voiceIsolation: false,
  channelCount: { ideal: 1 },
  sampleRate: { ideal: DEEP_FILTER_SAMPLE_RATE },
}

export const fallbackAudioCaptureOptions: AudioCaptureOptions = {
  echoCancellation: true,
  autoGainControl: true,
  noiseSuppression: true,
  voiceIsolation: true,
  channelCount: { ideal: 1 },
  sampleRate: { ideal: DEEP_FILTER_SAMPLE_RATE },
}

export function isNoiseFilterFeatureEnabled(value?: string | boolean) {
  if (typeof value === 'boolean') return value
  return String(value || '').trim().toLowerCase() !== 'off'
}

export async function prepareDeepFilter(options: Pick<DeepFilterProcessorOptions, 'assetBaseUrl'> = {}) {
  return preflightDeepFilterRuntime(options.assetBaseUrl)
}

function clampLevel(value: number | undefined) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 70
  return Math.max(0, Math.min(100, Math.round(numeric)))
}

function warnOnce(message: string) {
  const key = '__meetbridgeDeepFilterWarningShown'
  const target = globalThis as typeof globalThis & { [key]?: boolean }
  if (target[key]) return
  target[key] = true
  console.warn(message)
}

export class DeepFilterProcessor extends EventTarget {
  readonly name = 'meetbridge-deepfilternet3'
  processedTrack?: MediaStreamTrack

  private sourceNode: MediaStreamAudioSourceNode | null = null
  private runtimeNode: AudioWorkletNode | null = null
  private destinationNode: MediaStreamAudioDestinationNode | null = null
  private destroyed = false
  private enabled: boolean
  private suppressionLevel: number
  private readonly assetBaseUrl?: string
  private readonly latencyMode: DeepFilterLatencyMode
  private stats: DeepFilterStats = {
    processedFrames: 0,
    lateFrames: 0,
    avgFrameTimeMs: 0,
    p95FrameTimeMs: 0,
    // Updated in the constructor from the selected bounded transport profile
    // plus DF3's one-hop STFT delay and two-hop model lookahead.
    algorithmicLatencyMs: 50,
    droppedFrames: 0,
    underruns: 0,
    queueDepth: 0,
    maxQueueDepth: 0,
  }

  constructor(options: DeepFilterProcessorOptions = {}) {
    super()
    this.enabled = options.enabled !== false
    this.suppressionLevel = clampLevel(options.suppressionLevel)
    this.assetBaseUrl = options.assetBaseUrl
    this.latencyMode = resolveDeepFilterLatencyMode(options.latencyMode)
    this.stats.algorithmicLatencyMs = (deepFilterTransportHops(this.latencyMode) + 3) * 10
  }

  static isSupported() {
    return canUseDeepFilterRuntime()
  }

  async init(options: { track: MediaStreamTrack, audioContext: AudioContext }) {
    await this.connect(options)
  }

  async restart(options: { track: MediaStreamTrack, audioContext: AudioContext }) {
    await this.disconnectGraph()
    await this.connect(options)
  }

  setSuppressionLevel(level: number) {
    this.suppressionLevel = clampLevel(level)
    if (this.runtimeNode) controlDeepFilterRuntimeNode(this.runtimeNode)?.setSuppressionLevel(this.suppressionLevel)
  }

  setEnabled(enabled: boolean) {
    const nextEnabled = Boolean(enabled)
    if (this.enabled === nextEnabled) return
    this.enabled = nextEnabled
    if (this.runtimeNode) controlDeepFilterRuntimeNode(this.runtimeNode)?.setEnabled(this.enabled)
    console.info('[MeetBridge DeepFilterNet3] ' + (this.enabled ? 'ENABLED: processor will filter microphone audio.' : 'BYPASS: processor was disabled by the user.'))
  }

  getStats(): DeepFilterStats {
    return { ...this.stats }
  }

  async destroy() {
    if (this.destroyed) return
    this.destroyed = true
    await this.disconnectGraph()
  }

  private async connect(options: { track: MediaStreamTrack, audioContext: AudioContext }) {
    if (this.destroyed) return
    if (!DeepFilterProcessor.isSupported()) {
      const error = new Error('DeepFilterNet3 requires AudioWorklet and WebAssembly support')
      warnOnce('[MeetBridge DeepFilterNet3] AudioWorklet or WebAssembly is unavailable. Audio will use the browser fallback.')
      this.dispatchEvent(new CustomEvent('error', { detail: error }))
      throw error
    }
    const settings = options.track.getSettings?.() as (MediaTrackSettings & { voiceIsolation?: boolean }) | undefined
    if (settings?.noiseSuppression === true || settings?.voiceIsolation === true) {
      console.warn(
        '[MeetBridge DeepFilterNet3] Browser noise suppression or voice isolation is enabled. ' +
        'Use recommendedAudioCaptureOptions to prevent double suppression and speech distortion.',
      )
    }
    try {
      this.sourceNode = options.audioContext.createMediaStreamSource(new MediaStream([options.track]))
      this.destinationNode = options.audioContext.createMediaStreamDestination()
      this.runtimeNode = await createDeepFilterRuntimeNode(options.audioContext, {
        enabled: this.enabled,
        suppressionLevel: this.suppressionLevel,
        assetBaseUrl: this.assetBaseUrl,
        latencyMode: this.latencyMode,
        onEvent: event => this.handleRuntimeEvent(event),
      })
      this.sourceNode.connect(this.runtimeNode)
      this.runtimeNode.connect(this.destinationNode)
      await controlDeepFilterRuntimeNode(this.runtimeNode)?.waitUntilPrimed()
      this.processedTrack = this.destinationNode.stream.getAudioTracks()[0]
      console.info('[MeetBridge DeepFilterNet3] TRACK ATTACHED: processed microphone track is ready for LiveKit publication.', {
        sourceTrackId: options.track.id,
        sampleRate: options.audioContext.sampleRate,
        latencyMode: this.latencyMode,
        algorithmicLatencyMs: this.stats.algorithmicLatencyMs,
      })
    } catch (error) {
      await this.disconnectGraph()
      const normalized = error instanceof Error ? error : new Error(String(error))
      this.dispatchEvent(new CustomEvent('error', { detail: normalized }))
      throw normalized
    }
  }

  private handleRuntimeEvent(event: DeepFilterRuntimeEvent) {
    if (event.type === 'ready') {
      this.dispatchEvent(new Event('ready'))
      return
    }
    if (event.type === 'overload') {
      this.stats.avgFrameTimeMs = event.avgFrameTimeMs
      this.dispatchEvent(new CustomEvent('overload', { detail: this.getStats() }))
      return
    }
    if (event.type === 'stats') {
      this.stats.processedFrames = event.processedFrames
      this.stats.lateFrames = event.lateFrames
      this.stats.avgFrameTimeMs = event.avgFrameTimeMs || this.stats.avgFrameTimeMs
      this.stats.p95FrameTimeMs = event.p95FrameTimeMs || this.stats.p95FrameTimeMs
      this.stats.droppedFrames = event.droppedFrames
      this.stats.underruns = event.underruns
      this.stats.queueDepth = event.queueDepth
      this.stats.maxQueueDepth = event.maxQueueDepth
      return
    }
    this.dispatchEvent(new CustomEvent('error', { detail: event.error }))
  }

  private async disconnectGraph() {
    const runtime = this.runtimeNode
    this.sourceNode?.disconnect()
    runtime?.disconnect()
    this.destinationNode?.disconnect()
    if (runtime) controlDeepFilterRuntimeNode(runtime)?.destroy()
    this.sourceNode = null
    this.runtimeNode = null
    this.destinationNode = null
    this.processedTrack = undefined
  }
}

export async function createNoiseFilterNode(
  audioContext: AudioContext,
  options: CreateNoiseFilterNodeOptions = {},
) {
  return createDeepFilterRuntimeNode(audioContext, {
    ...options,
    suppressionLevel: clampLevel(options.suppressionLevel),
  })
}

export function destroyNoiseFilterNode(node: AudioWorkletNode) {
  controlDeepFilterRuntimeNode(node)?.destroy()
}

export {
  DEEP_FILTER_HOP_SIZE,
  DEEP_FILTER_SAMPLE_RATE,
  deepFilterTransportHops,
  resolveDeepFilterLatencyMode,
}
export type { DeepFilterLatencyMode }
