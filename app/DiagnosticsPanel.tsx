/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
"use client";

import { useEffect, useState } from "react";

export type DiagnosticStatus = "ok" | "warning" | "error" | "unknown";

export type DiagnosticCheck = {
  id: string;
  label: string;
  status: DiagnosticStatus;
  summary: string;
  detail?: string;
};

export type DiagnosticsSnapshot = {
  checkedAt: string;
  app: {
    version: string;
    platform: string;
    architecture: string;
    uptimeSeconds: number;
  };
  unitRuntime: {
    status: DiagnosticStatus;
    cliAvailable: boolean;
    loadedUnit?: string | null;
  };
  storage: {
    status: DiagnosticStatus;
    databasePath: string;
    databaseSizeBytes: number;
    writable: boolean;
  };
  rag: {
    status: DiagnosticStatus;
    documentCount: number;
    folderCount: number;
    chunkCount: number;
    vectorCount: number;
    indexKind: string;
    pendingJobs: number;
  };
  checks: DiagnosticCheck[];
  logPath?: string | null;
};

export type DiagnosticsPanelProps = {
  diagnostics: DiagnosticsSnapshot | null;
  refreshing?: boolean;
  error?: string | null;
  onRefresh: () => Promise<void>;
  onCopy: (diagnostics: DiagnosticsSnapshot) => Promise<void> | void;
};

type ResourceJob = { id: string; module: string; name: string; status: string; progress: { current: number; total?: number; message?: string }; caps: { timeoutMs: number; maxExternalCalls: number }; resources: { externalCalls: number; units: number; wallClockMs: number } };
type ResourceSnapshot = {
  sampledAt: string;
  profile: { id: "quiet" | "normal" | "maximum"; label: string; concurrency: number; sampleIntervalMs: number; description: string };
  autoThrottle: { active: boolean; reasons: string[]; effectiveConcurrency: number };
  control: { globallyPaused: boolean; pausedModules: string[]; concurrencyLimit: number; concurrencyCeiling: number; activeJobs: number; queuedJobs: number };
  cpu: { overallPercent: number; processPercent: number; cores: number; loadAverage1m: number };
  gpu: { available: boolean; name: string | null; utilizationPercent: number | null; memoryUsedBytes: number | null; memoryTotalBytes: number | null; limitation?: string };
  memory: { totalBytes: number; freeBytes: number; freePercent: number; processRssBytes: number; processHeapBytes: number };
  disk: { path: string; totalBytes: number; freeBytes: number; usedBytes: number; freePercent: number };
  storage: { budgets: Record<string, { usedBytes: number; limitBytes: number; utilization: number; state: string }> } | null;
  network: { activeInterfaces: number; accounting: string; externalCalls: number; requestUnits: number; byModule: Record<string, { jobs: number; active: number; externalCalls: number; units: number; wallClockMs: number }> };
  unit: { online: boolean; loaded: Array<Record<string, unknown>>; contextLength: number | null };
  rag: { documents: number; folders: number; chunks: number; vectors: number; pending: number; activeScans: number };
  sources: Array<{ id: string; name: string; enabled: boolean; status: string; pollCadenceMs: number; requestBudgetPercent: number; hourlyRequests: number; hardHourlyBudget: number; recordsPerHour: number; nextScheduledAt?: string }>;
  jobs: ResourceJob[];
};

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** unitIndex)).toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function statusLabel(status: DiagnosticStatus) {
  if (status === "ok") return "NOMINAL";
  if (status === "warning") return "CAUTION";
  if (status === "error") return "FAULT";
  return "UNKNOWN";
}

export function DiagnosticsPanel({ diagnostics, refreshing = false, error, onRefresh, onCopy }: DiagnosticsPanelProps) {
  const [copied, setCopied] = useState(false);
  const [resources, setResources] = useState<ResourceSnapshot | null>(null);
  const [resourceError, setResourceError] = useState<string | null>(null);
  const [controlBusy, setControlBusy] = useState<string | null>(null);
  const [streamKey, setStreamKey] = useState(0);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const events = new EventSource(`/api/resource-command/events?stream=${streamKey}`);
    events.onmessage = (event) => { try { setResources(JSON.parse(event.data) as ResourceSnapshot); setResourceError(null); } catch { setResourceError("Resource telemetry returned malformed data."); } };
    events.addEventListener("fault", (event) => { try { setResourceError((JSON.parse((event as MessageEvent).data) as { error?: string }).error ?? "Resource telemetry failed."); } catch { setResourceError("Resource telemetry failed."); } });
    events.onerror = () => setResourceError((current) => current ?? "Resource telemetry link is reconnecting.");
    return () => events.close();
  }, [streamKey]);

  async function resourceAction(action: string, endpoint: string, body?: unknown) {
    if (controlBusy) return;
    setControlBusy(action); setResourceError(null);
    try {
      const response = await fetch(endpoint, { method: body === undefined ? "POST" : "PATCH", headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? `${action} failed.`);
      setStreamKey((value) => value + 1);
    } catch (actionError) { setResourceError(actionError instanceof Error ? actionError.message : `${action} failed.`); }
    finally { setControlBusy(null); }
  }

  function moduleAction(module: string, action: "pause" | "resume" | "cancel") { return resourceAction(`${action}-${module}`, `/api/resource-command/modules/${encodeURIComponent(module)}/${action}`); }

  function confirmEmergencyStop() {
    if (!window.confirm("Emergency stop cancels active jobs, stops Hunter-Seeker feeds and replay, cancels RAG scans, and attempts to eject the active UNIT. Saved data is not deleted. Continue?")) return;
    void resourceAction("emergency-stop", "/api/resource-command/emergency-stop");
  }

  async function copyReport() {
    if (!diagnostics) return;
    await onCopy(diagnostics);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return <section className="phase-panel diagnostics-panel">
    <div className="phase-heading">
      <div><p className="kicker">SYSTEM INTEGRITY {"//"} RESOURCE CONTROL</p><h2>RESOURCE COMMAND</h2></div>
      <div className="diagnostics-actions"><button className="cancel-action" onClick={() => void copyReport()} disabled={!diagnostics}>{copied ? "COPIED" : "COPY REPORT"}</button><button className="primary-action" onClick={() => void onRefresh()} disabled={refreshing}>{refreshing ? "CHECKING..." : "RUN CHECKS"}</button></div>
    </div>

    {error && <div className="diagnostics-error">{error}</div>}
    {resourceError && <div className="diagnostics-error">{resourceError}</div>}

    {resources && <section className="resource-command" aria-labelledby="resource-command-heading">
      <header className="resource-command-header"><div><span>LIVE RESOURCE TELEMETRY</span><strong id="resource-command-heading">OPERATIONAL LOAD</strong></div><small>{new Date(resources.sampledAt).toLocaleTimeString()} {"//"} {resources.profile.label} PROFILE</small></header>
      <div className="resource-profile-bar" role="group" aria-label="Resource performance profile">
        {(["quiet", "normal", "maximum"] as const).map((profile) => <button key={profile} className={resources.profile.id === profile ? "active" : ""} disabled={Boolean(controlBusy)} onClick={() => void resourceAction(`profile-${profile}`, "/api/resource-command/profile", { profile })}>{profile.toUpperCase()}</button>)}
        <p>{resources.profile.description}</p>
        {resources.control.globallyPaused ? <button className="resource-resume" disabled={Boolean(controlBusy)} onClick={() => void resourceAction("resume", "/api/resource-command/resume")}>RESUME JOB DISPATCH</button> : <button className="resource-emergency" disabled={Boolean(controlBusy)} onClick={confirmEmergencyStop}>EMERGENCY STOP</button>}
      </div>
      {resources.autoThrottle.active && <div className="resource-throttle"><strong>AUTO THROTTLE ACTIVE</strong><span>{resources.autoThrottle.reasons.join(" // ")}</span><b>{resources.autoThrottle.effectiveConcurrency} JOB LANE</b></div>}
      <div className="resource-gauges">
        <article><span>CPU</span><strong>{resources.cpu.overallPercent.toFixed(0)}%</strong><meter min="0" max="100" value={resources.cpu.overallPercent} /><small>VOIDCAT {resources.cpu.processPercent.toFixed(1)}% {"//"} {resources.cpu.cores} LOGICAL CORES</small></article>
        <article><span>GPU</span><strong>{resources.gpu.available ? `${resources.gpu.utilizationPercent?.toFixed(0) ?? 0}%` : "N/A"}</strong><meter min="0" max="100" value={resources.gpu.utilizationPercent ?? 0} /><small>{resources.gpu.name ?? resources.gpu.limitation ?? "NO DEDICATED TELEMETRY"}</small></article>
        <article><span>MEMORY</span><strong>{(100 - resources.memory.freePercent).toFixed(0)}%</strong><meter min="0" max="100" value={100 - resources.memory.freePercent} /><small>{formatBytes(resources.memory.processRssBytes)} APP {"//"} {formatBytes(resources.memory.freeBytes)} FREE</small></article>
        <article><span>DISK</span><strong>{resources.disk.freePercent.toFixed(0)}% FREE</strong><meter min="0" max="100" value={100 - resources.disk.freePercent} /><small>{formatBytes(resources.disk.freeBytes)} AVAILABLE</small></article>
        <article><span>MANAGED TRAFFIC</span><strong>{resources.network.externalCalls} CALLS</strong><meter min="0" max={Math.max(1, resources.network.externalCalls + 10)} value={resources.network.externalCalls} /><small>{resources.network.activeInterfaces} INTERFACES {"//"} {resources.network.requestUnits} REQUEST UNITS</small></article>
        <article><span>UNIT + CONTEXT</span><strong>{resources.unit.online ? `${resources.unit.loaded.length} ONLINE` : "OFFLINE"}</strong><meter min="0" max="32768" value={resources.unit.contextLength ?? 0} /><small>{resources.unit.contextLength ? `${resources.unit.contextLength.toLocaleString()} TOKEN CONTEXT` : "NO ACTIVE CONTEXT"}</small></article>
        <article><span>RAG INDEX</span><strong>{resources.rag.vectors} VECTORS</strong><meter min="0" max={Math.max(1, resources.rag.chunks)} value={resources.rag.vectors} /><small>{resources.rag.pending} PENDING {"//"} {resources.rag.activeScans} ACTIVE SCANS</small></article>
        <article><span>JOB LANES</span><strong>{resources.control.activeJobs} ACTIVE</strong><meter min="0" max={resources.control.concurrencyCeiling} value={resources.control.activeJobs} /><small>{resources.control.queuedJobs} QUEUED {"//"} LIMIT {resources.control.concurrencyLimit}</small></article>
      </div>
      <section className="resource-source-matrix"><header><span>LIVE-SOURCE REQUEST ACCOUNTING</span><b>{resources.sources.filter((source) => source.enabled).length} / {resources.sources.length} ENABLED</b></header><div>{resources.sources.map((source) => <article key={source.id} className={source.enabled ? `status-${source.status}` : "disabled"}><div><strong>{source.name}</strong><span>{source.status.toUpperCase()} {"//"} {source.recordsPerHour.toFixed(1)} REC/HR</span></div><dl><div><dt>CADENCE</dt><dd>{source.pollCadenceMs < 3_600_000 ? `${Math.round(source.pollCadenceMs / 60_000)} MIN` : `${(source.pollCadenceMs / 3_600_000).toFixed(1)} HR`}</dd></div><div><dt>LOCAL BUDGET</dt><dd>{source.requestBudgetPercent}%</dd></div><div><dt>REQUESTS</dt><dd>{source.hourlyRequests} / {source.hardHourlyBudget} HR</dd></div><div><dt>NEXT</dt><dd>{source.nextScheduledAt ? new Date(source.nextScheduledAt).toLocaleTimeString() : "UNSCHEDULED"}</dd></div></dl><button disabled={Boolean(controlBusy)} onClick={() => void resourceAction(`source-${source.id}`, `/api/hunter-seeker/sources/${encodeURIComponent(source.id)}`, { enabled: !source.enabled })}>{source.enabled ? "PAUSE SOURCE" : "ENABLE SOURCE"}</button></article>)}</div></section>
      <div className="resource-module-grid">
        {Object.entries(resources.network.byModule).map(([module, usage]) => { const paused = resources.control.pausedModules.includes(module); return <article key={module} className={paused ? "paused" : ""}><div><strong>{module.toUpperCase()}</strong><span>{usage.active} ACTIVE {"//"} {usage.externalCalls} CALLS {"//"} {usage.units} UNITS</span></div><aside><button disabled={Boolean(controlBusy)} onClick={() => void moduleAction(module, paused ? "resume" : "pause")}>{paused ? "RESUME" : "PAUSE"}</button><button disabled={Boolean(controlBusy) || usage.active === 0} onClick={() => void moduleAction(module, "cancel")}>CANCEL ACTIVE</button></aside></article>; })}
        {Object.keys(resources.network.byModule).length === 0 && <p className="resource-empty">NO MANAGED MODULE ACTIVITY RECORDED THIS SESSION</p>}
      </div>
      {resources.jobs.length > 0 && <div className="resource-job-list"><header><span>JOB CONTROL</span><b>{resources.jobs.filter((job) => job.status === "running" || job.status === "queued").length} NON-TERMINAL</b></header>{resources.jobs.slice(0, 30).map((job) => <article key={job.id}><div><strong>{job.module.toUpperCase()} {"//"} {job.name.toUpperCase()}</strong><span>{job.progress.message ?? job.status.toUpperCase()}</span></div><small>{job.status.toUpperCase()} {"//"} {job.resources.externalCalls}/{job.caps.maxExternalCalls} CALLS {"//"} {(job.resources.wallClockMs / 1000).toFixed(1)} SEC</small>{(job.status === "running" || job.status === "queued") && <button disabled={Boolean(controlBusy)} onClick={() => void resourceAction(`cancel-${job.id}`, `/api/resource-command/jobs/${encodeURIComponent(job.id)}/cancel`)}>CANCEL</button>}</article>)}</div>}
    </section>}

    {!diagnostics && !error && <div className="panel-empty"><span>INSPECTION STANDBY</span><strong>{refreshing ? "RUNNING CHECKS" : "NO REPORT AVAILABLE"}</strong><p>Run checks to inspect the local runtime, storage, and retrieval systems.</p></div>}

    {diagnostics && <>
      <div className="diagnostics-summary">
        <article className="diagnostic-card"><header><span>APPLICATION</span><b className="status-ok">LOCAL</b></header><strong>VOIDCAT {diagnostics.app.version}</strong><p>{diagnostics.app.platform.toUpperCase()} {"//"} {diagnostics.app.architecture.toUpperCase()}</p><small>UPTIME {Math.floor(diagnostics.app.uptimeSeconds / 60)} MIN</small></article>
        <article className={`diagnostic-card status-${diagnostics.unitRuntime.status}`}><header><span>UNIT RUNTIME</span><b>{statusLabel(diagnostics.unitRuntime.status)}</b></header><strong>{diagnostics.unitRuntime.loadedUnit || "NO UNIT LOADED"}</strong><p>LM STUDIO CLI {diagnostics.unitRuntime.cliAvailable ? "DETECTED" : "UNAVAILABLE"}</p><small>STATUS ONLY {"//"} NO UNIT LOAD TRIGGERED</small></article>
        <article className={`diagnostic-card status-${diagnostics.storage.status}`}><header><span>LOCAL STORAGE</span><b>{statusLabel(diagnostics.storage.status)}</b></header><strong>{formatBytes(diagnostics.storage.databaseSizeBytes)}</strong><p>{diagnostics.storage.writable ? "DATABASE WRITABLE" : "DATABASE READ-ONLY"}</p><small title={diagnostics.storage.databasePath}>{diagnostics.storage.databasePath}</small></article>
        <article className={`diagnostic-card status-${diagnostics.rag.status}`}><header><span>VECTOR RETRIEVAL</span><b>{statusLabel(diagnostics.rag.status)}</b></header><strong>{diagnostics.rag.vectorCount} VECTORS</strong><p>{diagnostics.rag.documentCount} FILES {"//"} {diagnostics.rag.folderCount} FOLDERS {"//"} {diagnostics.rag.chunkCount} CHUNKS</p><small>{diagnostics.rag.indexKind.toUpperCase()} {"//"} {diagnostics.rag.pendingJobs} PENDING</small></article>
      </div>

      <section className="diagnostics-checks" aria-labelledby="diagnostics-checks-heading">
        <header className="diagnostics-section-heading"><div><span>SUBSYSTEM AUDIT</span><strong id="diagnostics-checks-heading">HEALTH CHECKS</strong></div><small>{new Date(diagnostics.checkedAt).toLocaleString()}</small></header>
        <div className="diagnostic-check-list">
          {diagnostics.checks.map((check, index) => <article className={`diagnostic-check status-${check.status}`} key={check.id}>
            <span className="diagnostic-check-index">{String(index + 1).padStart(2, "0")}</span>
            <div><strong>{check.label}</strong><p>{check.summary}</p>{check.detail && <small>{check.detail}</small>}</div>
            <b>{statusLabel(check.status)}</b>
          </article>)}
          {diagnostics.checks.length === 0 && <div className="diagnostic-check-empty">NO SUBSYSTEM CHECKS REPORTED</div>}
        </div>
      </section>

      <footer className="diagnostics-footer"><span>REPORT GENERATED {new Date(diagnostics.checkedAt).toLocaleString()}</span>{diagnostics.logPath && <span title={diagnostics.logPath}>LOG {"//"} {diagnostics.logPath}</span>}</footer>
    </>}
  </section>;
}
