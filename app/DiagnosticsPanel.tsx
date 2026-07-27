"use client";

import { useState } from "react";

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

  async function copyReport() {
    if (!diagnostics) return;
    await onCopy(diagnostics);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return <section className="phase-panel diagnostics-panel">
    <div className="phase-heading">
      <div><p className="kicker">SYSTEM INTEGRITY {"//"} READ-ONLY INSPECTION</p><h2>DIAGNOSTICS</h2></div>
      <div className="diagnostics-actions"><button className="cancel-action" onClick={() => void copyReport()} disabled={!diagnostics}>{copied ? "COPIED" : "COPY REPORT"}</button><button className="primary-action" onClick={() => void onRefresh()} disabled={refreshing}>{refreshing ? "CHECKING..." : "RUN CHECKS"}</button></div>
    </div>

    {error && <div className="diagnostics-error">{error}</div>}

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
