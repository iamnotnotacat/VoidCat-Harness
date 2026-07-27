"use client";

import { useRef, useState } from "react";

export type DocumentRecord = { id: string; name: string; extension: string; sizeBytes: number; chunkCount: number; enabled: boolean; updatedAt: string };

export function RagPanel({ documents, onUpload, onToggle, onDelete }: {
  documents: DocumentRecord[];
  onUpload: (files: File[]) => Promise<void>;
  onToggle: (document: DocumentRecord) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [working, setWorking] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function upload(files: File[]) {
    if (!files.length) return;
    setWorking(true); setStatus(`INDEXING ${files.length} DOCUMENT${files.length === 1 ? "" : "S"}...`);
    try { await onUpload(files); setStatus("INGESTION COMPLETE"); }
    catch (error) { setStatus(error instanceof Error ? error.message : "INGESTION FAILED"); }
    finally { setWorking(false); if (inputRef.current) inputRef.current.value = ""; }
  }

  return <section className="phase-panel rag-panel">
    <div className="phase-heading"><div><p className="kicker">TERMINAL DOGMA {"//"} SEMANTIC RETRIEVAL</p><h2>RAG LIBRARY</h2></div><span className="phase-counter">{documents.filter((document) => document.enabled).length} LINKED</span></div>
    <button className={`drop-zone ${dragging ? "dragging" : ""}`} onClick={() => inputRef.current?.click()} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); void upload(Array.from(event.dataTransfer.files)); }} disabled={working}>
      <input ref={inputRef} type="file" multiple accept=".pdf,.docx,.txt,.md" onChange={(event) => void upload(Array.from(event.target.files ?? []))} />
      <span className="drop-glyph">+</span><strong>{working ? "GENERATING LOCAL EMBEDDINGS" : "ADD DOCUMENTS"}</strong><p>DROP PDF, DOCX, TXT, OR MARKDOWN HERE</p><small>NO APP-IMPOSED SIZE CAP {"//"} FILES AND EMBEDDINGS REMAIN LOCAL</small>
      {working && <i className="index-progress" />}
    </button>
    {status && <div className={`rag-status ${status.includes("FAILED") || status.includes("Unsupported") ? "error" : ""}`}>{status}</div>}
    <div className="document-grid">{documents.map((document, index) => <article className={`document-card ${document.enabled ? "" : "disabled"}`} key={document.id} style={{ "--row-index": index } as React.CSSProperties}>
      <div className="document-type">{document.extension.replace(".", "").toUpperCase()}</div><div><span>DOCUMENT {String(index + 1).padStart(3, "0")}</span><strong>{document.name}</strong><p>{document.chunkCount} VECTOR CHUNKS {"//"} {(document.sizeBytes / 1024 / 1024).toFixed(2)} MB</p></div><button className="document-toggle" onClick={() => void onToggle(document)}>{document.enabled ? "LINKED" : "MUTED"}</button><button className="delete-control" aria-label={`Delete ${document.name}`} onClick={() => void onDelete(document.id)}>×</button>
    </article>)}{documents.length === 0 && <div className="panel-empty"><span>LIBRARY LINK IDLE</span><strong>NO DOCUMENTS INDEXED</strong><p>Add a document to make its knowledge available during chat.</p></div>}</div>
  </section>;
}
