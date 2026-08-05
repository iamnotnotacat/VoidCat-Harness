/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNotifications } from "./NotificationCenter";
import type { HunterOsintDraft } from "./osint-hunter-types";
import { OsintInvestigationPanel } from "./OsintInvestigationPanel";

export type Provider = {
  id: string;
  displayName: string;
  description: string;
  transport: "local" | "safe-web" | "electron-broker";
  authentication: { kind: string; credentialNamespace?: string };
  capabilities: Array<{ id: string; description: string; seedTypes: string[]; sensitive: boolean }>;
  rateLimit: { requests: number; windowMs: number; maximumConcurrent: number };
  cache: { ttlMs: number; staleIfErrorMs: number };
  attribution: { provider: string; documentationUrl: string; termsUrl?: string };
  setup?: { acquisitionUrl: string; actionLabel: string; summary: string; steps: string[]; secondaryUrl?: string; secondaryLabel?: string };
  runtime: OsintProviderDesktopStatus;
};

type ProviderQueryResult = {
  investigationId: string;
  hunterForwarding: string;
  result: {
    evidence: Array<{ id: string; title: string; excerpt?: string; url?: string; sensitivity: string; cache: { status: string; ageMs: number } }>;
    entities: Array<{ id: string; type: string; displayName: string }>;
    observations: Array<{ id: string; confidence: number; coverageLimitations: string[] }>;
    leads: Array<{ id: string; reason: string; status: "candidate"; depth: number; seed: { type: string; value: string; label?: string }; discoveredByEvidenceIds: string[] }>;
    warnings: string[];
    coverageLimitations: string[];
    accounting: { entityCount: number; evidenceCount: number; evidenceBytes: number };
  };
};

type OsintStoreStatus = {
  schemaVersion: number;
  consistency: { valid: boolean; quickCheck: string; foreignKeyViolations: number; orphanedRows: number };
  cleanup: "available" | "approval-locked";
  records: { providerCache: number; rateLimits: number; invocationLogs: number; decisionLogs: number };
};

function formatDuration(milliseconds: number) {
  if (milliseconds < 60_000) return `${Math.ceil(milliseconds / 1_000)} SEC`;
  if (milliseconds < 3_600_000) return `${Math.ceil(milliseconds / 60_000)} MIN`;
  return `${Math.ceil(milliseconds / 3_600_000)} HR`;
}

function targetOptions(provider: Provider | undefined) {
  return [...new Set(provider?.capabilities.flatMap(({ seedTypes }) => seedTypes) ?? [])];
}

export function OsintProviderPanel({ onOpenHunter, hunterDraft, onAnalyzeWithUnit }: { onOpenHunter: () => void; hunterDraft?: HunterOsintDraft | null; onAnalyzeWithUnit?: (prompt: string) => void }) {
  const { notify } = useNotifications();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [storeStatus, setStoreStatus] = useState<OsintStoreStatus | null>(null);
  const [selectedId, setSelectedId] = useState(hunterDraft?.seed.type === "geographic-area" ? "deflock" : hunterDraft ? "searxng" : "opensquat-local");
  const [configuration, setConfiguration] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [targetType, setTargetType] = useState(hunterDraft?.seed.type ?? "domain");
  const [target, setTarget] = useState(hunterDraft?.seed.value ?? "");
  const [exposureApproved, setExposureApproved] = useState(false);
  const [authorizationStatement, setAuthorizationStatement] = useState("");
  const [queryResult, setQueryResult] = useState<ProviderQueryResult | null>(null);
  const [workspaceTab, setWorkspaceTab] = useState<"investigations" | "providers">("investigations");

  const load = useCallback(async () => {
    const response = await fetch("/api/osint/providers", { cache: "no-store" });
    const data = await response.json() as { providers?: Provider[]; store?: OsintStoreStatus; error?: string };
    if (!response.ok) throw new Error(data.error ?? "Provider status is unavailable.");
    setProviders(data.providers ?? []);
    setStoreStatus(data.store ?? null);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load().catch((error) => notify({ tone: "error", title: "Provider status unavailable", message: error instanceof Error ? error.message : "Provider status is unavailable." })); }, 0);
    return () => window.clearTimeout(timer);
  }, [load, notify]);
  const selected = providers.find(({ id }) => id === selectedId) ?? providers[0];
  const options = useMemo(() => targetOptions(selected), [selected]);
  const selectedTargetType = options.includes(targetType) ? targetType : options[0] ?? targetType;

  async function saveConfiguration(provider: Provider) {
    if (!window.voidcatDesktop?.osint || window.voidcatDesktop.bridgeVersion < 3) throw new Error("Restart VoidCat Harness once to activate the protected provider bridge.");
    setBusy(provider.id);
    try {
      await window.voidcatDesktop.osint.configure(provider.id, provider.id === "searxng" ? { endpoint: configuration } : provider.id === "censys" ? { "personal-access-token": configuration } : { "api-key": configuration });
      setConfiguration(""); await load();
      notify({ tone: "success", title: `${provider.displayName} saved`, message: "The value was encrypted by Windows and did not enter an investigation record." });
    } finally { setBusy(null); }
  }

  async function testProvider(provider: Provider) {
    if (!window.voidcatDesktop?.osint || window.voidcatDesktop.bridgeVersion < 3) throw new Error("Restart VoidCat Harness once to activate the protected provider bridge.");
    setBusy(provider.id);
    try { await window.voidcatDesktop.osint.test(provider.id); await load(); notify({ tone: "success", title: `${provider.displayName} verified`, message: "The provider accepted the protected configuration." }); }
    catch (error) { notify({ tone: "error", title: `${provider.displayName} test failed`, message: error instanceof Error ? error.message : "The provider did not accept the configuration." }); }
    finally { setBusy(null); }
  }

  async function removeProvider(provider: Provider) {
    if (!window.voidcatDesktop?.osint) throw new Error("The protected provider bridge is unavailable.");
    if (!window.confirm(`Remove the saved ${provider.displayName} configuration? Cached responses for this provider will also be cleared.`)) return;
    setBusy(provider.id);
    try { await window.voidcatDesktop.osint.remove(provider.id); await load(); notify({ tone: "success", title: `${provider.displayName} disconnected`, message: "The protected configuration and volatile provider cache were cleared." }); }
    finally { setBusy(null); }
  }

  async function authorizeNextUnitExposureCheck() {
    if (!target.trim()) return; setBusy("unit-exposure-approval");
    try {
      const response = await fetch("/api/osint/unit/exposure-approvals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: exposureApproved, targetType: selectedTargetType, exactTarget: target.trim(), authorizationStatement }) });
      const data = await response.json() as { expiresAt?: string; error?: string }; if (!response.ok) throw new Error(data.error ?? "The one-time UNIT authorization was not created.");
      notify({ tone: "success", title: "One-time UNIT check authorized", message: `The exact target is authorized once, until ${data.expiresAt ? new Date(data.expiresAt).toLocaleTimeString() : "the five-minute limit"}.` });
    } catch (approvalError) { notify({ tone: "error", title: "UNIT authorization held", message: approvalError instanceof Error ? approvalError.message : "The authorization was not created." }); }
    finally { setBusy(null); }
  }

  async function runQuery() {
    if (!selected || !target.trim()) return;
    setBusy(`query:${selected.id}`); setQueryResult(null);
    try {
      const isHibp = selected.id === "hibp";
      const response = await fetch("/api/osint/providers/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerId: selected.id, targetType: selectedTargetType, target: target.trim(), authorizationMode: isHibp ? "exposure-check" : "public-research", confirmed: isHibp && exposureApproved, exactTarget: isHibp ? target.trim() : undefined, authorizationStatement: isHibp ? authorizationStatement : undefined }) });
      const data = await response.json() as ProviderQueryResult & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Provider query failed.");
      setQueryResult(data); await load();
    } catch (error) { notify({ tone: "error", title: "Passive lookup held", message: error instanceof Error ? error.message : "The provider query failed." }); }
    finally { setBusy(null); }
  }

  async function submitCandidateToHunter(leadId: string) {
    if (!queryResult || queryResult.hunterForwarding === "blocked-pending-approval") return;
    setBusy(`candidate:${leadId}`);
    try {
      const response = await fetch("/api/osint/hunter/candidates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ investigationId: queryResult.investigationId, leadId }) });
      const data = await response.json() as { status?: string; error?: string };
      if (!response.ok || data.status !== "candidate") throw new Error(data.error ?? "The OSINT lead was not accepted as a Hunter candidate.");
      notify({ tone: "success", title: "Candidate submitted", message: "Hunter-Seeker received a review-only candidate. No watchlist, trigger, or provider request was created." });
      onOpenHunter();
    } catch (submissionError) { notify({ tone: "error", title: "Candidate handoff held", message: submissionError instanceof Error ? submissionError.message : "The OSINT lead was not accepted." }); }
    finally { setBusy(null); }
  }

  return <section className={`osint-provider-console tab-${workspaceTab}`}>
    <header><div><span>PASSIVE INTELLIGENCE CONTROL</span><h2>{workspaceTab === "investigations" ? "INVESTIGATION WORKSPACE" : "PROVIDER MATRIX"}</h2><p>{workspaceTab === "investigations" ? "Plan, run, review, graph, and export bounded passive investigations with exact evidence IDs." : "Credentials stay inside the protected desktop process. Provider results are bounded, normalized, cited, and cached without recording secrets."}</p></div><nav className="osint-workspace-tabs" aria-label="OSINT workspace tabs"><button className={workspaceTab === "investigations" ? "active" : ""} onClick={() => setWorkspaceTab("investigations")}>INVESTIGATIONS</button><button className={workspaceTab === "providers" ? "active" : ""} onClick={() => setWorkspaceTab("providers")}>PROVIDERS & API SETUP</button></nav><div className="osint-header-status"><b>{providers.filter(({ runtime }) => runtime.configured).length} / {providers.length} READY</b><small className={storeStatus?.consistency.valid ? "store-ready" : "store-held"}>{storeStatus?.consistency.valid ? `STORE V${storeStatus.schemaVersion} // ${storeStatus.records.providerCache} CACHE` : "STORE HELD"}</small></div></header>
    {workspaceTab === "investigations" ? <OsintInvestigationPanel key={hunterDraft?.requestedAt ?? "operator-investigation"} providers={providers} hunterDraft={hunterDraft} onAnalyzeWithUnit={onAnalyzeWithUnit} /> : <>
    {hunterDraft && <section className="osint-hunter-draft" aria-label="Hunter-Seeker investigation draft"><header><div><span>HUNTER-SEEKER INTAKE // {hunterDraft.seedKind.toUpperCase()}</span><strong>{hunterDraft.seed.label ?? hunterDraft.seed.value}</strong></div><b>AWAITING PROVIDER SELECTION</b></header><dl><div><dt>ORIGINAL OBSERVATION</dt><dd>{hunterDraft.originalHunterObservation?.observationId ?? "MAP REGION"}</dd></div><div><dt>PROVENANCE</dt><dd>{hunterDraft.originalHunterObservation?.provenance.sourceFeedId ?? "hunter-seeker-map-region"}</dd></div><div><dt>SEED TYPE</dt><dd>{hunterDraft.seed.type.toUpperCase()}</dd></div><div><dt>REQUESTED</dt><dd>{new Date(hunterDraft.requestedAt).toLocaleTimeString()}</dd></div></dl><p>{hunterDraft.objective}</p><small>DRAFT ONLY // NO PROVIDER REQUEST // NO WATCHLIST // NO TRIGGER</small></section>}
    <div className="osint-provider-layout">
      <div className="osint-provider-list">{providers.map((provider) => {
        const configured = provider.runtime.configured;
        return <article className={`${provider.id === selected?.id ? "selected" : ""} status-${provider.runtime.lastStatus}`} key={provider.id} onClick={() => { setSelectedId(provider.id); setTargetType(targetOptions(provider)[0] ?? "domain"); setQueryResult(null); }}>
          <header><i>{provider.id.slice(0, 2).toUpperCase()}</i><div><strong>{provider.displayName}</strong><small>{provider.transport === "local" ? "LOCAL / NO NETWORK" : provider.transport === "safe-web" ? "HUNTER MAP SOURCE" : "PROTECTED DESKTOP LINK"}</small></div><b>{configured ? provider.runtime.lastStatus === "degraded" ? "DEGRADED" : "READY" : "SETUP"}</b></header>
          <p>{provider.description}</p>
          <dl><div><dt>CAPABILITIES</dt><dd>{provider.capabilities.length}</dd></div><div><dt>CACHE</dt><dd>{provider.runtime.cacheEntries} / {formatDuration(provider.cache.ttlMs)}</dd></div><div><dt>RATE</dt><dd>{provider.rateLimit.requests} / {formatDuration(provider.rateLimit.windowMs)}</dd></div><div><dt>AUTH</dt><dd>{provider.authentication.kind.toUpperCase()}</dd></div></dl>
          {provider.runtime.lastError && <em>{provider.runtime.lastError}</em>}
        </article>;
      })}</div>
      {selected && <section className="osint-provider-detail">
        <header><div><span>SELECTED PROVIDER // {selected.id}</span><h3>{selected.displayName}</h3></div><a href={selected.attribution.documentationUrl} target="_blank" rel="noreferrer">OFFICIAL DOCS ↗</a></header>
        <div className="osint-capability-grid">{selected.capabilities.map((item) => <article key={item.id}><span>{item.sensitive ? "RESTRICTED" : "PASSIVE"}</span><strong>{item.id.replaceAll("-", " ").toUpperCase()}</strong><p>{item.description}</p><small>{item.seedTypes.join(" // ").toUpperCase()}</small></article>)}</div>
        {selected.id === "deflock" && <div className="osint-deflock-bridge"><strong>DEFLOCK IS A HUNTER-SEEKER MAP LAYER</strong><p>Turn it on in the live source matrix, then zoom to a region. The same cited camera observations become available for bounded OSINT analysis.</p><button onClick={onOpenHunter}>OPEN MAP LAYER</button></div>}
        {selected.setup && <section className="osint-provider-onboarding">
          <header><div><span>CONNECTION GUIDE</span><strong>{selected.runtime.configured ? "CONFIGURATION SAVED" : "SETUP REQUIRED"}</strong></div><b>{selected.id === "searxng" ? "INSTANCE URL" : "PROTECTED CREDENTIAL"}</b></header>
          <p>{selected.setup.summary}</p>
          <ol>{selected.setup.steps.map((step, index) => <li key={step}><i>{String(index + 1).padStart(2, "0")}</i><span>{step}</span></li>)}</ol>
          <div><a href={selected.setup.acquisitionUrl} target="_blank" rel="noreferrer">{selected.setup.actionLabel} ↗</a>{selected.setup.secondaryUrl && <a className="secondary" href={selected.setup.secondaryUrl} target="_blank" rel="noreferrer">{selected.setup.secondaryLabel} ↗</a>}</div>
          <small>THE OFFICIAL SITE OPENS IN YOUR NORMAL BROWSER // RETURN HERE TO SAVE AND VERIFY</small>
        </section>}
        {selected.authentication.credentialNamespace && <div className="osint-provider-config">
          <label><span>{selected.id === "searxng" ? "SEARXNG BASE URL" : selected.id === "censys" ? "PERSONAL ACCESS TOKEN" : "API KEY"}</span><input autoComplete="off" spellCheck={false} type={selected.id === "searxng" ? "url" : "password"} value={configuration} onChange={(event) => setConfiguration(event.currentTarget.value)} placeholder={selected.runtime.configured ? `SAVED // ${selected.runtime.fingerprint ?? "PROTECTED"}` : "ENTER VALUE"} /></label>
          <div><button disabled={!configuration.trim() || busy === selected.id} onClick={() => void saveConfiguration(selected).catch((error) => notify({ tone: "error", title: "Configuration not saved", message: error instanceof Error ? error.message : "Configuration not saved." }))}>SAVE PROTECTED VALUE</button><button disabled={!selected.runtime.configured || busy === selected.id} onClick={() => void testProvider(selected)}>TEST LIVE</button><button className="danger" disabled={!selected.runtime.configured || busy === selected.id} onClick={() => void removeProvider(selected)}>REMOVE</button></div>
          <small>THE SAVED VALUE NEVER RETURNS TO THIS SCREEN, BACKEND RECORDS, LOGS, SHOWN URLS, OR REPORTS.</small>
        </div>}
        <div className="osint-query-console">
          <header><span>BOUNDED NORMALIZATION CHECK</span><b>{selected.runtime.nextAllowedAt ? `GUARDED UNTIL ${new Date(selected.runtime.nextAllowedAt).toLocaleTimeString()}` : "READY"}</b></header>
          <div><label><span>TARGET TYPE</span><select value={selectedTargetType} onChange={(event) => setTargetType(event.currentTarget.value)}>{options.map((value) => <option value={value} key={value}>{value.replaceAll("-", " ").toUpperCase()}</option>)}</select></label><label><span>EXACT TARGET</span><input value={target} onChange={(event) => setTarget(event.currentTarget.value)} placeholder={selectedTargetType === "domain" ? "example.com" : selectedTargetType.replaceAll("-", " ")} /></label></div>
          {selected.id === "hibp" && <div className="osint-exposure-gate"><label><input type="checkbox" checked={exposureApproved} onChange={(event) => setExposureApproved(event.currentTarget.checked)} />I AM AUTHORIZED TO CHECK THIS EXACT TARGET</label><textarea value={authorizationStatement} onChange={(event) => setAuthorizationStatement(event.currentTarget.value)} placeholder="State your authorization for this exact email address or verified domain." /><button disabled={!exposureApproved || authorizationStatement.trim().length < 12 || !target.trim() || busy === "unit-exposure-approval"} onClick={() => void authorizeNextUnitExposureCheck()}>{busy === "unit-exposure-approval" ? "AUTHORIZING..." : "AUTHORIZE NEXT UNIT CHECK"}</button><small>ONE EXACT TARGET // ONE USE // EXPIRES IN 5 MIN // THE UNIT CANNOT CREATE THIS APPROVAL</small><small>THE EXACT TARGET IS SENT TO HIBP // NO DISCOVERED EMAIL EXPANSION // SENSITIVE EVIDENCE REDACTED // HUNTER FORWARDING BLOCKED</small></div>}
          <button disabled={!target.trim() || busy === `query:${selected.id}` || (selected.id === "hibp" && (!exposureApproved || authorizationStatement.trim().length < 12)) || (selected.transport === "electron-broker" && !selected.runtime.configured)} onClick={() => void runQuery()}>{busy === `query:${selected.id}` ? "ACQUIRING..." : selected.transport === "local" || selected.id === "deflock" ? "RUN LOCAL CHECK" : "RUN PASSIVE CHECK"}</button>
        </div>
        {queryResult && <div className="osint-result-deck">
          <header><span>NORMALIZED RESULT // {queryResult.investigationId}</span><b>{queryResult.result.accounting.evidenceCount} EVIDENCE // {queryResult.result.accounting.entityCount} ENTITIES</b></header>
          {queryResult.hunterForwarding === "blocked-pending-approval" && <strong className="osint-forwarding-block">HUNTER FORWARDING BLOCKED PENDING SEPARATE APPROVAL</strong>}
          {queryResult.result.evidence.map((evidence) => <article key={evidence.id}><span>{evidence.sensitivity.toUpperCase()} // {evidence.cache.status.toUpperCase()}</span><strong>{evidence.title}</strong><p>{evidence.excerpt ?? "No excerpt returned."}</p>{evidence.url && <a href={evidence.url} target="_blank" rel="noreferrer">OPEN EVIDENCE ↗</a>}</article>)}
          {queryResult.result.leads.length > 0 && <section className="osint-candidate-leads"><header><span>CONTROLLED EXPANSION</span><strong>CANDIDATE LEADS // OPERATOR APPROVAL REQUIRED</strong></header>{queryResult.result.leads.map((lead) => <article key={lead.id}><div><b>CANDIDATE // DEPTH {lead.depth}</b><strong>{lead.seed.label ?? lead.seed.value}</strong><p>{lead.reason}</p><small>{lead.seed.type.toUpperCase()} // {lead.discoveredByEvidenceIds.length} SUPPORTING EVIDENCE ID(S)</small></div><button disabled={busy === `candidate:${lead.id}` || queryResult.hunterForwarding === "blocked-pending-approval"} onClick={() => void submitCandidateToHunter(lead.id)}>{busy === `candidate:${lead.id}` ? "SUBMITTING..." : "SUBMIT CANDIDATE TO HUNTER"}</button></article>)}</section>}
          {queryResult.result.coverageLimitations.map((value) => <small key={value}>LIMITATION // {value}</small>)}
        </div>}
      </section>}
    </div></>}
  </section>;
}
