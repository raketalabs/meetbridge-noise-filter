export declare const DEEP_FILTER_SAMPLE_RATE = 48000;
export declare const DEEP_FILTER_HOP_SIZE = 480;
export type DeepFilterLatencyMode = 'low' | 'balanced' | 'resilient';
export interface DeepFilterRuntimeOptions {
    assetBaseUrl?: string;
    suppressionLevel?: number;
    enabled?: boolean;
    latencyMode?: DeepFilterLatencyMode;
    postFilter?: boolean;
    pauseSuppression?: boolean;
    onEvent?: (event: DeepFilterRuntimeEvent) => void;
}
export type DeepFilterRuntimeEvent = {
    type: 'ready';
} | {
    type: 'error';
    error: Error;
} | {
    type: 'overload';
    avgFrameTimeMs: number;
} | ({
    type: 'stats';
} & DeepFilterRuntimeStats);
export interface DeepFilterRuntimeStats {
    processedFrames: number;
    lateFrames: number;
    droppedFrames: number;
    underruns: number;
    queueDepth: number;
    maxQueueDepth: number;
    avgFrameTimeMs: number;
    p95FrameTimeMs: number;
}
interface RuntimeController {
    setEnabled(enabled: boolean): void;
    setSuppressionLevel(level: number): void;
    waitUntilPrimed(): Promise<void>;
    destroy(): void;
}
export declare function resolveDeepFilterLatencyMode(value: unknown): DeepFilterLatencyMode;
export declare function deepFilterTransportHops(mode: DeepFilterLatencyMode): 4 | 3 | 2;
export declare function getDeepFilterAssetUrls(assetBaseUrl?: string): {
    manifestUrl: string;
    moduleUrl: string;
    wasmUrl: string;
    modelUrl: string;
};
export declare function canUseDeepFilterRuntime(): boolean;
export declare function preflightDeepFilterRuntime(assetBaseUrl?: string): Promise<boolean>;
export declare function createDeepFilterRuntimeNode(audioContext: AudioContext, options?: DeepFilterRuntimeOptions): Promise<AudioWorkletNode>;
export declare function controlDeepFilterRuntimeNode(node: AudioWorkletNode): RuntimeController | null;
export {};
