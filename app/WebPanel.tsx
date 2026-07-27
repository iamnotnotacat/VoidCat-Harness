"use client";

import { useState } from "react";

export type VoidCatSettings = {
  webProvider: "duckduckgo" | "brave" | "tavily";
  hasWebApiKey: boolean;
  allowedDomains: string;
  blockedDomains: string;
  maxWebPages: number;
  maxWebBytes: number;
  memorySuggestions: boolean;
};

export function WebPanel({ settings, onSave }: {
  settings: VoidCatSettings;
  onSave: (settings: Partial<VoidCatSettings> & { webApiKey?: string }) => Promise<void>;
}) {
  const [provider, setProvider] = useState(settings.webProvider);
  const [apiKey, setApiKey] = useState("");
  const [allowedDomains, setAllowedDomains] = useState(settings.allowedDomains);
  const [blockedDomains, setBlockedDomains] = useState(settings.blockedDomains);
  const [maxWebPages, setMaxWebPages] = useState(settings.maxWebPages);
  const [maxWebBytes, setMaxWebBytes] = useState(settings.maxWebBytes);
  const [status, setStatus] = useState("");

  async function save() {
    setStatus("SAVING NETWORK RULES...");
    await onSave({ webProvider: provider, allowedDomains, blockedDomains, maxWebPages, maxWebBytes, ...(apiKey ? { webApiKey: apiKey } : {}) });
    setApiKey(""); setStatus("NETWORK RULES COMMITTED");
    window.setTimeout(() => setStatus(""), 2200);
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
        <button className="primary-action" onClick={() => void save()}>COMMIT NETWORK RULES</button>
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
