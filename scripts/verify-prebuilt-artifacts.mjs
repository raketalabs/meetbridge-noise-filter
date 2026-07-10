import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const manifestPath = join(root, 'artifacts/manifest.json')
if (!existsSync(manifestPath)) throw new Error('Missing artifacts/manifest.json')

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (manifest.release !== '0.2.0' || manifest.tract !== '0.23.3') {
  throw new Error(`Unexpected artifact release metadata: ${manifest.release} / tract ${manifest.tract}`)
}

for (const [relativePath, expected] of Object.entries(manifest.files || {})) {
  const path = join(root, relativePath)
  if (!existsSync(path)) throw new Error(`Missing committed artifact: ${relativePath}`)
  const info = statSync(path)
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex')
  if (info.size !== expected.bytes || sha256 !== expected.sha256) {
    throw new Error(`Artifact integrity mismatch: ${relativePath}`)
  }
}

console.log(`Verified ${Object.keys(manifest.files || {}).length} committed prebuilt artifacts.`)
