/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";

export function PublicWebcamCredentialModal({ onCancel, onSubmit }: { onCancel: () => void; onSubmit: (credential: string) => Promise<void> }) {
  const [credential, setCredential] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!credential.trim()) { setError("Enter a Google Cloud API key with YouTube Data API v3 enabled."); return; }
    setSubmitting(true); setError("");
    try { await onSubmit(credential.trim()); }
    catch (submitError) { setError(submitError instanceof Error ? submitError.message : "The webcam credential could not be verified."); }
    finally { setSubmitting(false); }
  }

  return <div className="hunter-credential-backdrop" role="presentation" onMouseDown={onCancel}>
    <form className="hunter-credential-dialog hunter-webcam-credential-dialog" role="dialog" aria-modal="true" aria-labelledby="webcam-credential-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => void submit(event)}>
      <header><div><span>TIER 02 ACCESS GATE {"//"} YOUTUBE DATA API</span><strong id="webcam-credential-title">ACTIVATE TRUE LIVE VIDEO</strong></div><button aria-label="Close public live-video setup" disabled={submitting} onClick={onCancel} type="button">×</button></header>
      <section className="hunter-credential-intro"><b>LIVE</b><div><strong>REGIONAL CONTINUOUS VIDEO</strong><p>Enable YouTube Data API v3 in a Google Cloud project, create an API key, and select YouTube Data API v3 under API restrictions. Leave service-account authentication off. VoidCat verifies and protects the key. Only active, public, embeddable camera broadcasts appear.</p></div></section>
      <a className="hunter-credential-signup" href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noopener noreferrer"><span>01</span><strong>ENABLE YOUTUBE DATA API V3</strong><b>OPEN OFFICIAL API PAGE ↗</b></a>
      <a className="hunter-credential-signup" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer"><span>02</span><strong>CREATE AN API KEY</strong><b>OPEN OFFICIAL CREDENTIALS ↗</b></a>
      <label className="hunter-credential-field"><span>03 // API KEY</span><input ref={inputRef} autoComplete="off" disabled={submitting} onChange={(event) => setCredential(event.currentTarget.value)} placeholder="PASTE GOOGLE CLOUD API KEY" spellCheck={false} type="password" value={credential} /><small>The secret remains in Electron's protected process and is never returned to the interface.</small></label>
      {error && <p className="hunter-credential-error">{error}</p>}
      <footer><span>ON-DEMAND REGIONS // 50 RESULTS MAX // 15 MIN CACHE</span><div><button className="cancel-action" disabled={submitting} onClick={onCancel} type="button">CANCEL</button><button className="primary-action" disabled={submitting || !credential.trim()} type="submit">{submitting ? "VERIFYING..." : "VERIFY, SAVE & ENABLE"}</button></div></footer>
    </form>
  </div>;
}
