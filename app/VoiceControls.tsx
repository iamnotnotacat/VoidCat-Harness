/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
"use client";

import { useRef, useState } from "react";
import { LocalMicrophoneRecorder } from "./voice-audio";
import { useNotifications } from "./NotificationCenter";

export function VoiceControls({ mode, onTranscript }: { mode: "push" | "toggle"; onTranscript: (text: string) => void }) {
  const { notify } = useNotifications(); const recorder = useRef<LocalMicrophoneRecorder | null>(null); const [state, setState] = useState<"idle" | "recording" | "transcribing">("idle");
  async function start() {
    if (state !== "idle") return; if (!window.voidcatDesktop?.voice) { notify({ tone: "warning", title: "Desktop voice unavailable", message: "Voice capture is only available inside the VoidCat desktop app." }); return; }
    try { await window.voidcatDesktop.voice.stop(); const next = new LocalMicrophoneRecorder(); recorder.current = next; await next.start(); setState("recording"); }
    catch (error) { recorder.current = null; notify({ tone: "error", title: "Microphone unavailable", message: error instanceof Error ? error.message : "Microphone capture failed." }); }
  }
  async function stop() {
    if (state !== "recording" || !recorder.current || !window.voidcatDesktop?.voice) return; setState("transcribing");
    try { const wav = await recorder.current.stop(); recorder.current = null; const result = await window.voidcatDesktop.voice.transcribe(wav); if (result.text) onTranscript(result.text); else notify({ tone: "warning", title: "No speech detected", message: "The local Whisper engine returned an empty transcript." }); }
    catch (error) { notify({ tone: "error", title: "Local transcription failed", message: error instanceof Error ? error.message : "The recording could not be transcribed." }); }
    finally { setState("idle"); }
  }
  const toggle = () => state === "recording" ? void stop() : state === "idle" ? void start() : undefined;
  return mode === "push" ? <button type="button" className={`voice-control ${state}`} disabled={state === "transcribing"} onPointerDown={() => void start()} onPointerUp={() => void stop()} onPointerCancel={() => void stop()} onPointerLeave={() => state === "recording" && void stop()}><b>{state === "recording" ? "●" : "MIC"}</b><span>{state === "transcribing" ? "TRANSCRIBING" : state === "recording" ? "RELEASE TO SEND" : "HOLD TO TALK"}</span></button> : <button type="button" className={`voice-control ${state}`} disabled={state === "transcribing"} onClick={toggle}><b>{state === "recording" ? "●" : "MIC"}</b><span>{state === "transcribing" ? "TRANSCRIBING" : state === "recording" ? "STOP + TRANSCRIBE" : "TOGGLE TALK"}</span></button>;
}
