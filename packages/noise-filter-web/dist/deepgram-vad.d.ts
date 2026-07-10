export declare const DEEPGRAM_PCM_SAMPLE_RATE = 16000;
export declare const DEEPGRAM_PCM_FRAME_MS = 20;
export interface DeepgramVadStats {
    capturedFrames: number;
    sentFrames: number;
    suppressedFrames: number;
    droppedFrames: number;
    noiseFloorDbfs: number;
    openThresholdDbfs: number;
    speaking: boolean;
}
export interface DeepgramVadPcmStreamOptions {
    track: MediaStreamTrack;
    preRollMs?: number;
    hangoverMs?: number;
    absoluteThresholdDbfs?: number;
    speechMarginDb?: number;
    onAudioFrame: (buffer: ArrayBuffer, sequence: number, captureTimestampMs: number, dbfs: number) => void;
    onSpeechState?: (speaking: boolean) => void;
    onStats?: (stats: DeepgramVadStats) => void;
    onError?: (error: Error) => void;
}
export interface DeepgramVadPcmStream {
    readonly encoding: 'linear16';
    readonly sampleRate: number;
    readonly channels: 1;
    getStats(): DeepgramVadStats;
    stop(): void;
}
export declare function createDeepgramVadPcmStream(options: DeepgramVadPcmStreamOptions): Promise<DeepgramVadPcmStream>;
