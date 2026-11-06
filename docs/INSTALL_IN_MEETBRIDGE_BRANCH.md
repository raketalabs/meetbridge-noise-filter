# Install into any MeetBridge branch

This procedure moves a MeetBridge branch from local `file:` packages to the
private, immutable `0.2.2` GitHub Packages release. Application imports and the
current Web, Electron, and Mobile integration APIs remain unchanged.

## 1. Authenticate npm once

Create a GitHub token that can read private packages and export it as
`NODE_AUTH_TOKEN`. Add these lines to the developer or CI npm configuration;
do not commit the token itself:

```ini
@raketalabs:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
always-auth=true
```

The repository includes `.npmrc.example` with the same non-secret template.

## 2. Web application

In the root `package.json`, replace the local dependency with this npm alias:

```json
{
  "dependencies": {
    "@meetbridge/noise-filter-web": "npm:@raketalabs/meetbridge-noise-filter-web@0.2.2"
  }
}
```

Remove the source alias for `@meetbridge/noise-filter-web` from
`nuxt.config.ts`; normal package resolution must select the compiled release.
Then install dependencies in the root application.

Stage the immutable browser assets after each clean install:

```bash
npx --no-install meetbridge-stage-noise-filter-assets public/deepfilternet
```

The command writes `deep_filter.js`, `deep_filter_bg.wasm`,
`DeepFilterNet3_onnx.tar.gz.bin`, and `manifest.json`. Keep the runtime's
default `assetBaseUrl: '/deepfilternet/'` unless the target application serves
the directory elsewhere.

## 3. Electron desktop application

In `MeetBridgeDesktopApp/package.json`, use the same alias:

```json
{
  "dependencies": {
    "@meetbridge/noise-filter-web": "npm:@raketalabs/meetbridge-noise-filter-web@0.2.2"
  }
}
```

Remove the `@meetbridge/noise-filter-web` source alias from
`MeetBridgeDesktopApp/electron.vite.config.ts`. Install the Desktop app's
dependencies, then stage its renderer assets:

```bash
npx --no-install meetbridge-stage-noise-filter-assets src/renderer/public/deepfilternet
```

Run that command from `MeetBridgeDesktopApp`. Keep Electron CSP support for
`worker-src blob:` and `script-src 'wasm-unsafe-eval'`.

## 4. Expo React Native application

In `MeetBridgeMobile/package.json`, replace the local dependency with:

```json
{
  "dependencies": {
    "@meetbridge/noise-filter-react-native": "npm:@raketalabs/meetbridge-noise-filter-react-native@0.2.2"
  }
}
```

Keep `@meetbridge/noise-filter-react-native` in the Expo `plugins` array. The
npm alias preserves that config-plugin identifier.

The published package is now inside `MeetBridgeMobile/node_modules`, so remove
the local-package-only Metro configuration that adds
`../packages/noise-filter-react-native` to `watchFolders`,
`resolver.nodeModulesPaths`, and `resolver.extraNodeModules`. A standard Expo
Metro configuration is sufficient:

```js
const { getDefaultConfig } = require('expo/metro-config');

module.exports = getDefaultConfig(__dirname);
```

Install Mobile dependencies and regenerate the native project/dev client.
Expo Go cannot load this native module. The package already contains the model,
Android libraries, and iOS XCFramework; the application must not invoke Cargo
or any core-build script.

## 5. Runtime integration stays the same

Web and Electron continue importing:

```ts
import {
  DeepFilterProcessor,
  prepareDeepFilter,
  recommendedAudioCaptureOptions,
} from '@meetbridge/noise-filter-web'
```

The default processor is the low-latency profile:

```ts
new DeepFilterProcessor({
  enabled: true,
  suppressionLevel: 70,
  latencyMode: 'low',
})
```

Use `balanced` only if rate-limited telemetry shows sustained underruns on a
device. Do not enable browser/platform noise suppression or voice isolation at
the same time as DeepFilterNet3; retain echo cancellation and auto gain.

Mobile continues importing from
`@meetbridge/noise-filter-react-native` and acquiring its global capture lease
before enabling the microphone.

## 6. Verify the integration

Web/Electron should log, in order:

```text
[MeetBridge DeepFilterNet3] ASSETS READY
[MeetBridge DeepFilterNet3] INITIALISING
[MeetBridge DeepFilterNet3] ACTIVE
[MeetBridge DeepFilterNet3] TRACK ATTACHED
[MeetBridge DeepFilterNet3] AUDIO STABLE
```

Mobile should report `NATIVE READY` and `NATIVE ACTIVE` in a custom development
client. In all applications, confirm that the LiveKit-published microphone
track is the processed track. The Deepgram VAD/PCM tap must be created from
that processed track, not from a second raw `getUserMedia` capture.

## 7. Rollback and upgrades

Rollback is an exact dependency change; replace `0.2.2` in the npm alias with a
previous published version and reinstall. Never use an unpinned `latest` range
for meeting audio.

To upgrade later, update the version in all three application package files,
refresh the lockfiles, stage Web/Desktop assets again, and regenerate Mobile's
native project. A package-version upgrade does not rebuild the core unless the
release notes explicitly say that its committed artifacts changed.
