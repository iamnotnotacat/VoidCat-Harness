/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
"use client";

import { useRef, useState, type CSSProperties } from "react";
import { useNotifications } from "./NotificationCenter";

export type DocumentRecord = {
  id: string;
  name: string;
  extension: string;
  sizeBytes: number;
  chunkCount: number;
  enabled: boolean;
  updatedAt: string;
  sourceKind?: "upload" | "folder";
  folderId?: string | null;
};

export type FolderScanStatus = "idle" | "queued" | "scanning" | "ready" | "error";

export type RegisteredFolderRecord = {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
  status: FolderScanStatus;
  documentCount: number;
  indexedFileCount: number;
  totalFileCount: number;
  skippedFileCount?: number;
  lastScannedAt?: string | null;
  error?: string | null;
};

export type RagPanelProps = {
  documents: DocumentRecord[];
  folders?: RegisteredFolderRecord[];
  onUpload: (files: File[]) => Promise<void>;
  onToggle: (document: DocumentRecord) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRegisterFolder?: () => Promise<boolean>;
  onScanFolder?: (folder: RegisteredFolderRecord) => Promise<void>;
  onCancelFolderScan?: (folder: RegisteredFolderRecord) => Promise<void>;
  onToggleFolder?: (folder: RegisteredFolderRecord) => Promise<void>;
  onRemoveFolder?: (id: string) => Promise<void>;
};

function scanLabel(status: FolderScanStatus) {
  if (status === "queued") return "QUEUED";
  if (status === "scanning") return "SCANNING";
  if (status === "ready") return "INDEXED";
  if (status === "error") return "FAULT";
  return "IDLE";
}

function formatScanTime(value?: string | null) {
  if (!value) return "NEVER SCANNED";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "SCAN TIME UNKNOWN" : `SCANNED ${date.toLocaleString()}`;
}

export function RagPanel({
  documents,
  folders = [],
  onUpload,
  onToggle,
  onDelete,
  onRegisterFolder,
  onScanFolder,
  onCancelFolderScan,
  onToggleFolder,
  onRemoveFolder,
}: RagPanelProps) {
  const { notify } = useNotifications();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [working, setWorking] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function upload(files: File[]) {
    if (!files.length) return;
    setWorking(true);
    setStatus(`INDEXING ${files.length} DOCUMENT${files.length === 1 ? "" : "S"}...`);
    try {
      await onUpload(files);
      setStatus("INGESTION COMPLETE");
      notify({ tone: "success", title: "RAG ingestion complete", message: `${files.length} document${files.length === 1 ? "" : "s"} added to the local retrieval library.` });
    } catch (error) {
      const message = error instanceof Error ? error.message : "INGESTION FAILED";
      setStatus(message);
      notify({ tone: "error", title: "RAG ingestion failed", message });
    } finally {
      setWorking(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function registerFolder() {
    if (!onRegisterFolder || registering) return;
    setRegistering(true);
    setStatus("AWAITING FOLDER SELECTION...");
    try {
      const registered = await onRegisterFolder();
      setStatus(registered ? "FOLDER REGISTERED" : null);
      if (registered) notify({ tone: "success", title: "Knowledge folder registered", message: "The folder is ready for an operator-started scan." });
    } catch (error) {
      const message = error instanceof Error ? error.message : "FOLDER REGISTRATION FAILED";
      setStatus(message);
      notify({ tone: "error", title: "Folder registration failed", message });
    } finally {
      setRegistering(false);
    }
  }

  async function runFolderAction(folder: RegisteredFolderRecord, action: "scan" | "cancel" | "toggle" | "remove") {
    if (activeFolderId) return;
    if (action === "scan" && !onScanFolder) return;
    if (action === "cancel" && !onCancelFolderScan) return;
    if (action === "toggle" && !onToggleFolder) return;
    if (action === "remove" && !onRemoveFolder) return;
    setActiveFolderId(folder.id);
    setStatus(action === "scan" ? `STARTING ${folder.name.toUpperCase()}...` : action === "cancel" ? `CANCELING ${folder.name.toUpperCase()}...` : null);
    try {
      if (action === "scan") await onScanFolder?.(folder);
      else if (action === "cancel") await onCancelFolderScan?.(folder);
      else if (action === "toggle") await onToggleFolder?.(folder);
      else await onRemoveFolder?.(folder.id);
      if (action === "scan") setStatus("FOLDER SCAN STARTED");
      if (action === "cancel") setStatus("SAFE CANCEL REQUESTED");
      const outcomes = {
        scan: { title: "Folder scan started", message: `${folder.name} is being indexed with resource guards active.`, tone: "info" as const },
        cancel: { title: "Safe cancellation requested", message: `${folder.name} will stop at the next safe boundary.`, tone: "warning" as const },
        toggle: { title: "Folder link updated", message: `${folder.name} is now ${folder.enabled ? "muted" : "linked"}.`, tone: "success" as const },
        remove: { title: "Folder registration removed", message: `${folder.name} was removed from the RAG registry.`, tone: "success" as const },
      };
      notify(outcomes[action]);
    } catch (error) {
      const message = error instanceof Error ? error.message : `FOLDER ${action.toUpperCase()} FAILED`;
      setStatus(message);
      notify({ tone: "error", title: `Folder ${action} failed`, message });
    } finally {
      setActiveFolderId(null);
    }
  }

  const enabledDocuments = documents.filter((document) => document.enabled).length;
  const enabledFolders = folders.filter((folder) => folder.enabled).length;

  return <section className="phase-panel rag-panel">
    <div className="phase-heading">
      <div><p className="kicker">TERMINAL DOGMA {"//"} SEMANTIC RETRIEVAL</p><h2>RAG LIBRARY</h2></div>
      <span className="phase-counter">{enabledDocuments} FILES {"//"} {enabledFolders} FOLDERS</span>
    </div>

    <div className="rag-ingest-grid">
      <button className={`drop-zone ${dragging ? "dragging" : ""}`} onClick={() => inputRef.current?.click()} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); void upload(Array.from(event.dataTransfer.files)); }} disabled={working}>
        <input ref={inputRef} type="file" multiple accept=".pdf,.docx,.txt,.md" onChange={(event) => void upload(Array.from(event.target.files ?? []))} />
        <span className="drop-glyph">+</span>
        <strong>{working ? "GENERATING LOCAL EMBEDDINGS" : "ADD DOCUMENTS"}</strong>
        <p>DROP PDF, DOCX, TXT, OR MARKDOWN HERE</p>
        <small>NO FIXED FILE-SIZE CAP {"//"} MEMORY + DISK GUARDS ACTIVE</small>
        {working && <i className="index-progress" />}
      </button>

      <div className="folder-register-card">
        <span className="folder-register-glyph">DIR</span>
        <div><strong>REGISTER A FOLDER</strong><p>Keep a local knowledge folder linked and rescan it when its files change.</p><small>PDF {"//"} DOCX {"//"} TXT {"//"} MARKDOWN</small></div>
        <button className="primary-action" onClick={() => void registerFolder()} disabled={!onRegisterFolder || registering}>{registering ? "SELECTING..." : "REGISTER FOLDER"}</button>
      </div>
    </div>

    {status && <div className={`rag-status ${/FAILED|FAULT|ERROR/i.test(status) ? "error" : ""}`}>{status}</div>}

    <section className="folder-registry" aria-labelledby="folder-registry-heading">
      <header className="rag-section-heading"><div><span>REGISTERED SOURCES</span><strong id="folder-registry-heading">FOLDER REGISTRY</strong></div><small>{folders.length} CONFIGURED</small></header>
      <div className="folder-grid">
        {folders.map((folder, index) => {
          const scanningFolder = folder.status === "queued" || folder.status === "scanning";
          const busy = scanningFolder || activeFolderId === folder.id;
          const progress = folder.totalFileCount > 0 ? Math.min(100, Math.round((folder.indexedFileCount / folder.totalFileCount) * 100)) : 0;
          return <article className={`folder-card ${folder.enabled ? "" : "disabled"} status-${folder.status}`} key={folder.id} style={{ "--row-index": index } as CSSProperties}>
            <div className="folder-card-main">
              <span className="folder-type">DIR</span>
              <div className="folder-details"><span>FOLDER {String(index + 1).padStart(3, "0")}</span><strong>{folder.name}</strong><p title={folder.path}>{folder.path}</p><small>{folder.documentCount} DOCUMENTS {"//"} {folder.indexedFileCount} INDEXED{folder.skippedFileCount ? ` // ${folder.skippedFileCount} SKIPPED` : ""}</small></div>
              <span className={`folder-scan-state status-${folder.status}`}>{scanLabel(folder.status)}</span>
            </div>
            {(folder.status === "queued" || folder.status === "scanning") && <div className="folder-progress" aria-label={`${progress}% scanned`}><i style={{ width: `${progress}%` }} /><span>{folder.indexedFileCount} / {folder.totalFileCount || "?"}</span></div>}
            {folder.error && <p className="folder-error">{folder.error}</p>}
            <footer className="folder-card-footer">
              <small>{formatScanTime(folder.lastScannedAt)}</small>
              <div>
                {scanningFolder
                  ? <button className="folder-action danger-text" onClick={() => void runFolderAction(folder, "cancel")} disabled={!onCancelFolderScan || activeFolderId === folder.id}>CANCEL SCAN</button>
                  : <button className="folder-action" onClick={() => void runFolderAction(folder, "scan")} disabled={!onScanFolder || busy}>SCAN NOW</button>}
                <button className="folder-action" onClick={() => void runFolderAction(folder, "toggle")} disabled={!onToggleFolder || busy}>{folder.enabled ? "LINKED" : "MUTED"}</button>
                <button className="folder-action danger-text" onClick={() => void runFolderAction(folder, "remove")} disabled={!onRemoveFolder || busy}>REMOVE</button>
              </div>
            </footer>
          </article>;
        })}
        {folders.length === 0 && <div className="folder-empty"><span>NO FOLDERS REGISTERED</span><p>Register a folder to maintain a reusable local knowledge source.</p></div>}
      </div>
    </section>

    <section className="document-registry" aria-labelledby="document-registry-heading">
      <header className="rag-section-heading"><div><span>DIRECT INGESTION</span><strong id="document-registry-heading">DOCUMENT REGISTRY</strong></div><small>{documents.length} STORED</small></header>
      <div className="document-grid">
        {documents.map((document, index) => <article className={`document-card ${document.enabled ? "" : "disabled"}`} key={document.id} style={{ "--row-index": index } as CSSProperties}>
          <div className="document-type">{document.extension.replace(".", "").toUpperCase()}</div>
          <div><span>DOCUMENT {String(index + 1).padStart(3, "0")}</span><strong>{document.name}</strong><p>{document.chunkCount} VECTOR CHUNKS {"//"} {(document.sizeBytes / 1024 / 1024).toFixed(2)} MB</p></div>
          <button className="document-toggle" onClick={() => void onToggle(document)}>{document.enabled ? "LINKED" : "MUTED"}</button>
          <button className="delete-control" aria-label={`Delete ${document.name}`} onClick={() => void onDelete(document.id)}>{"\u00d7"}</button>
        </article>)}
        {documents.length === 0 && <div className="panel-empty"><span>LIBRARY LINK IDLE</span><strong>NO DOCUMENTS INDEXED</strong><p>Add a document or register a folder to make local knowledge available during chat.</p></div>}
      </div>
    </section>
  </section>;
}
