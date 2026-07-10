# Architecture and latency choices

## Web and Electron frame flow

1. The microphone enters an `AudioWorklet` as mono audio at the browser's
   rendering quantum.
2. The worklet accumulates exactly 480 samples (10 ms at 48 kHz), assigns a
   monotonic sequence and capture timestamp, and transfers a pooled buffer to
   the Worker through a direct `MessageChannel` port.
3. The Worker runs the committed DeepFilterNet3/tract 0.23.3 WASM core. It
   never runs inference on the AudioWorklet render thread.
4. The worklet places only an on-time, matching result into its bounded result
   slots. A stale result is counted and discarded; it is never appended later.
5. Playback selects the filtered frame or the raw frame from the capture-time
   aligned delay ring. A 10 ms raised-cosine transition prevents a hard
   waveform step when the selected source changes.
6. The processed `MediaStreamTrack` is the track attached to and published by
   LiveKit. The Deepgram speech-gated PCM tap is downstream of this track.

The main thread installs the worklet, creates the Worker/ports, manages
lifecycle, and prints rate-limited telemetry. Audio frames do not relay through
it.

## Bounded latency profiles

| Profile | Transport hops | Estimated total algorithmic delay | Use |
| --- | ---: | ---: | --- |
| `low` | 2 | 50 ms | Default; current Web/Electron target |
| `balanced` | 3 | 60 ms | Slower clients with sustained underruns |
| `resilient` | 4 | 70 ms | Exceptional, persistently contended clients |

The additional 30 ms is the DeepFilterNet3 STFT/model lookahead. Queue depth
never expands to absorb CPU pressure. If inference misses its deadline, the
system drops that stale result and uses the corresponding delayed raw frame;
latency therefore stays fixed and speech is not replayed or reordered.

## Why this differs from AudioWorklet-only implementations

Some Web noise-filter integrations execute WASM inference directly in the
AudioWorklet. That removes a message hop, but a long inference blocks the audio
render deadline and can create a more severe glitch. MeetBridge keeps the
Worker boundary because observed inference time varies with CPU load. The
direct transferable port and two-hop default recover most of the transport
cost without putting the model on the real-time render thread.

## Native flow

Android and iOS attach one global, reference-counted processor to LiveKit's
capture post-processing hook. Platform echo cancellation and automatic gain
remain enabled; platform noise suppression/voice isolation remain disabled to
avoid running two suppressors. The prebuilt core and model are part of the npm
package and are linked into a custom Expo development or production build.
