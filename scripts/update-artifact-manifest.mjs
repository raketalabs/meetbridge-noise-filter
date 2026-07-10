import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const roots = [
  'artifacts/wasm',
  'artifacts/android/arm64-v8a',
  'artifacts/android/armeabi-v7a',
  'artifacts/android/x86_64',
  'artifacts/ios/DeepFilterNet3_onnx.tar.gz',
  'artifacts/ios/MeetbridgeDeepFilter.xcframework',
  'packages/noise-filter-web/dist/assets',
  'packages/noise-filter-react-native/android/src/main/assets/DeepFilterNet3_onnx.tar.gz',
  'packages/noise-filter-react-native/android/src/main/jniLibs',
  'packages/noise-filter-react-native/ios/MeetbridgeDeepFilter.xcframework',
  'packages/noise-filter-react-native/models',
]
const files = []

function collect(input) {
  const absolute = join(root, input)
  if (!existsSync(absolute)) throw new Error(`Missing artifact path: ${input}`)
  const inputInfo = statSync(absolute)
  if (!inputInfo.isDirectory()) {
    files.push(absolute)
    return
  }
  for (const entry of readdirSync(absolute).sort()) {
    const path = join(absolute, entry)
    const info = statSync(path)
    if (info.isDirectory()) collect(relative(root, path))
    else if (!entry.startsWith('.')) files.push(path)
  }
}

for (const directory of roots) collect(directory)

const manifest = {
  schemaVersion: 1,
  release: '0.2.0',
  deepFilterNet: '3',
  tract: '0.23.3',
  files: Object.fromEntries(files.sort().map(path => {
    const bytes = readFileSync(path)
    return [relative(root, path), {
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }]
  })),
}

writeFileSync(join(root, 'artifacts/manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`Recorded ${files.length} prebuilt files in artifacts/manifest.json.`)
