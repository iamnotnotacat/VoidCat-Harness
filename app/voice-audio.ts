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

export function conditionSpeechSamples(samples: Float32Array, sampleRate: number) {
  if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || samples.length < sampleRate / 5) throw new Error("The recording was too short to transcribe.");
  let peak = 0; let energy = 0;
  for (const sample of samples) { const absolute = Math.abs(sample); peak = Math.max(peak, absolute); energy += sample * sample; }
  const rms = Math.sqrt(energy / samples.length);
  if (peak < 0.003 || rms < 0.0006) throw new Error("No usable microphone signal was captured. Check the active Windows input device and microphone level.");

  const frameSize = Math.max(1, Math.round(sampleRate * 0.02));
  const threshold = Math.max(0.0025, Math.min(0.018, rms * 0.45));
  let firstActiveFrame = -1; let lastActiveFrame = -1; let activeFrames = 0;
  for (let start = 0, frame = 0; start < samples.length; start += frameSize, frame += 1) {
    const end = Math.min(samples.length, start + frameSize); let frameEnergy = 0;
    for (let index = start; index < end; index += 1) frameEnergy += samples[index] * samples[index];
    if (Math.sqrt(frameEnergy / (end - start)) < threshold) continue;
    if (firstActiveFrame < 0) firstActiveFrame = frame;
    lastActiveFrame = frame;
    activeFrames += 1;
  }
  if (activeFrames < 5 || firstActiveFrame < 0) throw new Error("The microphone signal was too quiet or brief to transcribe clearly.");

  const paddingFrames = 12;
  const firstSample = Math.max(0, (firstActiveFrame - paddingFrames) * frameSize);
  const lastSample = Math.min(samples.length, (lastActiveFrame + paddingFrames + 1) * frameSize);
  const conditioned = samples.slice(firstSample, lastSample);
  const gain = peak < 0.7 ? Math.min(4, 0.88 / peak) : 1;
  if (gain > 1.05) for (let index = 0; index < conditioned.length; index += 1) conditioned[index] = Math.max(-1, Math.min(1, conditioned[index] * gain));
  return conditioned;
}

export class LocalMicrophoneRecorder {
  private context: AudioContext | null = null; private stream: MediaStream | null = null; private source: MediaStreamAudioSourceNode | null = null; private processor: AudioWorkletNode | null = null; private silentOutput: GainNode | null = null; private chunks: Float32Array[] = []; private sourceRate = 48_000; private startedAt = 0; private readonly inputDeviceId: string;
  constructor(inputDeviceId = "") { this.inputDeviceId = inputDeviceId; }
  async start() {
    if (this.stream) throw new Error("Microphone capture is already active.");
    this.context = new AudioContext({ latencyHint: "interactive" });
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: { ideal: 1 }, deviceId: this.inputDeviceId ? { exact: this.inputDeviceId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (this.context.state === "suspended") await this.context.resume();
    if (this.context.state !== "running") throw new Error("The local audio engine could not start.");
    this.sourceRate = this.context.sampleRate; this.startedAt = Date.now(); this.chunks = [];
    this.source = this.context.createMediaStreamSource(this.stream);
    await this.context.audioWorklet.addModule("/voidcat-audio-worklet.js");
    this.processor = new AudioWorkletNode(this.context, "voidcat-recorder", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    this.silentOutput = this.context.createGain(); this.silentOutput.gain.value = 0;
    this.processor.port.onmessage = (event: MessageEvent<Float32Array>) => { if (Date.now() - this.startedAt <= 120_000 && event.data instanceof Float32Array) this.chunks.push(event.data); };
    this.source.connect(this.processor); this.processor.connect(this.silentOutput); this.silentOutput.connect(this.context.destination);
  }
  async stop() {
    if (!this.stream) throw new Error("Microphone capture is not active."); this.stream.getTracks().forEach((track) => track.stop()); this.source?.disconnect(); if (this.processor) this.processor.port.onmessage = null; this.processor?.disconnect(); this.silentOutput?.disconnect(); this.source = null; this.processor = null; this.silentOutput = null; await this.context?.close(); this.context = null; this.stream = null;
    const length = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0); const joined = new Float32Array(length); let offset = 0; for (const chunk of this.chunks) { joined.set(chunk, offset); offset += chunk.length; } this.chunks = [];
    return encodeMonoWav(resampleMono(conditionSpeechSamples(joined, this.sourceRate), this.sourceRate));
  }
  async cancel() { this.stream?.getTracks().forEach((track) => track.stop()); this.source?.disconnect(); if (this.processor) this.processor.port.onmessage = null; this.processor?.disconnect(); this.silentOutput?.disconnect(); await this.context?.close(); this.context = null; this.source = null; this.processor = null; this.silentOutput = null; this.stream = null; this.chunks = []; }
}
