// src/lib/types/audio-worklet.d.ts
// AudioWorklet global scope için minimal tipler

declare const sampleRate: number;

interface AudioWorkletProcessorOptions {
  processorOptions?: any;
}

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletProcessorOptions);
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: AudioWorkletProcessorOptions) => AudioWorkletProcessor
): void;
