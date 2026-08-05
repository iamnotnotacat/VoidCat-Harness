/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import { useEffect, useMemo, useState } from "react";
import type { HunterMapViewport } from "./HunterSeekerMap";

export type HunterQueryCatalogSource = {
  id: string; name: string; description: string; documentationUrl: string; providerUrl?: string; mode: string; auth: string; limitation: string; license: string;
};
export type HunterQueryCapability = { sourceId: string; capability: string; requires: Array<"bbox" | "point" | "query" | "resource" | "time-window">; credentialBroker: boolean };

const CREDENTIAL_FIELDS: Record<string, string[]> = {
  "gdelt.events": ["project-id", "access-token"], "acled.events": ["access-token"], "ucdp.ged": ["api-token"], "reliefweb.reports": ["app-name"], "noaa.cdo": ["api-token"], "openaq.measurements": ["api-key"], "epa.airnow": ["api-key"], "gfw.alerts": ["access-token"], "copernicus.dataspace": ["access-token"], "gfw.fishing": ["access-token"], "mobility.database": ["api-key"],
};
const DEFAULT_RESOURCES: Record<string, string> = { "noaa.cdo": "GHCND", "noaa.ncei": "USW00013967", "epa.envirofacts": "TX", "osm.overpass": "hospitals", "ripe.stat": "AS3333" };
const DEFAULT_QUERIES: Record<string, string> = { "jrc.catalog": "disaster", "faa.portal": "airports", "gbfs.registry": "US", "overture.maps": "places", "reliefweb.reports": "humanitarian emergency", "mobility.database": "transit" };

function localDateTime(value: Date) { return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); }
const QUERY_WINDOW_END = new Date();
const DEFAULT_QUERY_END = localDateTime(QUERY_WINDOW_END);
const DEFAULT_QUERY_START = localDateTime(new Date(QUERY_WINDOW_END.getTime() - 7 * 24 * 60 * 60_000));
function protectedDesktop() { const desktop = window.voidcatDesktop; if (!desktop?.osint) throw new Error("Protected desktop credential storage is unavailable. Start VoidCat from its desktop launcher."); return desktop; }

export function HunterSourceQueryModal({ source, capability, viewport, onClose, onComplete }: { source: HunterQueryCatalogSource; capability: HunterQueryCapability; viewport: HunterMapViewport; onClose: () => void; onComplete: (snapshot: unknown, summary: string) => void }) {
  const [query, setQuery] = useState(DEFAULT_QUERIES[source.id] ?? source.name);
  const [resource, setResource] = useState(DEFAULT_RESOURCES[source.id] ?? "");
  const [startAt, setStartAt] = useState(DEFAULT_QUERY_START);
  const [endAt, setEndAt] = useState(DEFAULT_QUERY_END);
  const [credentialValues, setCredentialValues] = useState<Record<string, string>>({});
  const [configured, setConfigured] = useState(!capability.credentialBroker);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [busy, setBusy] = useState<"status" | "save" | "test" | "remove" | "query" | null>("status");
  const [error, setError] = useState<string | null>(null);
  const credentialFields = CREDENTIAL_FIELDS[source.id] ?? [];
  const requirements = useMemo(() => new Set(capability.requires), [capability.requires]);

  useEffect(() => { let active = true; void (async () => { try { if (!capability.credentialBroker) return; const status = await window.voidcatDesktop?.osint.status(); const provider = status?.providers.find((item) => item.id === source.id); if (active) { setConfigured(provider?.configured === true); setFingerprint(provider?.fingerprint ?? null); } } catch (statusError) { if (active) setError(statusError instanceof Error ? statusError.message : "Credential state is unavailable."); } finally { if (active) setBusy(null); } })(); return () => { active = false; }; }, [capability.credentialBroker, source.id]);

  async function saveAndTest() {
    if (!credentialFields.length || credentialFields.some((field) => !credentialValues[field]?.trim())) return;
    setBusy("save"); setError(null);
    try {
      const desktop = protectedDesktop();
      const saved = await desktop.osint.configure(source.id, Object.fromEntries(credentialFields.map((field) => [field, credentialValues[field].trim()])));
      setBusy("test"); await desktop.osint.test(source.id);
      setConfigured(true); setFingerprint(saved.fingerprint); setCredentialValues({});
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : "The provider credential was not accepted."); }
    finally { setBusy(null); }
  }

  async function retest() { setBusy("test"); setError(null); try { await protectedDesktop().osint.test(source.id); } catch (testError) { setError(testError instanceof Error ? testError.message : "The credential test failed."); } finally { setBusy(null); } }
  async function remove() { if (!window.confirm(`Remove the protected ${source.name} credential?`)) return; setBusy("remove"); setError(null); try { await protectedDesktop().osint.remove(source.id); setConfigured(false); setFingerprint(null); } catch (removeError) { setError(removeError instanceof Error ? removeError.message : "The credential could not be removed."); } finally { setBusy(null); } }

  async function run() {
    setBusy("query"); setError(null);
    try {
      const body = {
        sourceId: source.id, limit: 200,
        ...(requirements.has("bbox") ? { bbox: { west: viewport.west, south: viewport.south, east: viewport.east, north: viewport.north } } : {}),
        ...(requirements.has("point") ? { point: { latitude: viewport.latitude, longitude: viewport.longitude, radiusKm: 50 } } : {}),
        ...(requirements.has("query") ? { query: query.trim() } : {}),
        ...(requirements.has("resource") ? { resource: resource.trim() } : {}),
        ...(requirements.has("time-window") ? { startAt: new Date(startAt).toISOString(), endAt: new Date(endAt).toISOString() } : {}),
      };
      const response = await fetch("/api/hunter-seeker/source-query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json() as { result?: { observations?: unknown[]; references?: unknown[]; overlays?: unknown[]; cache?: { status?: string } }; snapshot?: unknown; error?: string };
      if (!response.ok || !payload.snapshot || !payload.result) throw new Error(payload.error ?? `${source.name} did not return a valid bounded result.`);
      const count = (payload.result.observations?.length ?? 0) + (payload.result.references?.length ?? 0) + (payload.result.overlays?.length ?? 0);
      onComplete(payload.snapshot, `${source.name}: ${count.toLocaleString()} bounded item${count === 1 ? "" : "s"} (${payload.result.cache?.status ?? "live"}).`);
    } catch (queryError) { setError(queryError instanceof Error ? queryError.message : "The bounded provider query failed."); }
    finally { setBusy(null); }
  }

  const canRun = !capability.credentialBroker || configured;
  return <div className="hunter-query-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <section aria-labelledby="hunter-query-title" aria-modal="true" className="hunter-query-modal" role="dialog">
      <header><div><span>BOUNDED SOURCE ADAPTER // {capability.capability.toUpperCase()}</span><h2 id="hunter-query-title">{source.name}</h2></div><button aria-label="Close source query" onClick={onClose}>X</button></header>
      <p>{source.description}</p>
      <div className="hunter-query-contract"><b>{capability.requires.length ? capability.requires.join(" // ").toUpperCase() : "NO OPERATOR INPUT"}</b><small>{source.limitation}</small></div>
      {capability.credentialBroker && <section className="hunter-query-credential"><header><strong>PROTECTED CREDENTIAL</strong><b>{configured ? `SAVED // ${fingerprint ?? "MASKED"}` : "SETUP REQUIRED"}</b></header><a href={source.documentationUrl} target="_blank" rel="noopener noreferrer">OPEN OFFICIAL SETUP / API DOCUMENTATION ↗</a>{configured ? <div><button disabled={Boolean(busy)} onClick={() => void retest()}>RETEST LIVE</button><button className="danger" disabled={Boolean(busy)} onClick={() => void remove()}>REMOVE</button></div> : <div>{credentialFields.map((field) => <label key={field}><span>{field.replaceAll("-", " ").toUpperCase()}</span><input autoComplete="off" spellCheck={false} type={field === "project-id" ? "text" : "password"} value={credentialValues[field] ?? ""} onChange={(event) => setCredentialValues((current) => ({ ...current, [field]: event.currentTarget.value }))} /></label>)}<button disabled={Boolean(busy) || credentialFields.some((field) => !credentialValues[field]?.trim())} onClick={() => void saveAndTest()}>{busy === "test" ? "TESTING..." : "SAVE + TEST"}</button></div>}<small>THE VALUES STAY IN ELECTRON'S PROTECTED PROCESS AND NEVER RETURN TO THIS INTERFACE OR THE UNIT.</small></section>}
      <div className="hunter-query-fields">
        {requirements.has("query") && <label><span>SEARCH QUERY</span><input value={query} onChange={(event) => setQuery(event.currentTarget.value)} /></label>}
        {requirements.has("resource") && <label><span>DATASET / RESOURCE</span><input value={resource} onChange={(event) => setResource(event.currentTarget.value)} placeholder="Required bounded resource" /></label>}
        {requirements.has("time-window") && <><label><span>START</span><input type="datetime-local" value={startAt} onChange={(event) => setStartAt(event.currentTarget.value)} /></label><label><span>END</span><input type="datetime-local" value={endAt} onChange={(event) => setEndAt(event.currentTarget.value)} /></label></>}
        {requirements.has("bbox") && <small>VIEWPORT // {viewport.west.toFixed(2)}, {viewport.south.toFixed(2)} TO {viewport.east.toFixed(2)}, {viewport.north.toFixed(2)}</small>}
        {requirements.has("point") && <small>MAP CENTER // {viewport.latitude.toFixed(3)}, {viewport.longitude.toFixed(3)} // 50 KM</small>}
      </div>
      {error && <div className="hunter-query-error">{error}</div>}
      <footer><span>{source.license}</span><button className="primary-action" disabled={Boolean(busy) || !canRun || (requirements.has("query") && query.trim().length < 2) || (requirements.has("resource") && !resource.trim()) || (requirements.has("time-window") && (!startAt || !endAt))} onClick={() => void run()}>{busy === "query" ? "ACQUIRING..." : capability.capability === "catalog" ? "SEARCH CATALOG" : "LOAD BOUNDED DATA"}</button></footer>
    </section>
  </div>;
}
