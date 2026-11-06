#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const assetDir = resolve(packageDir, 'dist/assets')
const targets = process.argv.slice(2)
const files = [
  'deep_filter.js',
  'deep_filter_bg.wasm',
  'DeepFilterNet3_onnx.tar.gz.bin',
]

if (targets.length === 0) {
  console.error('Usage: meetbridge-stage-noise-filter-assets <target-directory> [more-targets...]')
  process.exitCode = 1
} else {
  for (const file of files) {
    if (!existsSync(resolve(assetDir, file))) {
      throw new Error(`Published package is missing dist/assets/${file}`)
    }
  }

  const release = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8')).version
  const revisions = Object.fromEntries(files.map(file => [
    file, createHash('sha256').update(readFileSync(resolve(assetDir, file))).digest('hex'),
  ]))

  const compressed = ['deep_filter.js', 'deep_filter_bg.wasm'].flatMap(file => {
    const bytes = readFileSync(resolve(assetDir, file))
    return [
      [file + '.gz', gzipSync(bytes, { level: 9 })],
      [file + '.br', brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } })],
    ]
  })

  for (const input of targets) {
    const target = resolve(process.cwd(), input)
    mkdirSync(target, { recursive: true })
    // Do not remove unrelated files from a caller-provided public directory.
    // A partial staging operation must never retain an available manifest.
    rmSync(resolve(target, 'manifest.json'), { force: true })
    for (const file of files) cpSync(resolve(assetDir, file), resolve(target, file))
    // Nitro and other static hosts can negotiate these precompressed files.
    // Keep the gzip model as opaque .bin bytes for the Rust decoder.
    for (const [file, bytes] of compressed) writeFileSync(resolve(target, file), bytes)
    writeFileSync(resolve(target, 'manifest.json'), `${JSON.stringify({
      available: true,
      release,
      files,
      revisions,
    }, null, 2)}\n`)
    console.log(`Staged MeetBridge DeepFilterNet3 assets in ${target}`)
  }
}
