/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { MARITIME_REGIONS } from "./maritime-regions";

export function HunterSeekerCredentialModal({ credentialRequired, initialRegionId, onCancel, onSubmit }: {
  credentialRequired: boolean;
  initialRegionId: string;
  onCancel: () => void;
  onSubmit: (credential: string | undefined, regionId: string) => Promise<void>;
}) {
  const [credential, setCredential] = useState("");
  const [regionId, setRegionId] = useState(initialRegionId || "gulf-of-mexico");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (credentialRequired && !credential.trim()) { setError("Enter the API key issued by aisstream.io."); return; }
    setSubmitting(true);
    setError(null);
    try { await onSubmit(credential.trim() || undefined, regionId); }
    catch (submitError) { setError(submitError instanceof Error ? submitError.message : "The maritime credential could not be saved."); }
    finally { setSubmitting(false); }
  }

  return <div className="hunter-credential-backdrop" role="presentation" onMouseDown={onCancel}>
    <form className="hunter-credential-dialog" role="dialog" aria-modal="true" aria-labelledby="maritime-credential-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => void submit(event)}>
      <header><div><span>TIER 02 ACCESS GATE {"//"} FREE ACCOUNT</span><strong id="maritime-credential-title">{credentialRequired ? "ACTIVATE MARITIME LINK" : "MARITIME COVERAGE AREAS"}</strong></div><button aria-label="Close maritime setup" disabled={submitting} onClick={onCancel} type="button">×</button></header>
      <section className="hunter-credential-intro"><b>AIS</b><div><strong>AISSTREAM.IO VESSEL POSITIONS</strong><p>{credentialRequired ? "Create a free aisstream.io account, generate an API key, then paste it below. VoidCat encrypts it with Windows-protected storage and will reuse it on future launches." : "Choose the one maritime area to display. Your protected API key stays saved unless you enter a replacement."}</p></div></section>
      {credentialRequired && <a className="hunter-credential-signup" href="https://aisstream.io/customer.html" target="_blank" rel="noreferrer"><span>01</span><strong>GET FREE AISSTREAM CREDENTIAL</strong><b>OPEN OFFICIAL API KEYS PAGE ↗</b></a>}
      <label className="hunter-credential-field"><span>02 // {credentialRequired ? "API KEY" : "REPLACE API KEY (OPTIONAL)"}</span><input ref={inputRef} autoComplete="off" disabled={submitting} onChange={(event) => setCredential(event.currentTarget.value)} placeholder={credentialRequired ? "PASTE CREDENTIAL" : "LEAVE BLANK TO KEEP SAVED KEY"} spellCheck={false} type="password" value={credential} /></label>
      <label className="hunter-credential-field"><span>03 // COVERAGE REGION</span><select disabled={submitting} onChange={(event) => setRegionId(event.currentTarget.value)} value={regionId}>{MARITIME_REGIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><small>Only contacts inside the selected provider region will be loaded and displayed.</small></label>
      {error && <p className="hunter-credential-error">{error}</p>}
      <footer><span>SECRET VALUE NEVER RETURNS TO THE INTERFACE</span><div><button className="cancel-action" disabled={submitting} onClick={onCancel} type="button">CANCEL</button><button className="primary-action" disabled={submitting || (credentialRequired && !credential.trim())} type="submit">{submitting ? "SECURING..." : credentialRequired ? "SAVE & CONNECT" : "APPLY REGION"}</button></div></footer>
    </form>
  </div>;
}
