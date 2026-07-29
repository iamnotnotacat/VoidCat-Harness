/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
export function resampleMono(samples: Float32Array, fromRate: number, toRate = 16_000) {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate; const output = new Float32Array(Math.max(1, Math.floor(samples.length / ratio)));
  for (let index = 0; index < output.length; index += 1) {
    const start = Math.floor(index * ratio); const end = Math.max(start + 1, Math.min(samples.length, Math.floor((index + 1) * ratio))); let sum = 0;
    for (let source = start; source < end; source += 1) sum += samples[source]; output[index] = sum / (end - start);
  }
  return output;
}

export function encodeMonoWav(samples: Float32Array, sampleRate = 16_000) {
  const buffer = new ArrayBuffer(44 + samples.length * 2); const view = new DataView(buffer);
  const write = (offset: number, value: string) => { for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index)); };
  write(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); write(8, "WAVE"); write(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, "data"); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, Math.round(Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767)), true)); return buffer;
}

export class LocalMicrophoneRecorder {
  private context: AudioContext | null = null; private stream: MediaStream | null = null; private processor: ScriptProcessorNode | null = null; private chunks: Float32Array[] = []; private sourceRate = 48_000; private startedAt = 0;
  async start() {
    if (this.stream) throw new Error("Microphone capture is already active."); this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }); this.context = new AudioContext(); this.sourceRate = this.context.sampleRate; this.startedAt = Date.now(); this.chunks = [];
    const source = this.context.createMediaStreamSource(this.stream); this.processor = this.context.createScriptProcessor(4096, 1, 1); this.processor.onaudioprocess = (event) => { if (Date.now() - this.startedAt <= 120_000) this.chunks.push(new Float32Array(event.inputBuffer.getChannelData(0))); }; source.connect(this.processor); this.processor.connect(this.context.destination);
  }
  async stop() {
    if (!this.stream) throw new Error("Microphone capture is not active."); this.stream.getTracks().forEach((track) => track.stop()); this.processor?.disconnect(); this.processor = null; await this.context?.close(); this.context = null; this.stream = null;
    const length = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0); const joined = new Float32Array(length); let offset = 0; for (const chunk of this.chunks) { joined.set(chunk, offset); offset += chunk.length; } this.chunks = [];
    if (joined.length < this.sourceRate / 5) throw new Error("The recording was too short to transcribe."); return encodeMonoWav(resampleMono(joined, this.sourceRate));
  }
  async cancel() { this.stream?.getTracks().forEach((track) => track.stop()); this.processor?.disconnect(); await this.context?.close(); this.context = null; this.processor = null; this.stream = null; this.chunks = []; }
}
