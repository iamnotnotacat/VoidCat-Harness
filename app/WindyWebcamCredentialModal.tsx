/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";

export function WindyWebcamCredentialModal({ onCancel, onSubmit }: { onCancel: () => void; onSubmit: (credential: string) => Promise<void> }) {
  const [credential, setCredential] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!credential.trim()) { setError("Enter the API key issued by Windy Webcams."); return; }
    setSubmitting(true); setError("");
    try { await onSubmit(credential.trim()); }
    catch (submitError) { setError(submitError instanceof Error ? submitError.message : "The Windy credential could not be verified."); }
    finally { setSubmitting(false); }
  }
  return <div className="hunter-credential-backdrop" role="presentation" onMouseDown={onCancel}>
    <form className="hunter-credential-dialog hunter-webcam-credential-dialog" role="dialog" aria-modal="true" aria-labelledby="windy-credential-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => void submit(event)}>
      <header><div><span>TIER 02 ACCESS GATE {"//"} WINDY WEBCAMS</span><strong id="windy-credential-title">ACTIVATE WINDY CAMERA LAYER</strong></div><button aria-label="Close Windy webcam setup" disabled={submitting} onClick={onCancel} type="button">×</button></header>
      <section className="hunter-credential-intro"><b>CAM</b><div><strong>REGIONAL PUBLIC WEBCAMS</strong><p>Create a Windy Webcams API key, then paste it below. VoidCat verifies the key before Windows-protected storage accepts it. This layer remains separate from YouTube Live Cameras and may contain live, refreshed-image, or timelapse players.</p></div></section>
      <a className="hunter-credential-signup" href="https://api.windy.com/keys" target="_blank" rel="noopener noreferrer"><span>01</span><strong>GET WINDY WEBCAMS API KEY</strong><b>OPEN OFFICIAL KEY PAGE ↗</b></a>
      <label className="hunter-credential-field"><span>02 // API KEY</span><input ref={inputRef} autoComplete="off" disabled={submitting} onChange={(event) => setCredential(event.currentTarget.value)} placeholder="PASTE WINDY API KEY" spellCheck={false} type="password" value={credential} /><small>The secret remains in Electron's protected process and is never returned to the interface.</small></label>
      {error && <p className="hunter-credential-error">{error}</p>}
      <footer><span>INDEPENDENT LAYER // 15 MINUTE REGION CACHE</span><div><button className="cancel-action" disabled={submitting} onClick={onCancel} type="button">CANCEL</button><button className="primary-action" disabled={submitting || !credential.trim()} type="submit">{submitting ? "VERIFYING..." : "VERIFY, SAVE & ENABLE"}</button></div></footer>
    </form>
  </div>;
}
