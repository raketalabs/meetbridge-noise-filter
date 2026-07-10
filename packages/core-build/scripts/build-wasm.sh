#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CORE_DIR="${ROOT_DIR}/packages/core-build"
OUT_DIR="${ROOT_DIR}/artifacts/wasm"

node "${ROOT_DIR}/scripts/verify-deepfilternet-vendor.mjs"

if ! find "${ROOT_DIR}/vendor/cargo" -mindepth 2 -name .cargo-checksum.json -print -quit | grep -q .; then
  echo "Missing vendor/cargo. Run the documented one-time Cargo vendoring maintenance step before building." >&2
  exit 1
fi

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "wasm-pack is required to build DeepFilterNet3 WASM." >&2
  exit 1
fi

if ! command -v wasm-opt >/dev/null 2>&1; then
  echo "wasm-opt is required to optimise DeepFilterNet3 WASM." >&2
  exit 1
fi

rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}"

(
  cd "${CORE_DIR}"
  export CARGO_HOME="${CORE_DIR}/.cargo"
  export CARGO_NET_OFFLINE=true
  export CARGO_PROFILE_RELEASE_OPT_LEVEL=3
  export CARGO_PROFILE_RELEASE_LTO=thin
  export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1
  export CARGO_PROFILE_RELEASE_PANIC=abort
  export RUSTFLAGS="-C target-feature=+simd128,+bulk-memory,+nontrapping-fptoint,+mutable-globals"
  wasm-pack build \
    --target web \
    --release \
    --out-dir "${OUT_DIR}" \
    --out-name deep_filter \
    "${ROOT_DIR}/vendor/deepfilternet/libDF" \
    --no-default-features \
    --features wasm
)

wasm-opt -O3 "${OUT_DIR}/deep_filter_bg.wasm" -o "${OUT_DIR}/deep_filter_bg.wasm"
cp "${ROOT_DIR}/vendor/deepfilternet/models/DeepFilterNet3_onnx.tar.gz" "${OUT_DIR}/DeepFilterNet3_onnx.tar.gz"

# wasm-pack writes a catch-all ignore file into the output directory. These
# locally built runtime artefacts are intentionally versioned and shipped.
rm -f "${OUT_DIR}/.gitignore"
