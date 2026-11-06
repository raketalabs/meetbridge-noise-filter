# Changelog

All notable changes to this package are documented in this file.

## 0.2.2

### Changed

- Add optional, default-on residual post-filter and soft pause suppression in
  the Worker, capped at 1 dB and 3 dB respectively, with time-aligned energy
  comparison, a 250 ms hold, gradual closing, and full-hop speech protection.
- Route suppression level zero through aligned raw playback and warm the core
  before re-enabling filtering, preserving the bounded audio timeline.
- Keep the direct Worklet/Worker channel, existing core/model assets, and
  published ESM/CommonJS entry points in sync without rebuilding the core.

## 0.2.1

### Fixed

- Make preflight manifest-only; download model/WASM once in the Worker and
  persist validated content-revision URLs in CacheStorage when available.
- Stage SHA-256 revisions and precompressed WASM/JS sidecars, preserving the
  model's original gzip bytes and retrying unavailable asset initialization.
- Admit complete capture hops independently of buffered results and decide
  fallback at the actual playback deadline; flush delayed output after gaps.
- Use the supported wasm-bindgen object initializer and warm the Worker
  before microphone publication. Keep inference off the render thread.
- Clean up cancelled/restarted processor graphs and destination tracks.
- Retain 48 kHz/480-sample core artifacts, bounded queues, and latency modes.

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
