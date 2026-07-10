#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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

  for (const input of targets) {
    const target = resolve(process.cwd(), input)
    rmSync(target, { recursive: true, force: true })
    mkdirSync(target, { recursive: true })
    for (const file of files) cpSync(resolve(assetDir, file), resolve(target, file))
    writeFileSync(resolve(target, 'manifest.json'), `${JSON.stringify({
      available: true,
      release: '0.2.0',
      files,
    }, null, 2)}\n`)
    console.log(`Staged MeetBridge DeepFilterNet3 assets in ${target}`)
  }
}
