/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
"use client";

import { useState } from "react";
import { useNotifications } from "./NotificationCenter";
import type { HunterWorkspaceSettings } from "../build/hunter-seeker/source-workspace";

export type VoidCatSettings = {
  webProvider: "duckduckgo" | "brave" | "tavily";
  hasWebApiKey: boolean;
  allowedDomains: string;
  blockedDomains: string;
  maxWebPages: number;
  maxWebBytes: number;
  memorySuggestions: boolean;
  hunterSetupCompleted: boolean;
  hunterSetupStep: number;
  hunterSourceSettings: Record<string, { enabled: boolean; pollCadenceMs: number; requestBudgetPercent: number }>;
  hunterWorkspace: HunterWorkspaceSettings;
  hunterHistory: { enabled: boolean; retentionDays: number; selectedLibraryIds: string[]; includeUploads: boolean };
  commandToolNames: string[];
  voiceProfile: VoiceProfile;
  voiceSpeed: number;
  spokenResponses: boolean;
  voiceInputMode: "push" | "toggle";
  voiceInputDeviceId: string;
  voiceOutputDeviceId: string;
  soundEffectsEnabled: boolean;
  animationLevel: "off" | "low" | "medium" | "high";
  resourceProfile: "quiet" | "normal" | "maximum";
};

export function WebPanel({ settings, onSave }: {
  settings: VoidCatSettings;
  onSave: (settings: Partial<VoidCatSettings> & { webApiKey?: string }) => Promise<void>;
}) {
  const { notify } = useNotifications();
  const [provider, setProvider] = useState(settings.webProvider);
  const [apiKey, setApiKey] = useState("");
  const [allowedDomains, setAllowedDomains] = useState(settings.allowedDomains);
  const [blockedDomains, setBlockedDomains] = useState(settings.blockedDomains);
  const [maxWebPages, setMaxWebPages] = useState(settings.maxWebPages);
  const [maxWebBytes, setMaxWebBytes] = useState(settings.maxWebBytes);
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (saving) return;
    setSaving(true);
    setStatus("SAVING NETWORK RULES...");
    try {
      await onSave({ webProvider: provider, allowedDomains, blockedDomains, maxWebPages, maxWebBytes, ...(apiKey ? { webApiKey: apiKey } : {}) });
      setApiKey(""); setStatus("NETWORK RULES COMMITTED");
      notify({ tone: "success", title: "Network rules committed", message: `${provider.toUpperCase()} is configured with the current domain and request limits.` });
      window.setTimeout(() => setStatus(""), 2200);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Network rules could not be saved.";
      setStatus(message);
      notify({ tone: "error", title: "Network settings failed", message });
    } finally {
      setSaving(false);
    }
  }

  return <section className="phase-panel web-panel">
    <div className="phase-heading"><div><p className="kicker">EXTERNAL INTELLIGENCE {"//"} OPERATOR GOVERNED</p><h2>WEB ACCESS</h2></div><span className="phase-counter">GUARDED LINK</span></div>
    <div className="web-layout">
      <div className="web-settings-card">
        <span>SEARCH PROVIDER</span>
        <label>PROVIDER<select value={provider} onChange={(event) => setProvider(event.target.value as VoidCatSettings["webProvider"])}><option value="duckduckgo">DUCKDUCKGO // NO KEY</option><option value="brave">BRAVE SEARCH API</option><option value="tavily">TAVILY SEARCH API</option></select></label>
        {provider !== "duckduckgo" && <label>API KEY<input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={settings.hasWebApiKey ? "KEY STORED // ENTER TO REPLACE" : "ENTER PROVIDER KEY"} /></label>}
        <div className="web-limit-grid"><label>PAGES PER SEARCH<select value={maxWebPages} onChange={(event) => setMaxWebPages(Number(event.target.value))}>{[1, 2, 3, 4, 5].map((value) => <option value={value} key={value}>{value}</option>)}</select></label><label>MAX PAGE SIZE<select value={maxWebBytes} onChange={(event) => setMaxWebBytes(Number(event.target.value))}><option value={250000}>250 KB</option><option value={500000}>500 KB</option><option value={1000000}>1 MB</option><option value={2000000}>2 MB</option><option value={3000000}>3 MB</option></select></label></div>
        <label>DOMAIN ALLOWLIST <small>OPTIONAL // ONE PER LINE</small><textarea value={allowedDomains} onChange={(event) => setAllowedDomains(event.target.value)} placeholder="Leave empty to permit public websites" /></label>
        <label>DOMAIN BLOCKLIST <small>ONE PER LINE</small><textarea value={blockedDomains} onChange={(event) => setBlockedDomains(event.target.value)} placeholder="example.com" /></label>
        <button className="primary-action" onClick={() => void save()} disabled={saving}>{saving ? "COMMITTING..." : "COMMIT NETWORK RULES"}</button>
        {status && <p className="web-save-status">{status}</p>}
      </div>
      <div className="web-safety-grid">
        <article><b>01</b><span>PER-CHAT AUTHORITY</span><strong>OFF / ASK / AUTO</strong><p>Every conversation carries its own web mode. ASK pauses before a query leaves this PC.</p></article>
        <article><b>02</b><span>NETWORK CONTAINMENT</span><strong>PUBLIC WEB ONLY</strong><p>Local, private, loopback, credentialed, and non-HTTP destinations are rejected before fetching.</p></article>
        <article><b>03</b><span>CONTENT BOUNDARY</span><strong>TEXT EVIDENCE ONLY</strong><p>Downloads and binary responses are blocked. Page and redirect limits are enforced.</p></article>
        <article><b>04</b><span>INJECTION DEFENSE</span><strong>UNTRUSTED INPUT</strong><p>Instruction-like webpage text is removed and all remaining content is labeled as untrusted evidence.</p></article>
      </div>
    </div>
  </section>;
}
