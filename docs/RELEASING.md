# Releasing and rebuilding

## Normal package release

A normal TypeScript, Worker, AudioWorklet, Expo plugin, or wrapper change does
not require rebuilding DeepFilterNet3. Update the package version, rebuild only
the Web package when its TypeScript changed, inspect the diff, and publish the
already committed files. Native consumers link the committed binaries.

The GitHub Actions publish workflow deliberately does not compile the core. It
verifies the committed artifact manifest and publishes the two package
directories to GitHub Packages. This keeps a package release deterministic and
prevents an accidental multi-hour native build.

## When a core rebuild is actually required

Rebuild only when one of these changes:

- DeepFilterNet/tract source or version;
- Rust FFI/WASM implementation;
- compiler target, optimization, page-size, or ABI settings;
- supported Android ABI or iOS slice;
- model archive.

Core maintenance uses the committed `vendor/deepfilternet` and `vendor/cargo`
trees in offline mode. Builds must not fetch source at build time.

### WebAssembly

```bash
cd packages/core-build
npm run wasm
cd ../noise-filter-web
npm run build
```

### Android

Set `ANDROID_NDK_HOME`; ensure `cargo-ndk` and the Android SDK CMake binary are
available, then run:

```bash
cd packages/core-build
npm run android
```

The script builds arm64-v8a, armeabi-v7a, and x86_64 with 16 KB page-compatible
linker settings and stages the core/wrapper libraries plus model in the React
Native package.

### iOS

```bash
cd packages/core-build
npm run ios
bash ./scripts/stage-ios-xcframework.sh
```

The first command creates device and simulator slices; the second copies the
XCFramework and model into the publishable React Native package.

## Artifact update checklist

1. Replace every affected committed artifact and package copy in one change.
2. Regenerate `artifacts/manifest.json` with the repository maintenance script.
3. Update both package changelogs and the root version.
4. Keep binary/model patterns in Git LFS and confirm the publish workflow uses
   `actions/checkout` with `lfs: true`.
5. Create a version tag only after the private packages have been published.

Application repositories never follow this procedure. They install the
versioned packages described in `INSTALL_IN_MEETBRIDGE_BRANCH.md`.
