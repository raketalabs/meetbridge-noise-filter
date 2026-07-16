import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(packageRoot, 'models', 'DeepFilterNet3_onnx.tar.gz');
const destinationPath = path.join(packageRoot, 'ios', 'DeepFilterNet3_onnx.tar.gz');
const xcframeworkPath = path.join(packageRoot, 'ios', 'MeetbridgeDeepFilter.xcframework');
const xcframeworkPlistPath = path.join(xcframeworkPath, 'Info.plist');
const simulatorSlicePath = path.join(xcframeworkPath, 'ios-arm64_x86_64-simulator');
const legacySimulatorBinaryPath = path.join(simulatorSlicePath, 'libdf-simulator.a');
const simulatorBinaryPath = path.join(simulatorSlicePath, 'libdf.a');

if (!fs.existsSync(sourcePath)) {
  throw new Error('DeepFilterNet3 package model is missing.');
}

const sourceSize = fs.statSync(sourcePath).size;
const destinationSize = fs.existsSync(destinationPath)
  ? fs.statSync(destinationPath).size
  : -1;

if (destinationSize !== sourceSize) {
  fs.copyFileSync(sourcePath, destinationPath);
}

if (!fs.existsSync(destinationPath) || fs.statSync(destinationPath).size !== sourceSize) {
  throw new Error('DeepFilterNet3 iOS model staging failed.');
}

if (!fs.existsSync(xcframeworkPlistPath)) {
  throw new Error('DeepFilterNet3 iOS XCFramework metadata is missing.');
}

if (fs.existsSync(legacySimulatorBinaryPath)) {
  if (fs.existsSync(simulatorBinaryPath)) {
    if (fs.statSync(legacySimulatorBinaryPath).size !== fs.statSync(simulatorBinaryPath).size) {
      throw new Error('DeepFilterNet3 simulator XCFramework contains conflicting static libraries.');
    }
    fs.rmSync(legacySimulatorBinaryPath);
  } else {
    fs.renameSync(legacySimulatorBinaryPath, simulatorBinaryPath);
  }
}

const currentPlist = fs.readFileSync(xcframeworkPlistPath, 'utf8');
const normalizedPlist = currentPlist.replaceAll('libdf-simulator.a', 'libdf.a');
if (normalizedPlist !== currentPlist) {
  fs.writeFileSync(xcframeworkPlistPath, normalizedPlist);
}

if (!fs.existsSync(simulatorBinaryPath) || normalizedPlist.includes('libdf-simulator.a')) {
  throw new Error('DeepFilterNet3 simulator XCFramework normalization failed.');
}

if (process.argv.includes('--artifacts')) {
  const monorepoRoot = path.resolve(packageRoot, '..', '..');
  const artifactXcframeworkPath = path.join(
    monorepoRoot,
    'artifacts',
    'ios',
    'MeetbridgeDeepFilter.xcframework',
  );
  const artifactPlistPath = path.join(artifactXcframeworkPath, 'Info.plist');
  const artifactSimulatorSlicePath = path.join(artifactXcframeworkPath, 'ios-arm64_x86_64-simulator');
  const artifactLegacyBinaryPath = path.join(artifactSimulatorSlicePath, 'libdf-simulator.a');
  const artifactBinaryPath = path.join(artifactSimulatorSlicePath, 'libdf.a');

  if (!fs.existsSync(artifactPlistPath)) {
    throw new Error('DeepFilterNet3 artifact XCFramework metadata is missing.');
  }
  if (fs.existsSync(artifactLegacyBinaryPath)) {
    if (fs.existsSync(artifactBinaryPath)) {
      if (fs.statSync(artifactLegacyBinaryPath).size !== fs.statSync(artifactBinaryPath).size) {
        throw new Error('DeepFilterNet3 artifact XCFramework contains conflicting simulator libraries.');
      }
      fs.rmSync(artifactLegacyBinaryPath);
    } else {
      fs.renameSync(artifactLegacyBinaryPath, artifactBinaryPath);
    }
  }

  const artifactPlist = fs.readFileSync(artifactPlistPath, 'utf8');
  const normalizedArtifactPlist = artifactPlist.replaceAll('libdf-simulator.a', 'libdf.a');
  if (normalizedArtifactPlist !== artifactPlist) {
    fs.writeFileSync(artifactPlistPath, normalizedArtifactPlist);
  }
  if (!fs.existsSync(artifactBinaryPath) || normalizedArtifactPlist.includes('libdf-simulator.a')) {
    throw new Error('DeepFilterNet3 artifact XCFramework normalization failed.');
  }
}
