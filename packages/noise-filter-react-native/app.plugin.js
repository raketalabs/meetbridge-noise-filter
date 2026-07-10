const fs = require('node:fs')
const path = require('node:path')

// Resolve the config-plugin API from the consuming Expo project explicitly.
// This works for both a registry install and a local symlink during package
// development without bundling a second Expo config-plugin runtime.
const configPluginsPath = require.resolve('@expo/config-plugins', {
  paths: [process.cwd(), __dirname],
})
const { withDangerousMod, createRunOncePlugin } = require(configPluginsPath)

const LIVEKIT_ANDROID_FILE = path.join(
  'android',
  'src',
  'main',
  'java',
  'com',
  'livekit',
  'reactnative',
  'LiveKitReactNative.kt',
)

function findLiveKitRoot(projectRoot) {
  let current = path.resolve(projectRoot)
  while (true) {
    const candidate = path.join(current, 'node_modules', '@livekit', 'react-native')
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error('Could not resolve @livekit/react-native from the Expo project.')
}

function withDeepFilterNetAndroidAudioPolicy(config, props = {}) {
  if (props.enabled === false) return config
  return withDangerousMod(config, [
    'android',
    async nextConfig => {
      const projectRoot = nextConfig.modRequest.projectRoot
      // LiveKit 2.10 does not export package.json, and its Node default export
      // is extensionless. Resolve the installed package directory directly so
      // the config plugin also works under Node 24.
      const liveKitRoot = findLiveKitRoot(projectRoot)
      const target = path.join(liveKitRoot, LIVEKIT_ANDROID_FILE)
      if (!fs.existsSync(target)) {
        throw new Error('Could not find the LiveKit React Native Android audio module.')
      }
      const source = fs.readFileSync(target, 'utf8')
      const marker = 'MeetBridge DeepFilterNet3 capture policy'
      if (source.includes(marker)) return nextConfig
      const expected = '.setUseHardwareNoiseSuppressor(useHardwareAudioProcessing)'
      if (!source.includes(expected)) {
        throw new Error('LiveKit React Native audio policy changed; review the DeepFilterNet3 hardware-noise patch.')
      }
      const replacement = [
        '// ' + marker + ': DF3 is the sole noise suppressor. Keep hardware AEC enabled.',
        '.setUseHardwareNoiseSuppressor(false)',
      ].join('\n            ')
      fs.writeFileSync(target, source.replace(expected, replacement))
      return nextConfig
    },
  ])
}

module.exports = createRunOncePlugin(
  withDeepFilterNetAndroidAudioPolicy,
  '@meetbridge/noise-filter-react-native',
  '0.2.0',
)
