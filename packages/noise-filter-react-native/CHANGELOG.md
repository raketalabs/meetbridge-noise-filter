# Changelog

All notable changes to this package are documented in this file.

## Unreleased

### Fixed

- Stage the DeepFilterNet3 model inside the iOS pod source root so CocoaPods
  includes it in `MeetbridgeNoiseFilterResources.bundle`, and resolve that
  resource bundle from both the module and application bundle at runtime.
- Normalize both iOS XCFramework slices to the `libdf.a` binary basename.
- Use CocoaPods-compatible metadata/xcconfig assignment, the current Swift
  `isEnabled` importer name, and portable C++17 `std::atomic<double>`.
- Match the Web worker's sustained-overload guard on iOS and Android, including
  bounded raw bypass, recovery warmup, manual re-enable warmup, and fresh state
  before the next capture instead of permanently disabling on one slow frame.
- Convert iOS WebRTC `RTCAudioBuffer` samples from its float S16 range to the
  normalized DeepFilterNet3 range before inference, then clamp and scale model
  output back to float S16 for LiveKit encoding and local PCM renderers.

## 0.2.1

### Fixed

- Serialize native lease acquisition, configuration, and release to avoid
  leaking the shared capture processor during concurrent operations.
- Apply suppression changes on the capture thread and guard Android state
  lifetime without blocking the audio callback.
- Release iOS model state on final detach and reduce per-sample bridge calls.
- Omit the redundant staging-only model copy from the npm tarball; retain
  models bundled for both Android and iOS and all prebuilt core artifacts.

## 0.2.0

### Changed

- Rebuilt the committed Android and iOS DeepFilterNet3 artifacts with tract
  0.23.3. Consuming applications still use the prebuilt binaries and do not
  require Rust, Cargo, cargo-ndk, or CMake.

## 0.1.0

### Added

- Initial Expo native module with reference-counted LiveKit capture post-process
  installation.
- Android hardware-noise-suppressor policy plugin, JNI bridge layout, and iOS
  capture delegate layout.
