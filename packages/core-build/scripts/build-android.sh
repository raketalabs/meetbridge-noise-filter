#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$BASH_SOURCE")/../../.." && pwd)"
OUT_DIR="$ROOT_DIR/artifacts/android"
RN_PACKAGE_DIR="$ROOT_DIR/packages/noise-filter-react-native"

node "$ROOT_DIR/scripts/verify-deepfilternet-vendor.mjs"

if ! find "$ROOT_DIR/vendor/cargo" -mindepth 2 -name .cargo-checksum.json -print -quit | grep -q .; then
  echo "Missing vendor/cargo. Run the documented one-time Cargo vendoring maintenance step before building." >&2
  exit 1
fi

if ! command -v cargo-ndk >/dev/null 2>&1; then
  echo "cargo-ndk is required to build Android DeepFilterNet3 libraries." >&2
  exit 1
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

(
  cd "$ROOT_DIR/vendor/deepfilternet/libDF"
  export CARGO_HOME="$ROOT_DIR/packages/core-build/.cargo"
  export CARGO_NET_OFFLINE=true
  export CARGO_PROFILE_RELEASE_OPT_LEVEL=3
  export CARGO_PROFILE_RELEASE_LTO=thin
  export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1
  export CARGO_PROFILE_RELEASE_PANIC=abort
  export RUSTFLAGS="-C link-arg=-Wl,-z,max-page-size=16384"
  cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 -o "$OUT_DIR" \
    build --manifest-path Cargo.toml \
    --release --locked --offline --no-default-features --features capi
)

if ! printenv ANDROID_NDK_HOME >/dev/null; then
  echo "ANDROID_NDK_HOME is required to build the 16 KB-page compatible JNI wrapper." >&2
  exit 1
fi

for abi in arm64-v8a armeabi-v7a x86_64; do
  core_library="$OUT_DIR/$abi/libdf.so"
  if [[ ! -f "$core_library" ]]; then
    echo "Missing libdf.so for $abi." >&2
    exit 1
  fi
  package_library_dir="$RN_PACKAGE_DIR/android/src/main/jniLibs/$abi"
  mkdir -p "$package_library_dir"
  cp "$core_library" "$package_library_dir/libdf.so"
  wrapper_build_dir="$OUT_DIR/wrapper-$abi"
  cmake -S "$RN_PACKAGE_DIR/android" -B "$wrapper_build_dir" \
    -DANDROID_ABI="$abi" \
    -DANDROID_PLATFORM=android-24 \
    -DDEEPFILTER_LIBRARY="$package_library_dir/libdf.so" \
    -DCMAKE_TOOLCHAIN_FILE="$ANDROID_NDK_HOME/build/cmake/android.toolchain.cmake"
  cmake --build "$wrapper_build_dir" --config Release
  cp "$wrapper_build_dir/libmeetbridge_noise_filter.so" "$package_library_dir/libmeetbridge_noise_filter.so"
done

cp "$ROOT_DIR/vendor/deepfilternet/models/DeepFilterNet3_onnx.tar.gz" \
  "$RN_PACKAGE_DIR/android/src/main/assets/DeepFilterNet3_onnx.tar.gz"
cp "$ROOT_DIR/vendor/deepfilternet/models/DeepFilterNet3_onnx.tar.gz" \
  "$RN_PACKAGE_DIR/models/DeepFilterNet3_onnx.tar.gz"
