#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$BASH_SOURCE")/../../.." && pwd)"
FRAMEWORK="$ROOT_DIR/artifacts/ios/MeetbridgeDeepFilter.xcframework"
RN_PACKAGE_DIR="$ROOT_DIR/packages/noise-filter-react-native"

if [[ ! -d "$FRAMEWORK" ]]; then
  echo "Missing MeetbridgeDeepFilter.xcframework in artifacts/ios." >&2
  exit 1
fi

rm -rf "$RN_PACKAGE_DIR/ios/MeetbridgeDeepFilter.xcframework"
cp -R "$FRAMEWORK" "$RN_PACKAGE_DIR/ios/MeetbridgeDeepFilter.xcframework"
cp "$ROOT_DIR/vendor/deepfilternet/models/DeepFilterNet3_onnx.tar.gz" \
  "$RN_PACKAGE_DIR/models/DeepFilterNet3_onnx.tar.gz"
