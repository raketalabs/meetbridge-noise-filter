# MeetBridge DeepFilterNet3 web package

Published privately as `@raketalabs/meetbridge-noise-filter-web`. MeetBridge
applications install it through the `@meetbridge/noise-filter-web` npm alias so
existing imports remain stable. The exact branch migration is documented in
the repository's `docs/INSTALL_IN_MEETBRIDGE_BRANCH.md`.

The package processes local microphone audio in the browser or an Electron
renderer before LiveKit encodes it with Opus. It never changes remote, screen
share, music, or system-audio tracks.

## Capture invariant

When the processor is active, use recommendedAudioCaptureOptions. It keeps
echo cancellation and auto gain control on, while disabling browser noise
suppression and voice isolation. Running either browser suppressor alongside
DeepFilterNet3 distorts speech.

~~~ts
import {
  DeepFilterProcessor,
  prepareDeepFilter,
  recommendedAudioCaptureOptions,
} from '@meetbridge/noise-filter-web'
import { Track } from 'livekit-client'

const ready = await prepareDeepFilter()
if (ready) {
  const tracks = await room.localParticipant.createTracks({
    audio: recommendedAudioCaptureOptions,
  })
  const microphone = tracks.find(track => track.kind === Track.Kind.Audio)
  if (!microphone) throw new Error('Microphone track was not created')
  await microphone.setProcessor(new DeepFilterProcessor({ enabled: true }))
  await room.localParticipant.publishTrack(microphone, { source: Track.Source.Microphone })
} else {
  await room.localParticipant.setMicrophoneEnabled(true, {
    echoCancellation: true,
    autoGainControl: true,
    noiseSuppression: true,
    voiceIsolation: true,
  })
}
~~~

The preflight is intentionally before microphone publication. It prevents a
raw first packet and preserves a browser fallback if assets cannot load.

## API

- DeepFilterProcessor accepts suppressionLevel from 0 to 100, enabled, and a
  latencyMode of low, balanced, or resilient. The defaults are suppression 70
  and low latency. Use balanced only on devices that show sustained underruns.
- setSuppressionLevel changes attenuation without rebuilding the graph.
- setEnabled bypasses or reenables processing without rebuilding the graph;
  the audible transition is crossfaded.
- destroy frees the graph, worker, and worker-side WASM memory.
- getStats returns processed/late/dropped frame counts, underruns, current and
  maximum queue depth, worker average/p95 time, and estimated latency.
- DeepFilterProcessor.isSupported checks WebAssembly, Worker, and AudioWorklet
  capability.
- createNoiseFilterNode creates a framework-agnostic AudioWorkletNode.
- createDeepgramVadPcmStream creates the low-latency, silence-gated STT tap.
- prepareDeepFilter verifies the package assets before capture.

Events are ready, error, and overload. A sustained overload uses delayed raw
audio during a bounded cooldown, warms the model state, and crossfades back to
filtered output without blocking the audio thread.

## Signal path

The worklet receives a mono downmix and exchanges fixed 10 ms transferable
frames with the dedicated worker through a direct MessageChannel; audio frames
never pass through the main thread. Every frame has a monotonic sequence and
capture timestamp. Playback uses a bounded jitter timeline: two transport hops
in low mode, three in balanced mode, and four in resilient mode. In-flight and
playback backlog is capped at that selected depth and stale results are never
played later.

The raw ring spans the selected transport jitter plus DF3's inherent three-hop
delay (one STFT hop plus two model-lookahead hops). Result sequence N is paired
with raw sequence N - 3. If the filtered frame misses its playback deadline,
the worklet discards any late result and plays that time-aligned raw frame.
Filtered/raw transitions use a precomputed full-hop 10 ms raised-cosine
crossfade. The fallback leg preserves the raw waveform and fades only the
boundary correction; it does not recursively smear speech samples. After an
underrun, consecutive filtered hops are required before the filter fades back
in, preventing rapid raw/filtered flutter. The worker uses a preallocated
windowed-sinc destination when a non-48 kHz
AudioContext needs resampling; the 48 kHz path retains the native 480-sample
DeepFilterNet3 hop.

The estimated end-to-end algorithmic delay is 50 ms in low mode, 60 ms in
balanced mode, and 70 ms in resilient mode. Inference remains in the Worker;
the AudioWorklet render thread never waits for the model.

## Deepgram speech-gated PCM

createDeepgramVadPcmStream creates a separate STT-only tap from the processed
microphone track. It converts the track to mono 16 kHz linear16 frames in an
AudioWorklet and sends only speech-active 20 ms frames to its callback. The
default adaptive gate keeps 160 ms of pre-roll, uses a 20 ms attack, and sends
160 ms of trailing audio so Deepgram endpointing can observe the pause without
continuously receiving silence. This tap does not change the 48 kHz LiveKit
publication track.

The worklet keeps an adaptive noise-floor estimate and uses a fixed frame pool.
Silence remains in the pre-roll ring rather than crossing the main thread.
Transferred PCM buffers are recycled after the synchronous WebSocket send.

## Electron

Electron uses this package unchanged in the renderer. CSP must allow
worker-src blob: and script-src wasm-unsafe-eval. SharedArrayBuffer is optional;
without COOP and COEP the package uses the transferable-buffer path.

## Package assets

The published package contains deep_filter.js, deep_filter_bg.wasm, and the
DeepFilterNet3 model under dist/assets. assetBaseUrl may point to a CDN that
serves those exact files with CORS enabled.

This checkout includes the generated WASM/model assets. The repository staging
script copies them to `/deepfilternet/` for both Nuxt and Electron, where
prepareDeepFilter verifies the manifest and all three files before capture.
The renderer console reports `ASSETS READY`, `INITIALISING`, `ACTIVE`, and
`TRACK ATTACHED` only after each corresponding stage succeeds.
