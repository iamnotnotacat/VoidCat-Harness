/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */

export type VoidCatAnimationLevel = "off" | "low" | "medium" | "high";
export type VoidCatSfxCue =
  | "boot-start" | "boot-step" | "boot-complete"
  | "navigate" | "nav-open" | "item-select" | "setting-change"
  | "control-select" | "control-on" | "control-off" | "confirm"
  | "operation-start" | "operation-cancel" | "copy" | "delete" | "external-link"
  | "voice-start" | "voice-stop"
  | "warning" | "error"
  | "unit-load" | "unit-ready" | "unit-eject"
  | "thinking-start" | "thinking-stop"
  | "message-send" | "message-receive"
  | "layer-on" | "layer-off";

type AudioGraph = { dry: GainNode; wet: GainNode; compressor: DynamicsCompressorNode };

const SFX_EVENT = "voidcat:sfx";
const MASTER_VOLUME = 0.68;
let audioContext: AudioContext | null = null;
let audioGraph: AudioGraph | null = null;
let thinkingTimer: number | null = null;
let thinkingPhase = 0;

function context() {
  if (typeof window === "undefined" || !window.AudioContext) return null;
  audioContext ??= new window.AudioContext({ latencyHint: "interactive" });
  if (audioContext.state === "suspended") void audioContext.resume().catch(() => undefined);
  return audioContext;
}

function graph(ctx: AudioContext) {
  if (audioGraph) return audioGraph;
  const compressor = ctx.createDynamicsCompressor();
  const master = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const convolver = ctx.createConvolver();
  const impulseLength = Math.floor(ctx.sampleRate * 0.7);
  const impulse = ctx.createBuffer(2, impulseLength, ctx.sampleRate);
  for (let channelIndex = 0; channelIndex < impulse.numberOfChannels; channelIndex += 1) {
    const channel = impulse.getChannelData(channelIndex);
    for (let index = 0; index < channel.length; index += 1) channel[index] = (Math.random() * 2 - 1) * Math.pow(1 - index / channel.length, 5.2);
  }
  convolver.buffer = impulse;
  compressor.threshold.value = -27;
  compressor.knee.value = 8;
  compressor.ratio.value = 9;
  compressor.attack.value = 0.002;
  compressor.release.value = 0.15;
  master.gain.value = MASTER_VOLUME;
  dry.gain.value = 1;
  wet.gain.value = 0.2;
  dry.connect(compressor);
  wet.connect(convolver).connect(compressor);
  compressor.connect(master).connect(ctx.destination);
  audioGraph = { dry, wet, compressor };
  return audioGraph;
}

function route(ctx: AudioContext, wetAmount = 0) {
  const destination = graph(ctx);
  const input = ctx.createGain();
  input.connect(destination.dry);
  if (wetAmount > 0) {
    const send = ctx.createGain();
    send.gain.value = wetAmount;
    input.connect(send).connect(destination.wet);
  }
  return input;
}

function envelope(gain: GainNode, at: number, duration: number, peak: number, attack = 0.004, release = 0.75) {
  const decayStart = at + Math.min(duration * 0.42, Math.max(attack + 0.004, duration * (1 - release)));
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.linearRampToValueAtTime(Math.max(0.0002, peak), at + Math.min(attack, duration * 0.25));
  gain.gain.setValueAtTime(Math.max(0.0002, peak * 0.82), decayStart);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
}

function noise(ctx: AudioContext, at: number, duration: number, volume: number, filterType: BiquadFilterType, startHz: number, endHz: number, q = 1.1, wet = 0) {
  const frames = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let index = 0; index < frames; index += 1) {
    last = last * 0.2 + (Math.random() * 2 - 1) * 0.8;
    data[index] = last;
  }
  const source = ctx.createBufferSource();
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();
  source.buffer = buffer;
  filter.type = filterType;
  filter.Q.value = q;
  filter.frequency.setValueAtTime(Math.max(10, startHz), at);
  filter.frequency.exponentialRampToValueAtTime(Math.max(10, endHz), at + duration);
  envelope(gain, at, duration, volume, Math.min(0.008, duration * 0.2), 0.82);
  source.connect(filter).connect(gain).connect(route(ctx, wet));
  source.start(at);
}

function oscillator(ctx: AudioContext, at: number, duration: number, volume: number, startHz: number, endHz: number, type: OscillatorType, wet = 0) {
  const source = ctx.createOscillator();
  const gain = ctx.createGain();
  source.type = type;
  source.frequency.setValueAtTime(Math.max(10, startHz), at);
  source.frequency.exponentialRampToValueAtTime(Math.max(10, endHz), at + duration);
  envelope(gain, at, duration, volume, Math.min(0.018, duration * 0.2), 0.72);
  source.connect(gain).connect(route(ctx, wet));
  source.start(at);
  source.stop(at + duration + 0.02);
}

function contactor(ctx: AudioContext, at: number, weight = 1, wet = 0.05) {
  noise(ctx, at, 0.024, 0.08 * weight, "highpass", 4_900, 2_300, 2.8, wet);
  noise(ctx, at + 0.006, 0.075, 0.11 * weight, "bandpass", 980, 430, 3.2, wet);
  oscillator(ctx, at + 0.003, 0.085, 0.08 * weight, 94, 47, "sine", wet);
}

function packet(ctx: AudioContext, at: number, count: number, volume = 0.045, direction: "out" | "in" = "out") {
  for (let index = 0; index < count; index += 1) {
    const offset = at + index * 0.026 + (index % 3) * 0.004;
    const high = direction === "out" ? 4_800 - index * 190 : 2_100 + index * 260;
    const low = direction === "out" ? 1_500 + index * 90 : 4_300 - index * 130;
    noise(ctx, offset, 0.013 + (index % 2) * 0.006, volume * (1 - index / (count * 1.7)), "bandpass", high, low, 6.5, 0.02);
  }
}

function servo(ctx: AudioContext, at: number, duration: number, startHz: number, endHz: number, volume: number, wet = 0.08) {
  const carrier = ctx.createOscillator();
  const lfo = ctx.createOscillator();
  const lfoDepth = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();
  carrier.type = "sawtooth";
  carrier.frequency.setValueAtTime(startHz, at);
  carrier.frequency.exponentialRampToValueAtTime(endHz, at + duration);
  lfo.type = "triangle";
  lfo.frequency.value = 23;
  lfoDepth.gain.value = 5.5;
  lfo.connect(lfoDepth).connect(carrier.frequency);
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(520, at);
  filter.frequency.exponentialRampToValueAtTime(1_850, at + duration);
  filter.Q.value = 2.4;
  envelope(gain, at, duration, volume, 0.035, 0.34);
  carrier.connect(filter).connect(gain).connect(route(ctx, wet));
  carrier.start(at); lfo.start(at);
  carrier.stop(at + duration + 0.02); lfo.stop(at + duration + 0.02);
}

function transformer(ctx: AudioContext, at: number, duration: number, volume: number, powered: boolean) {
  const start = powered ? 34 : 76;
  const end = powered ? 76 : 28;
  oscillator(ctx, at, duration, volume, start, end, "sawtooth", 0.12);
  oscillator(ctx, at + 0.008, duration * 0.94, volume * 0.56, start * 2.01, end * 2.01, "sine", 0.08);
  noise(ctx, at, duration, volume * 0.22, "lowpass", powered ? 180 : 720, powered ? 1_100 : 120, 0.7, 0.12);
}

function valve(ctx: AudioContext, at: number, duration: number, volume: number) {
  noise(ctx, at, duration, volume, "highpass", 6_800, 850, 0.65, 0.18);
  noise(ctx, at + 0.018, duration * 0.9, volume * 0.45, "bandpass", 2_200, 340, 1.1, 0.22);
}

function stopThinking() {
  if (thinkingTimer !== null && typeof window !== "undefined") window.clearInterval(thinkingTimer);
  thinkingTimer = null;
  thinkingPhase = 0;
}

function thinkingPulse(ctx: AudioContext) {
  const at = ctx.currentTime + 0.012;
  const offset = thinkingPhase % 3;
  contactor(ctx, at, 0.18, 0);
  packet(ctx, at + 0.045, 2 + offset, 0.018, offset === 1 ? "in" : "out");
  if (offset === 2) noise(ctx, at + 0.09, 0.055, 0.014, "bandpass", 1_700, 720, 4.2, 0);
  thinkingPhase += 1;
}

function startThinking(ctx: AudioContext) {
  stopThinking();
  thinkingTimer = window.setInterval(() => thinkingPulse(ctx), 1_080);
  window.setTimeout(() => { if (thinkingTimer !== null) thinkingPulse(ctx); }, 320);
}

function alarmPulse(ctx: AudioContext, at: number) {
  oscillator(ctx, at, 0.28, 0.1, 286, 264, "sawtooth", 0.18);
  noise(ctx, at, 0.18, 0.035, "bandpass", 1_150, 680, 2.7, 0.12);
}

function play(cue: VoidCatSfxCue) {
  const ctx = context();
  if (!ctx) return;
  const at = ctx.currentTime + 0.014;

  if (cue === "thinking-start") { startThinking(ctx); return; }
  if (cue === "thinking-stop") { stopThinking(); return; }

  if (cue === "navigate") {
    noise(ctx, at, 0.018, 0.035, "highpass", 5_600, 2_900, 4.8, 0);
  } else if (cue === "nav-open") {
    packet(ctx, at, 4, 0.025, "in");
    oscillator(ctx, at + 0.015, 0.12, 0.025, 118, 156, "square", 0.03);
  } else if (cue === "item-select") {
    contactor(ctx, at, 0.31, 0.025);
    noise(ctx, at + 0.025, 0.075, 0.022, "bandpass", 2_800, 1_250, 5.2, 0.02);
  } else if (cue === "setting-change") {
    servo(ctx, at, 0.18, 86, 132, 0.018, 0.02);
    packet(ctx, at + 0.035, 2, 0.014, "in");
  } else if (cue === "control-select") {
    contactor(ctx, at, 0.27, 0);
  } else if (cue === "control-on") {
    contactor(ctx, at, 0.55, 0.04);
    transformer(ctx, at + 0.018, 0.18, 0.035, true);
  } else if (cue === "control-off") {
    transformer(ctx, at, 0.15, 0.03, false);
    contactor(ctx, at + 0.1, 0.5, 0.04);
  } else if (cue === "confirm") {
    contactor(ctx, at, 0.62, 0.08);
    packet(ctx, at + 0.055, 3, 0.025, "in");
  } else if (cue === "operation-start") {
    contactor(ctx, at, 0.62, 0.08);
    transformer(ctx, at + 0.014, 0.3, 0.042, true);
    packet(ctx, at + 0.055, 5, 0.02, "out");
  } else if (cue === "operation-cancel") {
    valve(ctx, at, 0.28, 0.043);
    contactor(ctx, at + 0.2, 0.5, 0.05);
  } else if (cue === "copy") {
    packet(ctx, at, 3, 0.023, "in");
    packet(ctx, at + 0.105, 3, 0.019, "out");
  } else if (cue === "delete") {
    contactor(ctx, at, 0.72, 0.11);
    noise(ctx, at + 0.022, 0.3, 0.045, "bandpass", 1_500, 95, 2.1, 0.13);
  } else if (cue === "external-link") {
    noise(ctx, at, 0.09, 0.032, "highpass", 6_400, 3_200, 5.6, 0.03);
    packet(ctx, at + 0.045, 5, 0.021, "out");
    contactor(ctx, at + 0.17, 0.34, 0.04);
  } else if (cue === "voice-start") {
    noise(ctx, at, 0.32, 0.048, "bandpass", 340, 4_800, 1.8, 0.07);
    oscillator(ctx, at + 0.045, 0.2, 0.02, 68, 104, "sawtooth", 0.06);
  } else if (cue === "voice-stop") {
    oscillator(ctx, at, 0.15, 0.019, 104, 54, "sawtooth", 0.04);
    noise(ctx, at + 0.035, 0.24, 0.043, "bandpass", 4_600, 260, 1.7, 0.08);
    contactor(ctx, at + 0.18, 0.3, 0.03);
  } else if (cue === "warning") {
    alarmPulse(ctx, at);
    alarmPulse(ctx, at + 0.39);
  } else if (cue === "error") {
    contactor(ctx, at, 0.85, 0.16);
    transformer(ctx, at + 0.015, 0.62, 0.09, false);
    noise(ctx, at + 0.05, 0.5, 0.055, "bandpass", 2_600, 120, 1.7, 0.25);
  } else if (cue === "boot-start") {
    transformer(ctx, at, 0.95, 0.08, true);
    servo(ctx, at + 0.08, 0.8, 38, 118, 0.04, 0.18);
    contactor(ctx, at + 0.09, 0.65, 0.12);
  } else if (cue === "boot-step") {
    contactor(ctx, at, 0.36, 0.04);
    packet(ctx, at + 0.03, 2, 0.018, "in");
  } else if (cue === "boot-complete") {
    contactor(ctx, at, 0.9, 0.22);
    transformer(ctx, at + 0.02, 0.48, 0.065, true);
    packet(ctx, at + 0.09, 7, 0.026, "in");
  } else if (cue === "unit-load") {
    contactor(ctx, at, 0.8, 0.16);
    transformer(ctx, at + 0.015, 1.15, 0.095, true);
    servo(ctx, at + 0.09, 1.05, 42, 176, 0.052, 0.16);
    noise(ctx, at + 0.16, 0.78, 0.035, "bandpass", 260, 3_600, 2.5, 0.18);
    contactor(ctx, at + 0.88, 0.45, 0.12);
  } else if (cue === "unit-ready") {
    contactor(ctx, at, 0.95, 0.24);
    packet(ctx, at + 0.065, 9, 0.03, "in");
    noise(ctx, at + 0.08, 0.3, 0.038, "bandpass", 480, 3_400, 2.8, 0.2);
  } else if (cue === "unit-eject") {
    contactor(ctx, at, 0.78, 0.18);
    valve(ctx, at + 0.025, 1.0, 0.072);
    servo(ctx, at + 0.08, 0.88, 164, 36, 0.047, 0.16);
    transformer(ctx, at + 0.18, 0.72, 0.07, false);
    contactor(ctx, at + 0.78, 0.52, 0.1);
  } else if (cue === "message-send") {
    contactor(ctx, at, 0.34, 0.02);
    packet(ctx, at + 0.025, 7, 0.032, "out");
    noise(ctx, at + 0.04, 0.19, 0.025, "bandpass", 4_600, 1_100, 3.8, 0.05);
  } else if (cue === "message-receive") {
    noise(ctx, at, 0.2, 0.032, "bandpass", 950, 4_200, 3.4, 0.08);
    packet(ctx, at + 0.028, 8, 0.03, "in");
    contactor(ctx, at + 0.19, 0.42, 0.08);
  } else if (cue === "layer-on") {
    contactor(ctx, at, 0.7, 0.09);
    noise(ctx, at + 0.018, 0.34, 0.04, "bandpass", 280, 3_100, 2.2, 0.12);
    transformer(ctx, at + 0.04, 0.3, 0.035, true);
  } else if (cue === "layer-off") {
    noise(ctx, at, 0.28, 0.036, "bandpass", 3_200, 190, 2.2, 0.1);
    transformer(ctx, at, 0.27, 0.032, false);
    contactor(ctx, at + 0.21, 0.68, 0.09);
  }
}

export function requestVoidCatSfx(cue: VoidCatSfxCue) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<VoidCatSfxCue>(SFX_EVENT, { detail: cue }));
}

export function installVoidCatSfx(enabled: boolean, _level: VoidCatAnimationLevel) {
  if (typeof window === "undefined") return () => undefined;
  void _level;
  const listener = (event: Event) => {
    const cue = (event as CustomEvent<VoidCatSfxCue>).detail;
    if (!enabled) { if (cue === "thinking-stop") stopThinking(); return; }
    play(cue);
  };
  window.addEventListener(SFX_EVENT, listener);
  return () => { window.removeEventListener(SFX_EVENT, listener); stopThinking(); };
}
