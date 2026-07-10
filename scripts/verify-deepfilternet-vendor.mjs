import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const vendor = join(root, 'vendor', 'deepfilternet')
const required = [
  'libDF/Cargo.toml',
  'models/DeepFilterNet3_onnx.tar.gz',
  'LICENSE-MIT',
  'LICENSE-APACHE',
  'VENDOR.md',
]

for (const path of required) {
  if (!existsSync(join(vendor, path))) {
    throw new Error(`DeepFilterNet vendor check failed: missing vendor/deepfilternet/${path}`)
  }
}

const forbiddenReference = 'github.com/Rikorose/DeepFilterNet'
const allowedPaths = new Set([
  join(root, 'scripts', 'vendor-deepfilternet.sh'),
  // This verifier defines the exact forbidden URL that it scans for.
  new URL(import.meta.url).pathname,
])
const scanRoots = [join(root, 'packages'), join(root, '.github'), join(root, 'scripts')]

function scan(directory) {
  if (!existsSync(directory)) return
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    const info = statSync(path)
    if (info.isDirectory()) {
      if (entry === 'node_modules' || entry === 'vendor' || entry === 'dist') continue
      scan(path)
      continue
    }
    if (allowedPaths.has(path)) continue
    if (!/\.(?:[cm]?js|ts|json|ya?ml|sh|toml)$/i.test(entry)) continue
    if (readFileSync(path, 'utf8').includes(forbiddenReference)) {
      throw new Error(`Build-time upstream reference is not allowed: ${relative(root, path)}`)
    }
  }
}

for (const directory of scanRoots) scan(directory)

console.log('DeepFilterNet vendor integrity check passed.')
