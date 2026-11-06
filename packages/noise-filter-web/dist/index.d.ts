import type { AudioCaptureOptions } from 'livekit-client';
import { DEEP_FILTER_HOP_SIZE, DEEP_FILTER_SAMPLE_RATE, deepFilterTransportHops, resolveDeepFilterLatencyMode, type DeepFilterLatencyMode } from './runtime';
export { createDeepgramVadPcmStream, DEEPGRAM_PCM_FRAME_MS, DEEPGRAM_PCM_SAMPLE_RATE, } from './deepgram-vad';
export type { DeepgramVadPcmStream, DeepgramVadPcmStreamOptions, DeepgramVadStats, } from './deepgram-vad';
export type DeepFilterEventName = 'overload' | 'ready' | 'error';
export interface DeepFilterStats {
    processedFrames: number;
    lateFrames: number;
    avgFrameTimeMs: number;
    p95FrameTimeMs: number;
    algorithmicLatencyMs: number;
    droppedFrames: number;
    underruns: number;
    queueDepth: number;
    maxQueueDepth: number;
}
export interface DeepFilterProcessorOptions {
    suppressionLevel?: number;
    enabled?: boolean;
    assetBaseUrl?: string;
    latencyMode?: DeepFilterLatencyMode;
}
export type CreateNoiseFilterNodeOptions = DeepFilterProcessorOptions;
export declare const recommendedAudioCaptureOptions: AudioCaptureOptions;
export declare const fallbackAudioCaptureOptions: AudioCaptureOptions;
export declare function isNoiseFilterFeatureEnabled(value?: string | boolean): boolean;
export declare function prepareDeepFilter(options?: Pick<DeepFilterProcessorOptions, 'assetBaseUrl'>): Promise<boolean>;
export declare class DeepFilterProcessor extends EventTarget {
    readonly name = "meetbridge-deepfilternet3";
    processedTrack?: MediaStreamTrack;
    private sourceNode;
    private runtimeNode;
    private destinationNode;
    private destroyed;
    private connectionId;
    private enabled;
    private suppressionLevel;
    private readonly assetBaseUrl?;
    private readonly latencyMode;
    private stats;
    constructor(options?: DeepFilterProcessorOptions);
    static isSupported(): boolean;
    init(options: {
        track: MediaStreamTrack;
        audioContext: AudioContext;
    }): Promise<void>;
    restart(options: {
        track: MediaStreamTrack;
        audioContext: AudioContext;
    }): Promise<void>;
    setSuppressionLevel(level: number): void;
    setEnabled(enabled: boolean): void;
    getStats(): DeepFilterStats;
    destroy(): Promise<void>;
    private connect;
    private handleRuntimeEvent;
    private disconnectGraph;
}
export declare function createNoiseFilterNode(audioContext: AudioContext, options?: CreateNoiseFilterNodeOptions): Promise<AudioWorkletNode>;
export declare function destroyNoiseFilterNode(node: AudioWorkletNode): void;
export { DEEP_FILTER_HOP_SIZE, DEEP_FILTER_SAMPLE_RATE, deepFilterTransportHops, resolveDeepFilterLatencyMode, };
export type { DeepFilterLatencyMode };
