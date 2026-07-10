# MeetBridge Noise Filter

Private, versioned DeepFilterNet3 integration packages for MeetBridge Web,
Electron, Android, and iOS. Release `0.2.0` uses DeepFilterNet3 at 48 kHz with
tract `0.23.3`.

The repository contains both the source needed to maintain the integration and
the prebuilt binaries consumed by applications. Installing a released package
does **not** build Rust and does not require Cargo, wasm-pack, cargo-ndk, CMake,
or Xcode. Rebuilding the core is necessary only when DeepFilterNet/tract, Rust
FFI code, compiler settings, or a native target changes.

## Packages

- `@raketalabs/meetbridge-noise-filter-web`: browser and Electron processor,
  bundled JS/types, WASM, and the DeepFilterNet3 model.
- `@raketalabs/meetbridge-noise-filter-react-native`: Expo config plugin,
  Android JNI/shared libraries, iOS XCFramework, model, and TypeScript API.

MeetBridge applications can keep their existing import names by installing
these through npm aliases. See
[`docs/INSTALL_IN_MEETBRIDGE_BRANCH.md`](docs/INSTALL_IN_MEETBRIDGE_BRANCH.md).

## Runtime design

Web/Electron keeps model inference in a dedicated Worker. An AudioWorklet and
that Worker exchange preallocated 10 ms/480-sample frames through a direct
transferable MessageChannel; the main thread handles only lifecycle and
rate-limited telemetry. Monotonic sequence numbers, bounded two-to-four-hop
transport profiles, stale-result rejection, time-aligned raw fallback, and a
10 ms raised-cosine crossfade preserve continuity without blocking the audio
render thread.

The default `low` profile uses two transport hops. Including DeepFilterNet3's
three-hop model/STFT delay, its estimated algorithmic latency is 50 ms.
`balanced` is 60 ms and `resilient` is 70 ms.

Native uses LiveKit capture post-processing and ships ready-to-link Android and
iOS artifacts. The processed capture track remains the track published to
LiveKit and therefore the source used by the Deepgram STT tap.

## Repository map

- `packages/noise-filter-web`: publishable Web/Electron package.
- `packages/noise-filter-react-native`: publishable Expo native package.
- `packages/core-build`: offline maintenance-only core build scripts.
- `artifacts`: committed platform build outputs.
- `vendor/deepfilternet`: committed DeepFilterNet3-compatible core and model.
- `vendor/cargo`: committed Cargo source vendor tree for offline maintenance.
- `docs/RELEASING.md`: release and rare core-rebuild procedure.

No application should depend directly on `packages/core-build`, `vendor`, or
`artifacts`; those directories make the release reproducible and protect the
project if an upstream repository disappears.

Large prebuilt libraries and model/WASM files are stored with Git LFS. GitHub
Packages consumers receive normal package contents; only maintainers cloning
this source repository need Git LFS installed.
