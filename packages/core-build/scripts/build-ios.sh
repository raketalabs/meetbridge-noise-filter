#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT_DIR="${ROOT_DIR}/artifacts/ios"

node "${ROOT_DIR}/scripts/verify-deepfilternet-vendor.mjs"

if ! find "${ROOT_DIR}/vendor/cargo" -mindepth 2 -name .cargo-checksum.json -print -quit | grep -q .; then
  echo "Missing vendor/cargo. Run the documented one-time Cargo vendoring maintenance step before building." >&2
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1 || ! command -v xcodebuild >/dev/null 2>&1 || ! command -v lipo >/dev/null 2>&1; then
  echo "cargo, xcodebuild, and lipo are required to build the iOS DeepFilterNet3 XCFramework." >&2
  exit 1
fi

rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}/headers" "${OUT_DIR}/cargo"

for target in aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios; do
  (
    cd "${ROOT_DIR}/packages/core-build"
    export CARGO_HOME="${ROOT_DIR}/packages/core-build/.cargo"
    export CARGO_NET_OFFLINE=true
    export CARGO_PROFILE_RELEASE_OPT_LEVEL=3
    export CARGO_PROFILE_RELEASE_LTO=false
    export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1
    export CARGO_PROFILE_RELEASE_PANIC=abort
    export CARGO_TARGET_DIR="${OUT_DIR}/cargo"
    cargo build --manifest-path "${ROOT_DIR}/vendor/deepfilternet/libDF/Cargo.toml" \
      --target "${target}" --release --locked --offline --no-default-features --features capi
  )
done

DEVICE_LIBRARY="${OUT_DIR}/cargo/aarch64-apple-ios/release/libdf.a"
SIM_ARM64_LIBRARY="${OUT_DIR}/cargo/aarch64-apple-ios-sim/release/libdf.a"
SIM_X86_64_LIBRARY="${OUT_DIR}/cargo/x86_64-apple-ios/release/libdf.a"
SIM_LIBRARY="${OUT_DIR}/libdf-simulator.a"

for library in "${DEVICE_LIBRARY}" "${SIM_ARM64_LIBRARY}" "${SIM_X86_64_LIBRARY}"; do
  if [[ ! -f "${library}" ]]; then
    echo "Missing iOS static library: ${library}" >&2
    exit 1
  fi
done

cp "${ROOT_DIR}/packages/noise-filter-react-native/ios/MeetbridgeDeepFilter.h" \
  "${OUT_DIR}/headers/MeetbridgeDeepFilter.h"
lipo -create "${SIM_ARM64_LIBRARY}" "${SIM_X86_64_LIBRARY}" -output "${SIM_LIBRARY}"
xcodebuild -create-xcframework \
  -library "${DEVICE_LIBRARY}" -headers "${OUT_DIR}/headers" \
  -library "${SIM_LIBRARY}" -headers "${OUT_DIR}/headers" \
  -output "${OUT_DIR}/MeetbridgeDeepFilter.xcframework"
cp "${ROOT_DIR}/vendor/deepfilternet/models/DeepFilterNet3_onnx.tar.gz" \
  "${OUT_DIR}/DeepFilterNet3_onnx.tar.gz"

echo "Offline iOS XCFramework staged in ${OUT_DIR}."
