# MeetBridge DeepFilterNet3 React Native package

Published privately as `@raketalabs/meetbridge-noise-filter-react-native`.
MeetBridge applications install it through the
`@meetbridge/noise-filter-react-native` npm alias so JavaScript imports and the
Expo config-plugin name remain stable. See the repository's branch migration
guide for the exact package and Metro changes.

This Expo module attaches one DeepFilterNet3 processor at LiveKit capture
post-processing. It runs after the platform AEC and AGC stage and before the
microphone enters LiveKit encoding. It does not process render audio.

Expo Go is not supported. Use an Expo development build or EAS build so the
native module, model, Android shared libraries, and iOS XCFramework are linked.

## Capture invariant

When a native lease is available, use recommendedAudioCaptureOptions:

~~~ts
import {
  acquireNoiseFilterLease,
  getNoiseFilterAvailability,
  recommendedAudioCaptureOptions,
} from '@meetbridge/noise-filter-react-native'

const availability = await getNoiseFilterAvailability()
if (availability.supported) {
  const lease = await acquireNoiseFilterLease({ enabled: true })
  await room.localParticipant.setMicrophoneEnabled(true, recommendedAudioCaptureOptions)

  // Later, after microphone unpublish or room leave:
  await room.localParticipant.setMicrophoneEnabled(false)
  await lease.release()
}
~~~

The options keep echoCancellation and autoGainControl on, and turn
noiseSuppression and voiceIsolation off. The Expo config plugin also disables
the Android LiveKit hardware NoiseSuppressor while retaining hardware AEC.

## API

- getNoiseFilterAvailability returns native support and a human-readable reason.
- acquireNoiseFilterLease adds a reference-counted global capture processor.
- A lease supports setEnabled, setSuppressionLevel, getStats, release, and
  destroy.
- addNoiseFilterEventListener listens for overload.
- isNoiseFilterFeatureEnabled accepts the MEETBRIDGE_NOISE_FILTER value.

The native hook is global to the LiveKit WebRTC factory. The app must not attach
it to render processing. If the active SDK cannot identify a source track, do
not use the processor while capture sources that must remain unfiltered share
the same factory.

## Native package contents

Published builds include the Android arm64-v8a, armeabi-v7a, and x86_64
libraries, a 16 KB-page compatible JNI wrapper, the iOS device and simulator
XCFramework slices, and the DFN3 model. These prebuilt artifacts are staged in
this checkout; consuming applications do not need Rust, cargo-ndk, or CMake.
The JS layer logs `NATIVE READY`, `NATIVE ACTIVE`, `NATIVE BYPASS`, and
`NATIVE DETACHED` so a custom dev client exposes the actual processor state.
