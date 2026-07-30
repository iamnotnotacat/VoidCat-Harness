/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { LocalMicrophoneRecorder } from "./voice-audio";
import { useNotifications } from "./NotificationCenter";

type VoiceCaptureState = "idle" | "starting" | "recording" | "transcribing";
const MAX_RECORDING_MS = 120_000;

function microphoneErrorMessage(error: unknown) {
  if (!(error instanceof DOMException)) return error instanceof Error ? error.message : "Microphone capture failed.";
  if (error.name === "NotAllowedError" || error.name === "SecurityError") return "Microphone access was blocked. Enable microphone access for desktop apps in Windows Privacy & security settings, then try again.";
  if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") return "No microphone was found. Connect or enable a microphone, then try again.";
  if (error.name === "NotReadableError" || error.name === "TrackStartError") return "The microphone is busy or unavailable. Close other apps using it, then try again.";
  if (error.name === "OverconstrainedError" || error.name === "ConstraintNotSatisfiedError") return "The selected microphone is no longer available. Choose another input in App Settings and refresh the device list.";
  return error.message || "Microphone capture failed.";
}

export function VoiceControls({ inputDeviceId, onTranscript }: { inputDeviceId: string; onTranscript: (text: string) => void }) {
  const { notify } = useNotifications();
  const recorder = useRef<LocalMicrophoneRecorder | null>(null);
  const operationActive = useRef(false);
  const recordingTimer = useRef<number | null>(null);
  const [state, setState] = useState<VoiceCaptureState>("idle");

  function clearRecordingTimer() {
    if (recordingTimer.current !== null) window.clearTimeout(recordingTimer.current);
    recordingTimer.current = null;
  }

  async function finishRecording() {
    const activeRecorder = recorder.current;
    if (!activeRecorder || operationActive.current) return;
    operationActive.current = true;
    recorder.current = null;
    clearRecordingTimer();
    setState("transcribing");
    try {
      const wav = await activeRecorder.stop();
      const result = await window.voidcatDesktop?.voice.transcribe(wav);
      const transcript = result?.text.trim() ?? "";
      if (transcript) {
        onTranscript(transcript);
        notify({ tone: "success", title: "Local transcript ready", message: "Speech was added to the command input." });
      } else {
        notify({ tone: "warning", title: "No speech detected", message: "Whisper received the recording but did not detect clear speech. Check the active Windows input device and try speaking closer to the microphone." });
      }
    } catch (error) {
      notify({ tone: "error", title: "Local transcription failed", message: error instanceof Error ? error.message : "The recording could not be transcribed." });
    } finally {
      operationActive.current = false;
      setState("idle");
    }
  }
  async function startRecording() {
    if (operationActive.current || recorder.current) return;
    if (!window.voidcatDesktop?.voice) {
      notify({ tone: "warning", title: "Desktop voice unavailable", message: "Voice capture is only available inside the VoidCat desktop app." });
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      notify({ tone: "error", title: "Microphone unavailable", message: "This system does not expose a microphone capture interface." });
      return;
    }

    operationActive.current = true;
    setState("starting");
    const nextRecorder = new LocalMicrophoneRecorder(inputDeviceId);
    recorder.current = nextRecorder;
    try {
      const speechStop = window.voidcatDesktop.voice.stop().catch(() => ({ stopped: true as const }));
      await nextRecorder.start();
      await speechStop;
      operationActive.current = false;
      setState("recording");
      recordingTimer.current = window.setTimeout(() => { void finishRecording(); }, MAX_RECORDING_MS);
    } catch (error) {
      await nextRecorder.cancel();
      recorder.current = null;
      operationActive.current = false;
      setState("idle");
      notify({ tone: "error", title: "Microphone unavailable", message: microphoneErrorMessage(error) });
    }
  }

  useEffect(() => () => {
    clearRecordingTimer();
    const activeRecorder = recorder.current;
    recorder.current = null;
    if (activeRecorder) void activeRecorder.cancel();
  }, []);

  const recording = state === "recording";
  const disabled = state === "starting" || state === "transcribing";
  const label = state === "starting" ? "OPENING MIC" : state === "transcribing" ? "TRANSCRIBING" : recording ? "STOP + TRANSCRIBE" : "START TALKING";

  return <button
    type="button"
    className={`voice-control ${state}`}
    disabled={disabled}
    aria-pressed={recording}
    aria-label={recording ? "Stop recording and transcribe speech" : "Start recording speech"}
    data-sfx={recording ? "voice-stop" : "voice-start"}
    title={inputDeviceId ? "Using the selected App Settings microphone" : "Using the Windows default microphone"}
    onClick={() => recording ? void finishRecording() : void startRecording()}
  >
    <b aria-hidden="true">{recording ? "●" : "MIC"}</b>
    <span>{label}</span>
  </button>;
}
