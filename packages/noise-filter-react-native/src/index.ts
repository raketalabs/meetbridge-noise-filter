import type { AudioCaptureOptions } from 'livekit-client'
import { Platform } from 'react-native'
import { EventEmitter, requireNativeModule } from 'expo-modules-core'

export interface NoiseFilterStats {
  avgFrameTimeMs: number
  algorithmicLatencyMs: number
  droppedFrames: number
}

export interface NoiseFilterAvailability {
  supported: boolean
  reason?: string
}

export interface NoiseFilterLease {
  setEnabled(enabled: boolean): Promise<void>
  setSuppressionLevel(level: number): Promise<void>
  getStats(): Promise<NoiseFilterStats>
  release(): Promise<void>
  destroy(): Promise<void>
}

export interface NoiseFilterEventSubscription {
  remove(): void
}

export interface NoiseFilterOptions {
  enabled?: boolean
  suppressionLevel?: number
  /** Gentle residual-noise attenuation (up to 1 dB). Defaults to true. */
  postFilter?: boolean
  /** Soft attenuation during sustained quiet intervals (up to 3 dB). Defaults to true. */
  pauseSuppression?: boolean
}

interface NativeNoiseFilterModule {
  getAvailability(): Promise<NoiseFilterAvailability>
  acquire(options: Required<NoiseFilterOptions>): Promise<void>
  release(): Promise<void>
  setEnabled(enabled: boolean): Promise<void>
  setSuppressionLevel(level: number): Promise<void>
  // Optional so a JS update can still run against an older installed native module.
  setEnhancementOptions?(options: { postFilter: boolean, pauseSuppression: boolean }): Promise<void>
  getStats(): Promise<NoiseFilterStats>
}

export const recommendedAudioCaptureOptions: AudioCaptureOptions = {
  echoCancellation: true,
  autoGainControl: true,
  noiseSuppression: false,
  voiceIsolation: false,
  channelCount: { ideal: 1 },
  sampleRate: { ideal: 48_000 },
}

export const fallbackAudioCaptureOptions: AudioCaptureOptions = {
  echoCancellation: true,
  autoGainControl: true,
  noiseSuppression: true,
  voiceIsolation: true,
  channelCount: { ideal: 1 },
  sampleRate: { ideal: 48_000 },
}

let nativeModule: NativeNoiseFilterModule | null | undefined
let activeLeaseCount = 0
let lastAvailabilityLog = ''
let nativeOperation: Promise<unknown> = Promise.resolve()

// A first acquire and a last release must be atomic relative to other leases.
// Native calls yield to JS, so checking the count before awaiting is not enough.
function serializeNativeOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = nativeOperation.then(operation)
  nativeOperation = result.catch(() => undefined)
  return result
}

function logAvailability(availability: NoiseFilterAvailability) {
  const message = availability.supported
    ? '[MeetBridge DeepFilterNet3] NATIVE READY: model, core library, and LiveKit capture hook are available.'
    : `[MeetBridge DeepFilterNet3] NATIVE UNAVAILABLE: ${availability.reason || 'Unknown reason.'}`
  if (message === lastAvailabilityLog) return
  lastAvailabilityLog = message
  if (availability.supported) console.info(message, availability)
  else console.warn(message, availability)
}

function resolveNativeModule() {
  if (typeof nativeModule !== 'undefined') return nativeModule
  try {
    nativeModule = requireNativeModule<NativeNoiseFilterModule>('MeetbridgeNoiseFilter')
  } catch {
    nativeModule = null
  }
  return nativeModule
}

function clampLevel(value: number | undefined) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 80
  return Math.max(0, Math.min(100, Math.round(numeric)))
}

export function isNoiseFilterFeatureEnabled(value?: string | boolean) {
  if (typeof value === 'boolean') return value
  return String(value || '').trim().toLowerCase() !== 'off'
}

export async function getNoiseFilterAvailability(): Promise<NoiseFilterAvailability> {
  if (Platform.OS === 'web') {
    const availability = { supported: false, reason: 'The React Native noise filter requires an iOS or Android native build.' }
    logAvailability(availability)
    return availability
  }
  const native = resolveNativeModule()
  if (!native) {
    const availability = {
      supported: false,
      reason: 'DeepFilterNet3 is unavailable in Expo Go. Use an Expo development build or EAS build.',
    }
    logAvailability(availability)
    return availability
  }
  try {
    const availability = await native.getAvailability()
    logAvailability(availability)
    return availability
  } catch (error) {
    const availability = {
      supported: false,
      reason: error instanceof Error ? error.message : 'DeepFilterNet3 native module is unavailable.',
    }
    logAvailability(availability)
    return availability
  }
}

export async function acquireNoiseFilterLease(options: NoiseFilterOptions = {}): Promise<NoiseFilterLease> {
  const native = resolveNativeModule()
  const availability = await getNoiseFilterAvailability()
  if (!native || !availability.supported) {
    throw new Error(availability.reason || 'DeepFilterNet3 is unavailable.')
  }

  const enabled = options.enabled !== false
  const suppressionLevel = clampLevel(options.suppressionLevel)
  const postFilter = options.postFilter !== false
  const pauseSuppression = options.pauseSuppression !== false
  await serializeNativeOperation(async () => {
    if (activeLeaseCount === 0) {
      await native.acquire({ enabled, suppressionLevel, postFilter, pauseSuppression })
    } else {
      await native.setEnhancementOptions?.({ postFilter, pauseSuppression })
      await native.setEnabled(enabled)
      await native.setSuppressionLevel(suppressionLevel)
    }
    activeLeaseCount += 1
  })
  console.info('[MeetBridge DeepFilterNet3] NATIVE ACTIVE: LiveKit capture post-processing is filtering microphone audio.', {
    platform: Platform.OS,
    suppressionLevel,
    activeLeaseCount,
  })
  let released = false

  const release = () => serializeNativeOperation(async () => {
    if (released) return
    if (activeLeaseCount === 1) {
      await native.release()
      console.info('[MeetBridge DeepFilterNet3] NATIVE DETACHED: microphone capture post-processing was released.')
    }
    // Keep the lease retryable if native detachment fails.
    activeLeaseCount = Math.max(0, activeLeaseCount - 1)
    released = true
  })

  return {
    setEnabled(nextEnabled: boolean) {
      return serializeNativeOperation(async () => {
        if (!released) {
          const enabled = Boolean(nextEnabled)
          await native.setEnabled(enabled)
          console.info(`[MeetBridge DeepFilterNet3] NATIVE ${enabled ? 'ENABLED' : 'BYPASS'}: microphone processing state updated.`)
        }
      })
    },
    setSuppressionLevel(nextLevel: number) {
      return serializeNativeOperation(async () => {
        if (!released) await native.setSuppressionLevel(clampLevel(nextLevel))
      })
    },
    async getStats() {
      return native.getStats()
    },
    release,
    destroy: release,
  }
}

export function addNoiseFilterEventListener(
  event: 'overload',
  listener: (payload: { avgFrameTimeMs: number }) => void,
): NoiseFilterEventSubscription {
  const native = resolveNativeModule()
  if (!native) return { remove() {} }
  const emitter = new EventEmitter(native as never)
  return emitter.addListener(event, listener) as NoiseFilterEventSubscription
}
