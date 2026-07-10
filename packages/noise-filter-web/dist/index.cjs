"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  DEEPGRAM_PCM_FRAME_MS: () => DEEPGRAM_PCM_FRAME_MS,
  DEEPGRAM_PCM_SAMPLE_RATE: () => DEEPGRAM_PCM_SAMPLE_RATE,
  DEEP_FILTER_HOP_SIZE: () => DEEP_FILTER_HOP_SIZE,
  DEEP_FILTER_SAMPLE_RATE: () => DEEP_FILTER_SAMPLE_RATE,
  DeepFilterProcessor: () => DeepFilterProcessor,
  createDeepgramVadPcmStream: () => createDeepgramVadPcmStream,
  createNoiseFilterNode: () => createNoiseFilterNode,
  deepFilterTransportHops: () => deepFilterTransportHops,
  destroyNoiseFilterNode: () => destroyNoiseFilterNode,
  fallbackAudioCaptureOptions: () => fallbackAudioCaptureOptions,
  isNoiseFilterFeatureEnabled: () => isNoiseFilterFeatureEnabled,
  prepareDeepFilter: () => prepareDeepFilter,
  recommendedAudioCaptureOptions: () => recommendedAudioCaptureOptions,
  resolveDeepFilterLatencyMode: () => resolveDeepFilterLatencyMode
});
module.exports = __toCommonJS(index_exports);

// src/runtime.ts
var DEEP_FILTER_SAMPLE_RATE = 48e3;
var DEEP_FILTER_HOP_SIZE = 480;
var PROCESSOR_NAME = "meetbridge-deepfilternet3";
var DEFAULT_ASSET_BASE_URL = "/deepfilternet/";
var DEFAULT_SUPPRESSION_LEVEL = 70;
var DEFAULT_LATENCY_MODE = "low";
var LOG_PREFIX = "[MeetBridge DeepFilterNet3]";
var workletModules = /* @__PURE__ */ new WeakMap();
var controllers = /* @__PURE__ */ new WeakMap();
function logRuntime(level, message, detail) {
  const logger = console[level] || console.info;
  if (typeof detail === "undefined") logger(`${LOG_PREFIX} ${message}`);
  else logger(`${LOG_PREFIX} ${message}`, detail);
}
function clampLevel(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_SUPPRESSION_LEVEL;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}
function resolveDeepFilterLatencyMode(value) {
  if (value === "balanced" || value === "resilient") return value;
  return DEFAULT_LATENCY_MODE;
}
function deepFilterTransportHops(mode) {
  if (mode === "resilient") return 4;
  if (mode === "balanced") return 3;
  return 2;
}
function resolveAssetUrl(file, assetBaseUrl) {
  const base = (assetBaseUrl || DEFAULT_ASSET_BASE_URL).endsWith("/") ? assetBaseUrl || DEFAULT_ASSET_BASE_URL : (assetBaseUrl || DEFAULT_ASSET_BASE_URL) + "/";
  if (/^[a-z][a-z\d+.-]*:/i.test(base)) return new URL(file, base).toString();
  if (typeof window !== "undefined") return new URL(base + file, window.location.origin).toString();
  return base + file;
}
function getDeepFilterAssetUrls(assetBaseUrl) {
  return {
    manifestUrl: resolveAssetUrl("manifest.json", assetBaseUrl),
    moduleUrl: resolveAssetUrl("deep_filter.js", assetBaseUrl),
    wasmUrl: resolveAssetUrl("deep_filter_bg.wasm", assetBaseUrl),
    // The .bin suffix prevents static servers from attaching
    // Content-Encoding:gzip and transparently inflating the model before the
    // Rust core's GzDecoder receives it.
    modelUrl: resolveAssetUrl("DeepFilterNet3_onnx.tar.gz.bin", assetBaseUrl)
  };
}
function canUseDeepFilterRuntime() {
  return typeof window !== "undefined" && typeof AudioWorkletNode !== "undefined" && typeof Worker !== "undefined" && typeof MessageChannel !== "undefined" && typeof WebAssembly !== "undefined" && typeof Blob !== "undefined" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
}
async function preflightDeepFilterRuntime(assetBaseUrl) {
  if (!canUseDeepFilterRuntime()) {
    logRuntime("warn", "UNAVAILABLE: this renderer does not support AudioWorklet, Worker, or WebAssembly.");
    return false;
  }
  const assets = getDeepFilterAssetUrls(assetBaseUrl);
  try {
    const manifestResponse = await fetch(assets.manifestUrl, { cache: "no-cache" });
    if (!manifestResponse.ok) {
      logRuntime("warn", `UNAVAILABLE: deployment manifest returned HTTP ${manifestResponse.status}.`, assets.manifestUrl);
      return false;
    }
    const manifest = await manifestResponse.json();
    const manifestFiles = Array.isArray(manifest.files) ? manifest.files : [];
    const expectedFiles = ["deep_filter.js", "deep_filter_bg.wasm", "DeepFilterNet3_onnx.tar.gz.bin"];
    if (manifest.available !== true || !expectedFiles.every((file) => manifestFiles.includes(file))) {
      logRuntime("warn", "UNAVAILABLE: WASM/model artefacts have not been staged; browser noise suppression fallback remains active.", manifest);
      return false;
    }
    const responses = await Promise.all([
      fetch(assets.moduleUrl, { cache: "force-cache" }),
      fetch(assets.wasmUrl, { cache: "force-cache" }),
      fetch(assets.modelUrl, { cache: "force-cache" })
    ]);
    const ready = responses.every((response) => response.ok);
    if (ready) logRuntime("info", "ASSETS READY: model and WASM passed preflight.", assets);
    else logRuntime("warn", "UNAVAILABLE: one or more staged assets could not be fetched.", responses.map((response) => response.status));
    return ready;
  } catch (error) {
    logRuntime("error", "UNAVAILABLE: preflight failed unexpectedly; using browser fallback.", error);
    return false;
  }
}
function workletBootstrap() {
  class MeetBridgeDeepFilterWorklet extends AudioWorkletProcessor {
    sourceHop;
    primeHops = 3;
    // The committed DF3 model has one STFT hop plus two configured lookahead
    // hops. A result returned for capture sequence N therefore represents the
    // audio from sequence N - 3.
    coreDelayHops = 3;
    maxBacklog = 3;
    fallbackHoldHops = 2;
    crossfadeSamples;
    dataPort = null;
    enabled;
    destroyed = false;
    rawFrames;
    rawSequences;
    rawSlotCount = 8;
    captureOffset = 0;
    captureSequence = 0;
    activeCaptureSlot = -1;
    slotBuffers;
    freeSlotStack;
    freeSlotCount;
    frameMessages;
    frameTransfers;
    slotCount = 8;
    inFlight = 0;
    resultFrames;
    resultSequences;
    resultFiltered;
    resultQueued;
    resultCaptureSlots;
    resultSlotCount = 5;
    queueDepth = 0;
    maxQueueDepth = 0;
    playbackStarted = false;
    primed = false;
    playbackSequence = 0;
    playbackOffset = 0;
    playbackResultIndex = -1;
    playbackRawIndex = -1;
    playbackHasFiltered = false;
    playbackModeFiltered = false;
    fadeCurve;
    transitionActive = false;
    transitionToFiltered = false;
    transitionOffset = 0;
    transitionCorrection = 0;
    fallbackHoldRemaining = 0;
    lastOutput = 0;
    lateFrames = 0;
    droppedFrames = 0;
    underruns = 0;
    telemetryCountdown;
    telemetryMessage;
    primedMessage = { type: "primed" };
    constructor(options) {
      super();
      const config = options.processorOptions;
      const latencyMode = config?.latencyMode === "balanced" || config?.latencyMode === "resilient" ? config.latencyMode : "low";
      this.primeHops = latencyMode === "resilient" ? 4 : latencyMode === "balanced" ? 3 : 2;
      this.maxBacklog = this.primeHops;
      this.fallbackHoldHops = latencyMode === "resilient" ? 3 : 2;
      this.rawSlotCount = Math.max(8, this.primeHops + this.coreDelayHops + 2);
      this.resultSlotCount = this.maxBacklog + 3;
      this.sourceHop = Math.max(1, Math.round(sampleRate / 100));
      this.crossfadeSamples = this.sourceHop;
      this.enabled = config?.enabled !== false;
      this.rawFrames = [];
      for (let index = 0; index < this.rawSlotCount; index += 1) {
        this.rawFrames.push(new Float32Array(this.sourceHop));
      }
      this.rawSequences = new Int32Array(this.rawSlotCount);
      this.rawSequences.fill(-1);
      this.slotBuffers = [];
      this.freeSlotStack = new Int16Array(this.slotCount);
      this.frameMessages = [];
      this.frameTransfers = [];
      for (let index = 0; index < this.slotCount; index += 1) {
        const buffer = new Float32Array(this.sourceHop);
        this.slotBuffers.push(buffer);
        this.freeSlotStack[index] = index;
        this.frameMessages.push({
          type: "frame",
          sequence: 0,
          captureTimestampMs: 0,
          slotId: index,
          samples: buffer
        });
        this.frameTransfers.push([buffer.buffer]);
      }
      this.freeSlotCount = this.slotCount;
      this.resultFrames = [];
      for (let index = 0; index < this.resultSlotCount; index += 1) this.resultFrames.push(null);
      this.resultSequences = new Int32Array(this.resultSlotCount);
      this.resultSequences.fill(-1);
      this.resultFiltered = new Uint8Array(this.resultSlotCount);
      this.resultQueued = new Uint8Array(this.resultSlotCount);
      this.resultCaptureSlots = new Int16Array(this.resultSlotCount);
      this.resultCaptureSlots.fill(-1);
      this.fadeCurve = new Float32Array(this.crossfadeSamples);
      for (let index = 0; index < this.crossfadeSamples; index += 1) {
        const position = this.crossfadeSamples === 1 ? 1 : index / (this.crossfadeSamples - 1);
        this.fadeCurve[index] = 0.5 - 0.5 * Math.cos(Math.PI * position);
      }
      this.telemetryCountdown = Math.round(sampleRate * 5);
      this.telemetryMessage = {
        type: "telemetry",
        lateFrames: 0,
        droppedFrames: 0,
        underruns: 0,
        queueDepth: 0,
        maxQueueDepth: 0
      };
      this.port.onmessage = (event) => {
        const data = event.data;
        if (!data) return;
        if (data.type === "connect-worker" && data.port) {
          this.dataPort = data.port;
          this.dataPort.onmessage = (message) => this.handleWorkerMessage(message);
          this.dataPort.start();
          return;
        }
        if (data.type === "enabled") {
          this.enabled = data.enabled !== false;
          return;
        }
        if (data.type === "worker-error" || data.type === "bypass") {
          this.enabled = false;
          return;
        }
        if (data.type === "destroy") {
          this.destroyed = true;
          this.dataPort?.close();
          this.dataPort = null;
        }
      };
    }
    acquireCaptureSlot() {
      if (!this.dataPort || this.inFlight + this.queueDepth >= this.maxBacklog || this.freeSlotCount <= 0) return -1;
      this.freeSlotCount -= 1;
      return this.freeSlotStack[this.freeSlotCount];
    }
    releaseCaptureSlot(slotId) {
      if (slotId < 0 || slotId >= this.slotCount || this.freeSlotCount >= this.slotCount) return;
      this.freeSlotStack[this.freeSlotCount] = slotId;
      this.freeSlotCount += 1;
    }
    releaseResult(resultIndex) {
      if (resultIndex < 0 || this.resultSequences[resultIndex] < 0) return;
      const slotId = this.resultCaptureSlots[resultIndex];
      this.resultFrames[resultIndex] = null;
      this.resultSequences[resultIndex] = -1;
      this.resultFiltered[resultIndex] = 0;
      if (this.resultQueued[resultIndex] === 1 && this.queueDepth > 0) this.queueDepth -= 1;
      this.resultQueued[resultIndex] = 0;
      this.resultCaptureSlots[resultIndex] = -1;
      this.releaseCaptureSlot(slotId);
    }
    handleWorkerMessage(event) {
      const data = event.data;
      if (!data || data.type !== "result" || !data.samples) return;
      if (this.inFlight > 0) this.inFlight -= 1;
      const sequence = Number(data.sequence);
      const slotId = Number(data.slotId);
      if (!Number.isInteger(sequence) || !Number.isInteger(slotId) || slotId < 0 || slotId >= this.slotCount) return;
      const frame = data.samples;
      this.slotBuffers[slotId] = frame;
      if (frame.length !== this.sourceHop) {
        this.droppedFrames += 1;
        this.releaseCaptureSlot(slotId);
        return;
      }
      const playbackAlreadyStarted = this.playbackStarted && (sequence < this.playbackSequence || sequence === this.playbackSequence && this.playbackOffset > 0);
      if (playbackAlreadyStarted) {
        this.lateFrames += 1;
        this.releaseCaptureSlot(slotId);
        return;
      }
      if (this.queueDepth >= this.primeHops) {
        let oldestIndex = -1;
        let oldestSequence = Number.MAX_SAFE_INTEGER;
        for (let index = 0; index < this.resultSlotCount; index += 1) {
          const queuedSequence = this.resultSequences[index];
          if (this.resultQueued[index] === 1 && queuedSequence < oldestSequence) {
            oldestSequence = queuedSequence;
            oldestIndex = index;
          }
        }
        if (oldestIndex >= 0) {
          this.droppedFrames += 1;
          this.releaseResult(oldestIndex);
        }
      }
      const resultIndex = sequence % this.resultSlotCount;
      if (this.resultSequences[resultIndex] >= 0) {
        this.droppedFrames += 1;
        this.releaseResult(resultIndex);
      }
      this.resultFrames[resultIndex] = frame;
      this.resultSequences[resultIndex] = sequence;
      this.resultFiltered[resultIndex] = data.filtered === true ? 1 : 0;
      this.resultQueued[resultIndex] = 1;
      this.resultCaptureSlots[resultIndex] = slotId;
      this.queueDepth += 1;
      if (this.queueDepth > this.maxQueueDepth) this.maxQueueDepth = this.queueDepth;
    }
    beginCaptureFrame() {
      const rawIndex = this.captureSequence % this.rawSlotCount;
      this.rawSequences[rawIndex] = this.captureSequence;
      this.activeCaptureSlot = this.acquireCaptureSlot();
    }
    finishCaptureFrame() {
      const sequence = this.captureSequence;
      const slotId = this.activeCaptureSlot;
      const buffer = slotId >= 0 ? this.slotBuffers[slotId] : null;
      if (slotId >= 0 && buffer && this.dataPort && this.inFlight + this.queueDepth < this.maxBacklog) {
        const message = this.frameMessages[slotId];
        const transfer = this.frameTransfers[slotId];
        message.sequence = sequence;
        message.captureTimestampMs = sequence * this.sourceHop * 1e3 / sampleRate;
        message.samples = buffer;
        transfer[0] = buffer.buffer;
        this.slotBuffers[slotId] = null;
        this.inFlight += 1;
        const backlogDepth = this.inFlight + this.queueDepth;
        if (backlogDepth > this.maxQueueDepth) this.maxQueueDepth = backlogDepth;
        try {
          this.dataPort.postMessage(message, transfer);
        } catch {
          this.inFlight -= 1;
          this.slotBuffers[slotId] = buffer;
          this.releaseCaptureSlot(slotId);
          this.droppedFrames += 1;
        }
      } else {
        if (slotId >= 0) this.releaseCaptureSlot(slotId);
        this.droppedFrames += 1;
      }
      this.activeCaptureSlot = -1;
      this.captureOffset = 0;
      this.captureSequence += 1;
      if (!this.playbackStarted && this.captureSequence >= this.primeHops) {
        this.playbackStarted = true;
        this.playbackSequence = 0;
        this.playbackOffset = 0;
        this.beginPlaybackFrame();
      }
    }
    beginPlaybackFrame() {
      const rawSequence = this.playbackSequence - this.coreDelayHops;
      this.playbackRawIndex = rawSequence >= 0 ? rawSequence % this.rawSlotCount : -1;
      if (rawSequence >= 0 && this.rawSequences[this.playbackRawIndex] !== rawSequence) {
        this.playbackRawIndex = -1;
        this.underruns += 1;
      }
      const resultIndex = this.playbackSequence % this.resultSlotCount;
      const hasResult = this.resultSequences[resultIndex] === this.playbackSequence;
      this.playbackResultIndex = hasResult ? resultIndex : -1;
      if (hasResult && this.resultQueued[resultIndex] === 1) {
        this.resultQueued[resultIndex] = 0;
        if (this.queueDepth > 0) this.queueDepth -= 1;
      }
      this.playbackHasFiltered = hasResult && this.resultFiltered[resultIndex] === 1;
      if (this.enabled && !hasResult) this.underruns += 1;
      if (this.enabled && !this.playbackHasFiltered) {
        this.fallbackHoldRemaining = this.fallbackHoldHops;
      } else if (this.fallbackHoldRemaining > 0) {
        this.fallbackHoldRemaining -= 1;
      }
      const targetFiltered = this.enabled && this.playbackHasFiltered && this.fallbackHoldRemaining === 0;
      if (targetFiltered !== this.playbackModeFiltered) {
        this.transitionActive = true;
        this.transitionToFiltered = targetFiltered;
        this.transitionOffset = 0;
        if (targetFiltered) {
          this.transitionCorrection = 0;
        } else {
          const rawFrame = this.playbackRawIndex >= 0 ? this.rawFrames[this.playbackRawIndex] : null;
          const rawStart = rawFrame ? rawFrame[0] : this.lastOutput;
          this.transitionCorrection = this.lastOutput - rawStart;
        }
      }
      if (!this.primed && this.playbackSequence >= this.coreDelayHops) {
        this.primed = true;
        this.port.postMessage(this.primedMessage);
      }
    }
    renderPlaybackSample() {
      const rawFrame = this.playbackRawIndex >= 0 ? this.rawFrames[this.playbackRawIndex] : null;
      const raw = rawFrame ? rawFrame[this.playbackOffset] : this.lastOutput;
      const filteredFrame = this.playbackResultIndex >= 0 ? this.resultFrames[this.playbackResultIndex] : null;
      const filtered = filteredFrame && this.playbackHasFiltered ? filteredFrame[this.playbackOffset] : raw;
      let next = this.playbackModeFiltered && this.playbackHasFiltered ? filtered : raw;
      if (this.transitionActive) {
        const mix = this.fadeCurve[this.transitionOffset];
        if (this.transitionToFiltered && this.playbackHasFiltered) {
          next = raw * (1 - mix) + filtered * mix;
        } else {
          next = raw + this.transitionCorrection * (1 - mix);
        }
        this.transitionOffset += 1;
        if (this.transitionOffset >= this.crossfadeSamples) {
          this.transitionActive = false;
          this.playbackModeFiltered = this.transitionToFiltered;
          this.transitionCorrection = 0;
        }
      }
      this.lastOutput = next;
      this.playbackOffset += 1;
      if (this.playbackOffset >= this.sourceHop) {
        if (this.playbackResultIndex >= 0) this.releaseResult(this.playbackResultIndex);
        this.playbackResultIndex = -1;
        this.playbackOffset = 0;
        this.playbackSequence += 1;
      }
      return next;
    }
    emitTelemetryIfDue(outputLength) {
      this.telemetryCountdown -= outputLength;
      if (this.telemetryCountdown > 0) return;
      this.telemetryCountdown += Math.round(sampleRate * 5);
      const message = this.telemetryMessage;
      message.lateFrames = this.lateFrames;
      message.droppedFrames = this.droppedFrames;
      message.underruns = this.underruns;
      message.queueDepth = this.inFlight + this.queueDepth;
      message.maxQueueDepth = this.maxQueueDepth;
      this.port.postMessage(message);
    }
    process(inputs, outputs) {
      if (this.destroyed) return false;
      const input = inputs[0];
      const output = outputs[0];
      const outputLength = output?.[0]?.length || 0;
      for (let index = 0; index < outputLength; index += 1) {
        if (this.captureOffset === 0) this.beginCaptureFrame();
        let sample = 0;
        if (input?.length) {
          for (let channel = 0; channel < input.length; channel += 1) sample += input[channel]?.[index] || 0;
          sample /= input.length;
        }
        const rawIndex = this.captureSequence % this.rawSlotCount;
        this.rawFrames[rawIndex][this.captureOffset] = sample;
        if (this.activeCaptureSlot >= 0) {
          const captureBuffer = this.slotBuffers[this.activeCaptureSlot];
          if (captureBuffer) captureBuffer[this.captureOffset] = sample;
        }
        this.captureOffset += 1;
        if (this.captureOffset >= this.sourceHop) this.finishCaptureFrame();
        const next = this.playbackStarted ? this.renderPlaybackSample() : 0;
        if (this.playbackStarted && this.playbackOffset === 0) this.beginPlaybackFrame();
        for (let channel = 0; channel < output.length; channel += 1) output[channel][index] = next;
      }
      this.emitTelemetryIfDue(outputLength);
      return true;
    }
  }
  registerProcessor("meetbridge-deepfilternet3", MeetBridgeDeepFilterWorklet);
}
function workerBootstrap() {
  const workerScope = self;
  let state = null;
  let bindings = null;
  let dataPort = null;
  let requestedEnabled = true;
  let autoBypassed = false;
  let autoBypassFrames = 0;
  let recoveryWarmupFrames = 0;
  let modelInput = new Float32Array(480);
  let frameCount = 0;
  let frameTimeTotal = 0;
  let guardFrameCount = 0;
  let rollingFrameTimeMs = 0;
  let overDeadlineStreak = 0;
  let sustainedHighAverageFrames = 0;
  let phase = "idle";
  let lastSequence = -1;
  let errorReported = false;
  const processingHistogram = new Uint32Array(40);
  function resetOverloadGuard() {
    guardFrameCount = 0;
    rollingFrameTimeMs = 0;
    overDeadlineStreak = 0;
    sustainedHighAverageFrames = 0;
  }
  function toAttenuation(level) {
    return -Math.max(0, Math.min(100, Number(level) || 0)) * 0.8;
  }
  function sinc(value) {
    if (Math.abs(value) < 1e-8) return 1;
    const piValue = Math.PI * value;
    return Math.sin(piValue) / piValue;
  }
  function resampleInto(input, output) {
    if (input.length === output.length) {
      output.set(input);
      return;
    }
    const ratio = input.length / output.length;
    const halfTaps = 16;
    for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
      const center = (outputIndex + 0.5) * ratio - 0.5;
      const left = Math.floor(center) - halfTaps + 1;
      let sum = 0;
      let weightSum = 0;
      for (let tap = 0; tap < halfTaps * 2; tap += 1) {
        const sourceIndex = left + tap;
        if (sourceIndex < 0 || sourceIndex >= input.length) continue;
        const distance = sourceIndex - center;
        const windowWeight = 0.5 + 0.5 * Math.cos(Math.PI * distance / halfTaps);
        const weight = sinc(distance) * windowWeight;
        sum += input[sourceIndex] * weight;
        weightSum += weight;
      }
      output[outputIndex] = weightSum ? sum / weightSum : 0;
    }
  }
  function processingP95() {
    const target = Math.max(1, Math.ceil(frameCount * 0.95));
    let cumulative = 0;
    for (let index = 0; index < processingHistogram.length; index += 1) {
      cumulative += processingHistogram[index];
      if (cumulative >= target) return (index + 1) * 0.5;
    }
    return processingHistogram.length * 0.5;
  }
  function postWorkerStats() {
    postMessage({
      type: "worker-stats",
      processedFrames: frameCount,
      avgFrameTimeMs: frameCount ? frameTimeTotal / frameCount : 0,
      p95FrameTimeMs: processingP95()
    });
  }
  async function initialise(config) {
    modelInput = new Float32Array(480);
    requestedEnabled = config.enabled !== false;
    resetOverloadGuard();
    phase = "importing-bindings";
    bindings = await workerScope.__meetbridgeImport(config.moduleUrl);
    const initialiseWasm = bindings?.default || bindings?.init;
    if (typeof initialiseWasm !== "function") throw new Error("DeepFilterNet3 WASM init is unavailable");
    phase = "initializing-wasm";
    await initialiseWasm(config.wasmUrl);
    phase = "fetching-model";
    const response = await fetch(config.modelUrl, { cache: "force-cache" });
    if (!response.ok) throw new Error("DeepFilterNet3 model asset is unavailable");
    phase = "reading-model";
    const model = new Uint8Array(await response.arrayBuffer());
    if (model[0] !== 31 || model[1] !== 139) {
      throw new Error("DeepFilterNet3 model response is not gzip-compressed; check Content-Encoding");
    }
    phase = "creating-state";
    const configuredLevel = Number(config.suppressionLevel);
    const suppressionLevel = Number.isFinite(configuredLevel) ? configuredLevel : 70;
    state = bindings?.df_create(model, toAttenuation(suppressionLevel));
    if (!state) throw new Error("DeepFilterNet3 state could not initialise");
    phase = "ready";
    postMessage({ type: "ready", modelBytes: model.byteLength });
  }
  function returnRawFrame(data, input) {
    dataPort?.postMessage({
      type: "result",
      sequence: data.sequence,
      captureTimestampMs: data.captureTimestampMs,
      slotId: data.slotId,
      samples: input,
      filtered: false
    }, [input.buffer]);
  }
  function handleFrame(data) {
    if (data.type !== "frame" || !data.samples || !dataPort) return;
    const input = data.samples;
    try {
      const sequence = Number(data.sequence);
      if (!Number.isInteger(sequence) || sequence <= lastSequence) {
        returnRawFrame(data, input);
        return;
      }
      lastSequence = sequence;
      if (autoBypassed) {
        autoBypassFrames += 1;
        if (autoBypassFrames >= 100) {
          autoBypassed = false;
          autoBypassFrames = 0;
          recoveryWarmupFrames = 20;
          resetOverloadGuard();
          postMessage({ type: "recovering" });
        }
      }
      const shouldProcess = requestedEnabled && !autoBypassed && Boolean(bindings) && Boolean(state);
      if (!shouldProcess || !bindings || !state) {
        returnRawFrame(data, input);
        return;
      }
      phase = "processing-frame";
      const startedAt = performance.now();
      if (input.length === 480) modelInput = input;
      else resampleInto(input, modelInput);
      const processed = bindings.df_process_frame(state, modelInput);
      if (input.length === processed.length) input.set(processed);
      else resampleInto(processed, input);
      const frameTimeMs = performance.now() - startedAt;
      frameCount += 1;
      frameTimeTotal += frameTimeMs;
      const histogramIndex = Math.max(0, Math.min(processingHistogram.length - 1, Math.floor(frameTimeMs * 2)));
      processingHistogram[histogramIndex] += 1;
      guardFrameCount += 1;
      rollingFrameTimeMs = guardFrameCount === 1 ? frameTimeMs : rollingFrameTimeMs * 0.95 + frameTimeMs * 0.05;
      overDeadlineStreak = frameTimeMs > 9.5 ? overDeadlineStreak + 1 : 0;
      sustainedHighAverageFrames = guardFrameCount > 100 && rollingFrameTimeMs > 8 ? sustainedHighAverageFrames + 1 : 0;
      const avgFrameTimeMs = frameTimeTotal / frameCount;
      const sustainedOverload = guardFrameCount > 100 && (overDeadlineStreak >= 8 || sustainedHighAverageFrames >= 50);
      if (sustainedOverload) {
        autoBypassed = true;
        autoBypassFrames = 0;
        postMessage({
          type: "overload",
          avgFrameTimeMs,
          rollingFrameTimeMs,
          overDeadlineStreak
        });
      }
      let filtered = !autoBypassed && recoveryWarmupFrames <= 0;
      if (recoveryWarmupFrames > 0) {
        recoveryWarmupFrames -= 1;
        filtered = false;
        if (recoveryWarmupFrames === 0) postMessage({ type: "recovered" });
      }
      const shouldPostStats = frameCount % 500 === 0;
      phase = "ready";
      dataPort.postMessage({
        type: "result",
        sequence,
        captureTimestampMs: data.captureTimestampMs,
        slotId: data.slotId,
        samples: input,
        filtered
      }, [input.buffer]);
      if (shouldPostStats) {
        try {
          postWorkerStats();
        } catch {
        }
      }
    } catch (error) {
      returnRawFrame(data, input);
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : void 0;
      requestedEnabled = false;
      if (!errorReported) {
        errorReported = true;
        postMessage({ type: "error", message, phase, stack });
      }
    }
  }
  self.onmessage = async (event) => {
    const data = event.data;
    try {
      if (data.type === "connect-worklet" && data.port) {
        dataPort = data.port;
        dataPort.onmessage = (message) => handleFrame(message.data);
        dataPort.start();
        return;
      }
      if (data.type === "init") {
        await initialise(data);
        return;
      }
      if (data.type === "enabled") {
        const nextEnabled = data.enabled !== false;
        if (nextEnabled && !requestedEnabled) {
          recoveryWarmupFrames = 20;
          resetOverloadGuard();
          errorReported = false;
        }
        requestedEnabled = nextEnabled;
        if (!nextEnabled) {
          autoBypassed = false;
          recoveryWarmupFrames = 0;
        }
        return;
      }
      if (data.type === "suppression-level") {
        if (bindings && state) bindings.df_set_atten_lim(state, toAttenuation(Number(data.level) || 0));
        return;
      }
      if (data.type === "destroy") {
        dataPort?.close();
        dataPort = null;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : void 0;
      postMessage({ type: "error", message, phase, stack });
    }
  };
}
function sourceFromBootstrap(bootstrap) {
  const text = bootstrap.toString();
  return "(" + text + ")()";
}
async function installWorkletModule(audioContext) {
  let pending = workletModules.get(audioContext);
  if (!pending) {
    const source = sourceFromBootstrap(workletBootstrap);
    const blobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    pending = audioContext.audioWorklet.addModule(blobUrl).finally(() => URL.revokeObjectURL(blobUrl));
    workletModules.set(audioContext, pending);
  }
  await pending;
}
async function createDeepFilterRuntimeNode(audioContext, options = {}) {
  if (!canUseDeepFilterRuntime()) throw new Error("AudioWorklet or WebAssembly is unavailable");
  await installWorkletModule(audioContext);
  const latencyMode = resolveDeepFilterLatencyMode(options.latencyMode);
  const node = new AudioWorkletNode(audioContext, PROCESSOR_NAME, {
    channelCount: 1,
    channelCountMode: "explicit",
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: {
      enabled: options.enabled !== false,
      latencyMode
    }
  });
  const workerSource = "self.__meetbridgeImport = (url) => import(url);\n" + sourceFromBootstrap(workerBootstrap);
  const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
  const worker = new Worker(workerUrl, { type: "module", name: PROCESSOR_NAME });
  const audioChannel = new MessageChannel();
  node.port.postMessage({ type: "connect-worker", port: audioChannel.port1 }, [audioChannel.port1]);
  worker.postMessage({ type: "connect-worklet", port: audioChannel.port2 }, [audioChannel.port2]);
  const assets = getDeepFilterAssetUrls(options.assetBaseUrl);
  logRuntime("info", "INITIALISING: worker is loading the model before microphone publication.", {
    sampleRate: audioContext.sampleRate,
    assetBaseUrl: options.assetBaseUrl || DEFAULT_ASSET_BASE_URL,
    latencyMode,
    transportHops: deepFilterTransportHops(latencyMode)
  });
  let destroyed = false;
  let resolveReady = null;
  let rejectReady = null;
  let resolvePrimed = null;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const primed = new Promise((resolve) => {
    resolvePrimed = resolve;
  });
  const telemetry = {
    processedFrames: 0,
    lateFrames: 0,
    droppedFrames: 0,
    underruns: 0,
    queueDepth: 0,
    maxQueueDepth: 0,
    avgFrameTimeMs: 0,
    p95FrameTimeMs: 0
  };
  let lastTelemetryLogAt = 0;
  let lastLoggedLateFrames = 0;
  let lastLoggedDroppedFrames = 0;
  let lastLoggedUnderruns = 0;
  const emit = (event) => {
    if (!destroyed) options.onEvent?.(event);
  };
  const publishTelemetry = () => {
    emit({ type: "stats", ...telemetry });
    const now = performance.now();
    if (now - lastTelemetryLogAt < 5e3 || telemetry.processedFrames < 100) return;
    const hasNewFallback = telemetry.lateFrames > lastLoggedLateFrames || telemetry.droppedFrames > lastLoggedDroppedFrames || telemetry.underruns > lastLoggedUnderruns;
    const detail = { ...telemetry };
    if (hasNewFallback) {
      logRuntime("warn", "AUDIO FALLBACK: late or missing frames used time-aligned raw audio.", detail);
    } else {
      logRuntime("info", "AUDIO STABLE", detail);
    }
    lastTelemetryLogAt = now;
    lastLoggedLateFrames = telemetry.lateFrames;
    lastLoggedDroppedFrames = telemetry.droppedFrames;
    lastLoggedUnderruns = telemetry.underruns;
  };
  const fail = (error) => {
    node.port.postMessage({ type: "worker-error" });
    rejectReady?.(error);
    rejectReady = null;
    logRuntime("error", "ERROR: worker initialisation or processing failed; audio is bypassed.", error);
    emit({ type: "error", error });
  };
  worker.onmessage = (event) => {
    const data = event.data;
    if (data.type === "ready") {
      resolveReady?.();
      resolveReady = null;
      rejectReady = null;
      logRuntime("info", "ACTIVE: DeepFilterNet3 worker is ready and filtering local microphone audio.", {
        sampleRate: audioContext.sampleRate,
        modelBytes: Number(data.modelBytes || 0)
      });
      emit({ type: "ready" });
      return;
    }
    if (data.type === "worker-stats") {
      telemetry.processedFrames = Number(data.processedFrames || 0);
      telemetry.avgFrameTimeMs = Number(data.avgFrameTimeMs || 0);
      telemetry.p95FrameTimeMs = Number(data.p95FrameTimeMs || 0);
      publishTelemetry();
      return;
    }
    if (data.type === "overload") {
      logRuntime("warn", "OVERLOAD: sustained processing load exceeded the real-time budget; using delayed raw audio during cooldown.", {
        avgFrameTimeMs: Number(data.avgFrameTimeMs || 0),
        rollingFrameTimeMs: Number(data.rollingFrameTimeMs || 0),
        overDeadlineStreak: Number(data.overDeadlineStreak || 0)
      });
      emit({ type: "overload", avgFrameTimeMs: Number(data.avgFrameTimeMs || 0) });
      return;
    }
    if (data.type === "recovering") {
      logRuntime("info", "RECOVERY: worker cooldown completed; warming model state on delayed raw audio.");
      return;
    }
    if (data.type === "recovered") {
      logRuntime("info", "RECOVERED: filtered output resumed with a short crossfade.");
      return;
    }
    if (data.type === "error") {
      const error = new Error(`[${String(data.phase || "worker")}] ${String(data.message || "DeepFilterNet3 worker failed")}`);
      if (data.stack) error.stack = `${error.stack}
Worker: ${String(data.stack)}`;
      fail(error);
    }
  };
  worker.onerror = (event) => fail(new Error(event.message || "DeepFilterNet3 worker failed"));
  node.port.onmessage = (event) => {
    const data = event.data;
    if (data.type === "primed") {
      resolvePrimed?.();
      resolvePrimed = null;
      return;
    }
    if (data.type === "telemetry") {
      telemetry.lateFrames = Number(data.lateFrames || 0);
      telemetry.droppedFrames = Number(data.droppedFrames || 0);
      telemetry.underruns = Number(data.underruns || 0);
      telemetry.queueDepth = Number(data.queueDepth || 0);
      telemetry.maxQueueDepth = Number(data.maxQueueDepth || 0);
      publishTelemetry();
    }
  };
  worker.postMessage({
    type: "init",
    ...assets,
    enabled: options.enabled !== false,
    suppressionLevel: clampLevel(options.suppressionLevel)
  });
  try {
    await ready;
  } catch (error) {
    worker.terminate();
    node.disconnect();
    URL.revokeObjectURL(workerUrl);
    throw error;
  }
  controllers.set(node, {
    setEnabled(enabled) {
      node.port.postMessage({ type: "enabled", enabled });
      worker.postMessage({ type: "enabled", enabled });
    },
    setSuppressionLevel(level) {
      worker.postMessage({ type: "suppression-level", level: clampLevel(level) });
    },
    waitUntilPrimed() {
      return primed;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      controllers.delete(node);
      resolvePrimed?.();
      resolvePrimed = null;
      node.port.postMessage({ type: "destroy" });
      worker.postMessage({ type: "destroy" });
      node.port.onmessage = null;
      node.disconnect();
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
    }
  });
  return node;
}
function controlDeepFilterRuntimeNode(node) {
  return controllers.get(node) || null;
}

// src/deepgram-vad.ts
var DEEPGRAM_PCM_SAMPLE_RATE = 16e3;
var DEEPGRAM_PCM_FRAME_MS = 20;
var PROCESSOR_NAME2 = "meetbridge-deepgram-vad-pcm";
var FRAME_POOL_SIZE = 64;
function clampNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}
function sourceFromBootstrap2(bootstrap) {
  return "(" + bootstrap.toString() + ")()";
}
function deepgramVadWorkletBootstrap() {
  class MeetBridgeDeepgramVadProcessor extends AudioWorkletProcessor {
    targetSampleRate;
    frameMs;
    frameSamples;
    preRollFrames;
    hangoverFrames;
    speechMarginDb;
    absoluteThresholdDbfs;
    closeHysteresisDb = 4;
    slotCount = 64;
    slotFrames;
    freeSlots;
    freeSlotCount;
    frameMessages;
    frameTransfers;
    currentSlot = -1;
    currentOffset = 0;
    currentEnergy = 0;
    preRollSlots;
    preRollSequences;
    preRollDbfs;
    preRollWrite = 0;
    preRollCount = 0;
    resamplePhase = 0;
    resampleSum = 0;
    resampleCount = 0;
    sequence = 0;
    speaking = false;
    attackFrames = 1;
    attackCount = 0;
    hangoverRemaining = 0;
    noiseFloorDbfs = -70;
    openThresholdDbfs = -55;
    destroyed = false;
    capturedFrames = 0;
    sentFrames = 0;
    suppressedFrames = 0;
    droppedFrames = 0;
    telemetryFrameCountdown;
    speechStartMessage = { type: "speech-state", speaking: true };
    speechEndMessage = { type: "speech-state", speaking: false };
    telemetryMessage;
    constructor(options) {
      super();
      const config = options.processorOptions;
      this.targetSampleRate = Math.max(8e3, Math.round(Number(config?.targetSampleRate) || 16e3));
      this.frameMs = Math.max(10, Math.round(Number(config?.frameMs) || 20));
      this.frameSamples = Math.max(1, Math.round(this.targetSampleRate * this.frameMs / 1e3));
      this.preRollFrames = Math.max(1, Math.round((Number(config?.preRollMs) || 160) / this.frameMs));
      this.hangoverFrames = Math.max(1, Math.round((Number(config?.hangoverMs) || 160) / this.frameMs));
      this.speechMarginDb = Math.max(3, Number(config?.speechMarginDb) || 10);
      this.absoluteThresholdDbfs = Math.max(-70, Math.min(-35, Number(config?.absoluteThresholdDbfs) || -55));
      this.slotFrames = [];
      this.freeSlots = new Int16Array(this.slotCount);
      this.frameMessages = [];
      this.frameTransfers = [];
      for (let index = 0; index < this.slotCount; index += 1) {
        const frame = new Int16Array(this.frameSamples);
        this.slotFrames.push(frame);
        this.freeSlots[index] = index;
        this.frameMessages.push({
          type: "audio",
          slotId: index,
          sequence: 0,
          captureTimestampMs: 0,
          dbfs: -120,
          samples: frame
        });
        this.frameTransfers.push([frame.buffer]);
      }
      this.freeSlotCount = this.slotCount;
      this.preRollSlots = new Int16Array(this.preRollFrames);
      this.preRollSlots.fill(-1);
      this.preRollSequences = new Float64Array(this.preRollFrames);
      this.preRollDbfs = new Float32Array(this.preRollFrames);
      this.telemetryFrameCountdown = Math.max(1, Math.round(5e3 / this.frameMs));
      this.telemetryMessage = {
        type: "stats",
        capturedFrames: 0,
        sentFrames: 0,
        suppressedFrames: 0,
        droppedFrames: 0,
        noiseFloorDbfs: -70,
        openThresholdDbfs: -55,
        speaking: false
      };
      this.port.onmessage = (event) => {
        const data = event.data;
        if (!data) return;
        if (data.type === "recycle") {
          const slotId = Number(data.slotId);
          if (!Number.isInteger(slotId) || slotId < 0 || slotId >= this.slotCount || !data.samples) return;
          if (this.slotFrames[slotId] !== null || this.freeSlotCount >= this.slotCount) return;
          this.slotFrames[slotId] = data.samples;
          this.freeSlots[this.freeSlotCount] = slotId;
          this.freeSlotCount += 1;
          return;
        }
        if (data.type === "destroy") this.destroyed = true;
      };
    }
    acquireSlot() {
      if (this.freeSlotCount <= 0) return -1;
      this.freeSlotCount -= 1;
      return this.freeSlots[this.freeSlotCount];
    }
    releaseLocalSlot(slotId) {
      if (slotId < 0 || slotId >= this.slotCount || !this.slotFrames[slotId]) return;
      if (this.freeSlotCount >= this.slotCount) return;
      this.freeSlots[this.freeSlotCount] = slotId;
      this.freeSlotCount += 1;
    }
    sendSlot(slotId, sequence, dbfs) {
      const frame = slotId >= 0 ? this.slotFrames[slotId] : null;
      if (!frame) {
        this.droppedFrames += 1;
        return;
      }
      const message = this.frameMessages[slotId];
      const transfer = this.frameTransfers[slotId];
      message.sequence = sequence;
      message.captureTimestampMs = sequence * this.frameMs;
      message.dbfs = dbfs;
      message.samples = frame;
      transfer[0] = frame.buffer;
      this.slotFrames[slotId] = null;
      this.sentFrames += 1;
      try {
        this.port.postMessage(message, transfer);
      } catch {
        this.slotFrames[slotId] = frame;
        this.releaseLocalSlot(slotId);
        this.sentFrames -= 1;
        this.droppedFrames += 1;
      }
    }
    pushPreRoll(slotId, sequence, dbfs) {
      if (slotId < 0) return;
      if (this.preRollCount >= this.preRollFrames) {
        const oldestSlot = this.preRollSlots[this.preRollWrite];
        this.releaseLocalSlot(oldestSlot);
        this.preRollCount -= 1;
      }
      this.preRollSlots[this.preRollWrite] = slotId;
      this.preRollSequences[this.preRollWrite] = sequence;
      this.preRollDbfs[this.preRollWrite] = dbfs;
      this.preRollWrite = (this.preRollWrite + 1) % this.preRollFrames;
      this.preRollCount += 1;
    }
    flushPreRoll() {
      let readIndex = (this.preRollWrite - this.preRollCount + this.preRollFrames) % this.preRollFrames;
      for (let count = 0; count < this.preRollCount; count += 1) {
        const slotId = this.preRollSlots[readIndex];
        this.sendSlot(slotId, this.preRollSequences[readIndex], this.preRollDbfs[readIndex]);
        this.preRollSlots[readIndex] = -1;
        readIndex = (readIndex + 1) % this.preRollFrames;
      }
      this.preRollCount = 0;
    }
    calculateOpenThreshold() {
      return Math.min(-35, Math.max(this.absoluteThresholdDbfs, this.noiseFloorDbfs + this.speechMarginDb));
    }
    finishFrame() {
      const slotId = this.currentSlot;
      const sequence = this.sequence;
      const rms = Math.sqrt(this.currentEnergy / this.frameSamples);
      const dbfs = rms > 1e-6 ? 20 * Math.log10(rms) : -120;
      this.capturedFrames += 1;
      this.sequence += 1;
      this.currentSlot = -1;
      this.currentOffset = 0;
      this.currentEnergy = 0;
      const openThreshold = this.calculateOpenThreshold();
      this.openThresholdDbfs = openThreshold;
      const closeThreshold = openThreshold - this.closeHysteresisDb;
      if (!this.speaking) {
        this.pushPreRoll(slotId, sequence, dbfs);
        if (dbfs >= openThreshold) {
          this.attackCount += 1;
        } else {
          this.attackCount = 0;
          const boundedDbfs = Math.max(-100, Math.min(-30, dbfs));
          this.noiseFloorDbfs = this.noiseFloorDbfs * 0.98 + boundedDbfs * 0.02;
        }
        if (this.attackCount >= this.attackFrames) {
          this.speaking = true;
          this.attackCount = 0;
          this.hangoverRemaining = this.hangoverFrames;
          this.port.postMessage(this.speechStartMessage);
          this.flushPreRoll();
        } else {
          this.suppressedFrames += 1;
        }
      } else {
        this.sendSlot(slotId, sequence, dbfs);
        if (dbfs >= closeThreshold) this.hangoverRemaining = this.hangoverFrames;
        else this.hangoverRemaining -= 1;
        if (this.hangoverRemaining <= 0) {
          this.speaking = false;
          this.hangoverRemaining = 0;
          this.port.postMessage(this.speechEndMessage);
        }
      }
      this.telemetryFrameCountdown -= 1;
      if (this.telemetryFrameCountdown <= 0) {
        this.telemetryFrameCountdown += Math.max(1, Math.round(5e3 / this.frameMs));
        const message = this.telemetryMessage;
        message.capturedFrames = this.capturedFrames;
        message.sentFrames = this.sentFrames;
        message.suppressedFrames = this.suppressedFrames;
        message.droppedFrames = this.droppedFrames;
        message.noiseFloorDbfs = this.noiseFloorDbfs;
        message.openThresholdDbfs = this.openThresholdDbfs;
        message.speaking = this.speaking;
        this.port.postMessage(message);
      }
    }
    writeTargetSample(sample) {
      if (this.currentOffset === 0) this.currentSlot = this.acquireSlot();
      const bounded = Math.max(-1, Math.min(1, sample));
      if (this.currentSlot >= 0) {
        const frame = this.slotFrames[this.currentSlot];
        if (frame) frame[this.currentOffset] = bounded < 0 ? bounded * 32768 : bounded * 32767;
      }
      this.currentEnergy += bounded * bounded;
      this.currentOffset += 1;
      if (this.currentOffset >= this.frameSamples) this.finishFrame();
    }
    process(inputs) {
      if (this.destroyed) return false;
      const input = inputs[0];
      const inputLength = input?.[0]?.length || 0;
      for (let index = 0; index < inputLength; index += 1) {
        let mono = 0;
        if (input?.length) {
          for (let channel = 0; channel < input.length; channel += 1) mono += input[channel]?.[index] || 0;
          mono /= input.length;
        }
        this.resampleSum += mono;
        this.resampleCount += 1;
        this.resamplePhase += this.targetSampleRate;
        if (this.resamplePhase >= sampleRate) {
          this.resamplePhase -= sampleRate;
          this.writeTargetSample(this.resampleSum / this.resampleCount);
          this.resampleSum = 0;
          this.resampleCount = 0;
        }
      }
      return true;
    }
  }
  registerProcessor("meetbridge-deepgram-vad-pcm", MeetBridgeDeepgramVadProcessor);
}
async function createDeepgramVadPcmStream(options) {
  if (typeof window === "undefined" || typeof AudioContext === "undefined" || typeof AudioWorkletNode === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined") {
    throw new Error("Deepgram speech-gated PCM requires AudioWorklet support");
  }
  if (!options.track || options.track.readyState !== "live") {
    throw new Error("Deepgram speech-gated PCM requires a live microphone track");
  }
  const preRollMs = Math.round(clampNumber(options.preRollMs, 160, 80, 400));
  const hangoverMs = Math.round(clampNumber(options.hangoverMs, 160, 120, 400));
  const clone = options.track.clone();
  clone.enabled = true;
  const context = new AudioContext({ sampleRate: 48e3, latencyHint: "interactive" });
  const moduleSource = sourceFromBootstrap2(deepgramVadWorkletBootstrap);
  const moduleUrl = URL.createObjectURL(new Blob([moduleSource], { type: "text/javascript" }));
  try {
    await context.audioWorklet.addModule(moduleUrl);
  } catch (error) {
    clone.stop();
    void context.close();
    throw error;
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
  const node = new AudioWorkletNode(context, PROCESSOR_NAME2, {
    channelCount: 1,
    channelCountMode: "explicit",
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: {
      targetSampleRate: DEEPGRAM_PCM_SAMPLE_RATE,
      frameMs: DEEPGRAM_PCM_FRAME_MS,
      preRollMs,
      hangoverMs,
      absoluteThresholdDbfs: clampNumber(options.absoluteThresholdDbfs, -55, -70, -35),
      speechMarginDb: clampNumber(options.speechMarginDb, 10, 3, 20)
    }
  });
  const source = context.createMediaStreamSource(new MediaStream([clone]));
  const silentSink = context.createGain();
  silentSink.gain.value = 0;
  const stats = {
    capturedFrames: 0,
    sentFrames: 0,
    suppressedFrames: 0,
    droppedFrames: 0,
    noiseFloorDbfs: -70,
    openThresholdDbfs: -55,
    speaking: false
  };
  let stopped = false;
  const recycleMessages = Array.from({ length: FRAME_POOL_SIZE }, (_, slotId) => ({
    type: "recycle",
    slotId,
    samples: null
  }));
  const recycleTransfers = Array.from({ length: FRAME_POOL_SIZE }, () => []);
  node.port.onmessage = (event) => {
    if (stopped) return;
    const data = event.data;
    if (!data) return;
    if (data.type === "audio" && data.samples) {
      const slotId = Number(data.slotId);
      const samples = data.samples;
      try {
        options.onAudioFrame(
          samples.buffer,
          Number(data.sequence || 0),
          Number(data.captureTimestampMs || 0),
          Number(data.dbfs || -120)
        );
      } catch (error) {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      } finally {
        if (!stopped && slotId >= 0 && slotId < recycleMessages.length) {
          const message = recycleMessages[slotId];
          const transfer = recycleTransfers[slotId];
          message.samples = samples;
          transfer[0] = samples.buffer;
          node.port.postMessage(message, transfer);
        }
      }
      return;
    }
    if (data.type === "speech-state") {
      stats.speaking = data.speaking === true;
      options.onSpeechState?.(stats.speaking);
      return;
    }
    if (data.type === "stats") {
      stats.capturedFrames = Number(data.capturedFrames || 0);
      stats.sentFrames = Number(data.sentFrames || 0);
      stats.suppressedFrames = Number(data.suppressedFrames || 0);
      stats.droppedFrames = Number(data.droppedFrames || 0);
      stats.noiseFloorDbfs = Number(data.noiseFloorDbfs || -70);
      stats.openThresholdDbfs = Number(data.openThresholdDbfs || -55);
      stats.speaking = data.speaking === true;
      options.onStats?.({ ...stats });
    }
  };
  node.onprocessorerror = () => {
    options.onError?.(new Error("Deepgram speech-gated PCM AudioWorklet failed"));
  };
  clone.onended = () => {
    if (!stopped) options.onError?.(new Error("Deepgram speech-gated microphone track ended"));
  };
  try {
    source.connect(node);
    node.connect(silentSink);
    silentSink.connect(context.destination);
    if (context.state === "suspended") await context.resume();
  } catch (error) {
    stopped = true;
    try {
      source.disconnect();
    } catch {
    }
    try {
      node.disconnect();
    } catch {
    }
    try {
      silentSink.disconnect();
    } catch {
    }
    clone.stop();
    void context.close();
    throw error;
  }
  console.info("[MeetBridge Deepgram VAD] ACTIVE: 20 ms speech-gated linear16 PCM is ready.", {
    sampleRate: DEEPGRAM_PCM_SAMPLE_RATE,
    preRollMs,
    hangoverMs
  });
  return {
    encoding: "linear16",
    sampleRate: DEEPGRAM_PCM_SAMPLE_RATE,
    channels: 1,
    getStats() {
      return { ...stats };
    },
    stop() {
      if (stopped) return;
      stopped = true;
      node.port.postMessage({ type: "destroy" });
      node.port.onmessage = null;
      node.onprocessorerror = null;
      source.disconnect();
      node.disconnect();
      silentSink.disconnect();
      clone.onended = null;
      clone.stop();
      void context.close();
    }
  };
}

// src/index.ts
var recommendedAudioCaptureOptions = {
  echoCancellation: true,
  autoGainControl: true,
  noiseSuppression: false,
  voiceIsolation: false,
  channelCount: { ideal: 1 },
  sampleRate: { ideal: DEEP_FILTER_SAMPLE_RATE }
};
var fallbackAudioCaptureOptions = {
  echoCancellation: true,
  autoGainControl: true,
  noiseSuppression: true,
  voiceIsolation: true,
  channelCount: { ideal: 1 },
  sampleRate: { ideal: DEEP_FILTER_SAMPLE_RATE }
};
function isNoiseFilterFeatureEnabled(value) {
  if (typeof value === "boolean") return value;
  return String(value || "").trim().toLowerCase() !== "off";
}
async function prepareDeepFilter(options = {}) {
  return preflightDeepFilterRuntime(options.assetBaseUrl);
}
function clampLevel2(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 70;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}
function warnOnce(message) {
  const key = "__meetbridgeDeepFilterWarningShown";
  const target = globalThis;
  if (target[key]) return;
  target[key] = true;
  console.warn(message);
}
var DeepFilterProcessor = class _DeepFilterProcessor extends EventTarget {
  name = "meetbridge-deepfilternet3";
  processedTrack;
  sourceNode = null;
  runtimeNode = null;
  destinationNode = null;
  destroyed = false;
  enabled;
  suppressionLevel;
  assetBaseUrl;
  latencyMode;
  stats = {
    processedFrames: 0,
    lateFrames: 0,
    avgFrameTimeMs: 0,
    p95FrameTimeMs: 0,
    // Updated in the constructor from the selected bounded transport profile
    // plus DF3's one-hop STFT delay and two-hop model lookahead.
    algorithmicLatencyMs: 50,
    droppedFrames: 0,
    underruns: 0,
    queueDepth: 0,
    maxQueueDepth: 0
  };
  constructor(options = {}) {
    super();
    this.enabled = options.enabled !== false;
    this.suppressionLevel = clampLevel2(options.suppressionLevel);
    this.assetBaseUrl = options.assetBaseUrl;
    this.latencyMode = resolveDeepFilterLatencyMode(options.latencyMode);
    this.stats.algorithmicLatencyMs = (deepFilterTransportHops(this.latencyMode) + 3) * 10;
  }
  static isSupported() {
    return canUseDeepFilterRuntime();
  }
  async init(options) {
    await this.connect(options);
  }
  async restart(options) {
    await this.disconnectGraph();
    await this.connect(options);
  }
  setSuppressionLevel(level) {
    this.suppressionLevel = clampLevel2(level);
    if (this.runtimeNode) controlDeepFilterRuntimeNode(this.runtimeNode)?.setSuppressionLevel(this.suppressionLevel);
  }
  setEnabled(enabled) {
    const nextEnabled = Boolean(enabled);
    if (this.enabled === nextEnabled) return;
    this.enabled = nextEnabled;
    if (this.runtimeNode) controlDeepFilterRuntimeNode(this.runtimeNode)?.setEnabled(this.enabled);
    console.info("[MeetBridge DeepFilterNet3] " + (this.enabled ? "ENABLED: processor will filter microphone audio." : "BYPASS: processor was disabled by the user."));
  }
  getStats() {
    return { ...this.stats };
  }
  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    await this.disconnectGraph();
  }
  async connect(options) {
    if (this.destroyed) return;
    if (!_DeepFilterProcessor.isSupported()) {
      const error = new Error("DeepFilterNet3 requires AudioWorklet and WebAssembly support");
      warnOnce("[MeetBridge DeepFilterNet3] AudioWorklet or WebAssembly is unavailable. Audio will use the browser fallback.");
      this.dispatchEvent(new CustomEvent("error", { detail: error }));
      throw error;
    }
    const settings = options.track.getSettings?.();
    if (settings?.noiseSuppression === true || settings?.voiceIsolation === true) {
      console.warn(
        "[MeetBridge DeepFilterNet3] Browser noise suppression or voice isolation is enabled. Use recommendedAudioCaptureOptions to prevent double suppression and speech distortion."
      );
    }
    try {
      this.sourceNode = options.audioContext.createMediaStreamSource(new MediaStream([options.track]));
      this.destinationNode = options.audioContext.createMediaStreamDestination();
      this.runtimeNode = await createDeepFilterRuntimeNode(options.audioContext, {
        enabled: this.enabled,
        suppressionLevel: this.suppressionLevel,
        assetBaseUrl: this.assetBaseUrl,
        latencyMode: this.latencyMode,
        onEvent: (event) => this.handleRuntimeEvent(event)
      });
      this.sourceNode.connect(this.runtimeNode);
      this.runtimeNode.connect(this.destinationNode);
      await controlDeepFilterRuntimeNode(this.runtimeNode)?.waitUntilPrimed();
      this.processedTrack = this.destinationNode.stream.getAudioTracks()[0];
      console.info("[MeetBridge DeepFilterNet3] TRACK ATTACHED: processed microphone track is ready for LiveKit publication.", {
        sourceTrackId: options.track.id,
        sampleRate: options.audioContext.sampleRate,
        latencyMode: this.latencyMode,
        algorithmicLatencyMs: this.stats.algorithmicLatencyMs
      });
    } catch (error) {
      await this.disconnectGraph();
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.dispatchEvent(new CustomEvent("error", { detail: normalized }));
      throw normalized;
    }
  }
  handleRuntimeEvent(event) {
    if (event.type === "ready") {
      this.dispatchEvent(new Event("ready"));
      return;
    }
    if (event.type === "overload") {
      this.stats.avgFrameTimeMs = event.avgFrameTimeMs;
      this.dispatchEvent(new CustomEvent("overload", { detail: this.getStats() }));
      return;
    }
    if (event.type === "stats") {
      this.stats.processedFrames = event.processedFrames;
      this.stats.lateFrames = event.lateFrames;
      this.stats.avgFrameTimeMs = event.avgFrameTimeMs || this.stats.avgFrameTimeMs;
      this.stats.p95FrameTimeMs = event.p95FrameTimeMs || this.stats.p95FrameTimeMs;
      this.stats.droppedFrames = event.droppedFrames;
      this.stats.underruns = event.underruns;
      this.stats.queueDepth = event.queueDepth;
      this.stats.maxQueueDepth = event.maxQueueDepth;
      return;
    }
    this.dispatchEvent(new CustomEvent("error", { detail: event.error }));
  }
  async disconnectGraph() {
    const runtime = this.runtimeNode;
    this.sourceNode?.disconnect();
    runtime?.disconnect();
    this.destinationNode?.disconnect();
    if (runtime) controlDeepFilterRuntimeNode(runtime)?.destroy();
    this.sourceNode = null;
    this.runtimeNode = null;
    this.destinationNode = null;
    this.processedTrack = void 0;
  }
};
async function createNoiseFilterNode(audioContext, options = {}) {
  return createDeepFilterRuntimeNode(audioContext, {
    ...options,
    suppressionLevel: clampLevel2(options.suppressionLevel)
  });
}
function destroyNoiseFilterNode(node) {
  controlDeepFilterRuntimeNode(node)?.destroy();
}
//# sourceMappingURL=index.cjs.map
