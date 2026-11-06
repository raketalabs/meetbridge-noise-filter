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
- Its options include enabled, suppressionLevel, postFilter, and
  pauseSuppression. Both enhancement flags default to true and can be disabled
  independently. As with enabled/strength, the latest lease configuration
  applies to the shared processor.
- A lease supports setEnabled, setSuppressionLevel, getStats, release, and
  destroy.
- addNoiseFilterEventListener listens for overload.
- isNoiseFilterFeatureEnabled accepts the MEETBRIDGE_NOISE_FILTER value.

The native hook is global to the LiveKit WebRTC factory. The app must not attach
it to render processing. If the active SDK cannot identify a source track, do
not use the processor while capture sources that must remain unfiltered share
the same factory.

The native processor uses the same sustained-overload guard as the Web worker:
after 100 guard frames it enters a bounded raw bypass only for either eight
consecutive frames above 9.5 ms or 50 rolling-average frames above 8 ms. It
retries automatically after 100 raw frames and 20 model warmup frames. A
disabled-to-enabled transition also uses the 20-frame warmup, and releasing the
last native lease causes recurrent model state to be discarded before the next
capture attaches. While attached, the processor maintains a preallocated
30 ms raw timeline, including during manual bypass and suppression level zero.
The first three capture hops prime that timeline with silence. Filtered/raw
transitions use a 10 ms raised-cosine crossfade between aligned frames. Recovery
warms the model before fading back in. Unsupported capture formats pass through
unchanged and reset the history before supported processing resumes.
Android preserves the published JNI ABI and both wrappers avoid new per-frame
buffer allocations.
On iOS, WebRTC exposes `RTCAudioBuffer` channels as float values in the S16
range. The processor normalizes those samples before DeepFilterNet3 inference
and scales the clamped model output back to S16 so LiveKit and PCM taps receive
the same level as Android and Web.

## Gentle residual suppression

The wrappers implement the same conservative broadband residual post-filter
and soft pause suppression as the web Worker. They use the existing model and
core binaries; the core's spectral post-filter is not enabled. Android's
committed JNI interface does not expose that spectral setting.

Attenuation starts only after 250 ms of filtered audio with RMS at most
-50 dBFS, peak at most -38 dBFS, and at least 12 dB of suppression relative to
the raw audio from the same point in time. The post-filter removes up to 1 dB.
Pause suppression starts below -58 dBFS and removes up to another 3 dB.
Closing uses a 150 ms time constant with gain interpolation within each hop.
The combined reduction is capped at 4 dB and never hard-mutes audio. Any frame
outside those conditions receives unity gain throughout and restarts the hold.
This energy heuristic is deliberately conservative; it is not a speech
classifier. Bypass, warmup, discontinuities, and configuration changes reset it.

Set postFilter: false and pauseSuppression: false when acquiring a lease to
use only model output. These native wrapper changes take effect in a new
application binary; a JS-only update remains compatible with an older native
module but cannot add the new audio behavior to it. Consuming applications
continue linking the prebuilt core and do not compile Rust.

## Native package contents

Published builds include the Android arm64-v8a, armeabi-v7a, and x86_64
libraries, a 16 KB-page compatible JNI wrapper, the iOS device and simulator
XCFramework slices, and the DFN3 model. These prebuilt artifacts are staged in
this checkout; consuming applications do not need Rust, cargo-ndk, or CMake.
Before packaging, `prepack` copies the model into the iOS pod source root;
CocoaPods then places it in `MeetbridgeNoiseFilterResources.bundle`. The native
runtime resolves that bundle whether static framework integration exposes it
through the module bundle or the application main bundle.
The JS layer logs `NATIVE READY`, `NATIVE ACTIVE`, `NATIVE BYPASS`, and
`NATIVE DETACHED` so a custom dev client exposes the actual processor state.
