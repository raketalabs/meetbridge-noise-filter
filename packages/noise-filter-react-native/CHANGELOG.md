# Changelog

All notable changes to this package are documented in this file.

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
