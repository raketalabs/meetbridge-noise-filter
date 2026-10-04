<p align="center">
  <a href="https://meetbridge.co">
    <img src="https://img.meetbridge.co/meetbridge-logo.webp" alt="MeetBridge logo" width="88" height="88" />
  </a>
</p>

<h1 align="center">MeetBridge Noise Filter</h1>

<p align="center">Open-source noise suppression for real-time meeting audio.</p>

<p align="center">
  <a href="https://meetbridge.co">MeetBridge</a> ·
  <a href="#packages">Packages</a> ·
  <a href="#runtime-design">Architecture</a> ·
  <a href="#documentation">Documentation</a>
</p>

## Built for MeetBridge

**MeetBridge Noise Filter is a MeetBridge project, developed by RaketaLabs and used inside [MeetBridge](https://meetbridge.co).** It provides the DeepFilterNet3 integration for the meeting audio pipeline across Web, Electron, Android, and iOS.

MeetBridge brings live translation, transcripts, meeting summaries, booking, and meeting actions into one platform for multilingual teams. This repository makes its noise-filter integration publicly available for developers to explore, reuse, and contribute to under the project license.

Visit **[meetbridge.co](https://meetbridge.co)** to learn about MeetBridge and its multilingual meeting workflow.

## Overview

Versioned DeepFilterNet3 integration packages with source code, model assets, and prebuilt platform artifacts. Release `0.2.0` uses DeepFilterNet3 at 48 kHz with tract `0.23.3`.

The repository contains both the source needed to maintain the integration and the prebuilt binaries consumed by applications. Installing a released package does **not** build Rust and does not require Cargo, wasm-pack, cargo-ndk, CMake, or Xcode. Rebuilding the core is necessary only when DeepFilterNet/tract, Rust FFI code, compiler settings, or a native target changes.

## Packages

| Package | Platforms | Included |
| --- | --- | --- |
| `@raketalabs/meetbridge-noise-filter-web` | Web and Electron | Browser processor, bundled JavaScript and types, WASM, and the DeepFilterNet3 model |
| `@raketalabs/meetbridge-noise-filter-react-native` | Android and iOS | Expo config plugin, Android JNI/shared libraries, iOS XCFramework, model, and TypeScript API |

MeetBridge applications can keep their existing import names by installing these through npm aliases. See [`docs/INSTALL_IN_MEETBRIDGE_BRANCH.md`](docs/INSTALL_IN_MEETBRIDGE_BRANCH.md) for integration instructions. Consume version-pinned GitHub Packages releases and follow the registry access instructions in the documentation.

## Runtime design

### Web and Electron

Model inference runs in a dedicated Worker. An AudioWorklet and that Worker exchange preallocated 10 ms/480-sample frames through a direct transferable MessageChannel; the main thread handles only lifecycle and rate-limited telemetry.

Monotonic sequence numbers, bounded two-to-four-hop transport profiles, stale-result rejection, time-aligned raw fallback, and a 10 ms raised-cosine crossfade preserve continuity without blocking the audio render thread.

The default `low` profile uses two transport hops. Including DeepFilterNet3's three-hop model/STFT delay, the estimated algorithmic latency is:

| Transport profile | Estimated algorithmic latency |
| --- | --- |
| `low` (default) | 50 ms |
| `balanced` | 60 ms |
| `resilient` | 70 ms |

### Android and iOS

Native integration uses LiveKit capture post-processing and ships ready-to-link Android and iOS artifacts. The processed capture track remains the track published to LiveKit and therefore the source used by the Deepgram STT tap.

## Repository map

| Path | Purpose |
| --- | --- |
| `packages/noise-filter-web` | Publishable Web/Electron package |
| `packages/noise-filter-react-native` | Publishable Expo native package |
| `packages/core-build` | Offline maintenance-only core build scripts |
| `artifacts` | Committed platform build outputs |
| `vendor/deepfilternet` | Committed DeepFilterNet3-compatible core and model |
| `vendor/cargo` | Committed Cargo source vendor tree for offline maintenance |
| `docs/RELEASING.md` | Release and rare core-rebuild procedure |

Applications should consume the released packages. They should not depend directly on `packages/core-build`, `vendor`, or `artifacts`; those directories make releases reproducible and preserve the upstream sources needed for maintenance.

Large prebuilt libraries and model/WASM files are stored with Git LFS. GitHub Packages consumers receive normal package contents; maintainers cloning this source repository need Git LFS installed.

## Documentation

- [MeetBridge integration guide](docs/INSTALL_IN_MEETBRIDGE_BRANCH.md)
- [Release and core maintenance guide](docs/RELEASING.md)
- [Repository contribution instructions](AGENTS.md)

## Contributing

Bug reports, documentation improvements, and focused pull requests are welcome. Include the affected platform, package version, and steps to reproduce when reporting an issue. Read [AGENTS.md](AGENTS.md) before changing the integration, and preserve the 48 kHz, 480-sample/10 ms core contract and bounded queue semantics.

## License and acknowledgments

This project builds on DeepFilterNet3. The existing [LICENSE](LICENSE) specifies MIT OR Apache-2.0 terms for the vendored DeepFilterNet core. See [NOTICE](NOTICE) and the license files in `vendor/deepfilternet` for attribution and applicable terms.

---

Built by **RaketaLabs** for **[MeetBridge](https://meetbridge.co)**. Meet in every language.
