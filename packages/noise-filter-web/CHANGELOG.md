# Changelog

All notable changes to this package are documented in this file.

## 0.2.0

### Changed

- Upgraded the committed DeepFilterNet3 core to tract 0.23.3.
- Added bounded low, balanced, and resilient latency profiles; low is the
  default with a two-hop transport buffer and approximately 50 ms total
  algorithmic delay.
- Kept inference off the AudioWorklet render thread and retained the direct
  transferable MessageChannel, monotonic sequencing, stale-result dropping,
  time-aligned raw fallback, and full-hop crossfade continuity path.

## 0.1.0

### Added

- Initial LiveKit TrackProcessor integration for DeepFilterNet3.
- Preflight-gated assets, AudioWorklet worker graph, fixed frame pool, runtime
  bypass, overload event, and capture-option export.
