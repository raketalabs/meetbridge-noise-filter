import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'esbuild'

const root = resolve(new URL('..', import.meta.url).pathname)
const packageDir = resolve(root, 'packages/noise-filter-web')
const artifactDir = resolve(root, 'artifacts/wasm')
const outputDir = resolve(packageDir, 'dist')
const assets = [
  { source: 'deep_filter.js', target: 'deep_filter.js' },
  { source: 'deep_filter_bg.wasm', target: 'deep_filter_bg.wasm' },
  // The non-.gz suffix prevents Nuxt/Vite from adding Content-Encoding:gzip;
  // the Rust model loader must receive the original gzip bytes.
  { source: 'DeepFilterNet3_onnx.tar.gz', target: 'DeepFilterNet3_onnx.tar.gz.bin' },
]

for (const asset of assets) {
  if (!existsSync(resolve(artifactDir, asset.source))) {
    throw new Error(`Missing prebuilt artifact: artifacts/wasm/${asset.source}`)
  }
}

rmSync(outputDir, { recursive: true, force: true })
mkdirSync(resolve(outputDir, 'assets'), { recursive: true })

await Promise.all([
  build({
    entryPoints: [resolve(packageDir, 'src/index.ts')],
    outfile: resolve(outputDir, 'index.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    sourcemap: true,
  }),
  build({
    entryPoints: [resolve(packageDir, 'src/index.ts')],
    outfile: resolve(outputDir, 'index.cjs'),
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: ['es2022'],
    sourcemap: true,
  }),
])

const tsc = resolve(root, 'node_modules/.bin/tsc')
if (!existsSync(tsc)) throw new Error('Run npm install in the package repository before rebuilding Web declarations.')
execFileSync(tsc, ['-p', resolve(packageDir, 'tsconfig.build.json')], { stdio: 'inherit' })

for (const asset of assets) {
  cpSync(resolve(artifactDir, asset.source), resolve(outputDir, 'assets', asset.target))
}

console.log('Built the publishable Web/Electron package from committed artifacts.')
