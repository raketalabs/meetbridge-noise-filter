# Repository instructions

- The publishable packages contain committed prebuilt WASM, Android, and iOS
  artifacts. Do not rebuild the core for ordinary TypeScript, Worker,
  AudioWorklet, documentation, Expo plugin, or wrapper changes.
- Run a core build only when the user explicitly requests it and the change
  affects DeepFilterNet/tract, Rust FFI, the model, target ABIs, or compiler
  settings.
- Do not run builds or tests unless the user explicitly authorizes them.
- Never replace the direct AudioWorklet-to-Worker MessageChannel with a
  main-thread frame relay, and never move model inference onto the
  AudioWorklet render thread.
- Keep the 48 kHz, 480-sample/10 ms core contract and bounded queue semantics.
- Published applications must consume version-pinned GitHub Packages releases;
  they must not compile Rust during install or application build.
