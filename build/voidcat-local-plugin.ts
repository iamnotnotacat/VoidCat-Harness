import type { IncomingMessage, ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants as fsConstants, promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import Busboy from "busboy";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import type { Plugin } from "vite";
import { discoverWebSearchResults, fetchSelectedWebpages, type WebSearchHit } from "./voidcat-web";
import {
  addMessage, beginRagFolderScan, cancelRagFolderScan, createConversation, createDocument, deleteConversation, deleteDocument, deleteMemory,
  deleteProfile, deleteRagFolder, finishRagFolderScan, getConversation, getFolderDocumentSource, getMemoryCandidates,
  getMemoryRecord, getRagCitation, getRagFolder, getRagVectorIndexStats, getSettings, getState, indexDocumentVectors,
  indexPendingRagVectors, listStaleFolderDocumentSources, registerRagFolder, saveMemory, saveProfile, saveSettings,
  searchRagVectorIndex, setMemoryEmbedding, touchDocumentSource, updateConversation, updateDocument, updateRagFolder,
  updateRagFolderScanProgress, upsertFolderDocument,
  type MemoryInput, type ProfileInput, type SettingsInput, type WebMode,
} from "./voidcat-database";

const execFileAsync = promisify(execFile);
const LMS_PATH = path.join(os.homedir(), ".lmstudio", "bin", "lms.exe");
const API_BASE = "http://127.0.0.1:1234";
const EMBEDDING_MODEL = "text-embedding-nomic-embed-text-v1.5";
const RAG_EXTENSIONS = new Set([".pdf", ".docx", ".txt", ".md"]);
const RAG_IGNORED_DIRECTORIES = new Set([".git", ".voidcat", "node_modules", "$recycle.bin", "system volume information"]);
const MAX_REGISTERED_FOLDER_FILES = 2_000;
const MAX_REGISTERED_FOLDER_DIRECTORIES = 5_000;
const MAX_REGISTERED_FOLDER_ENTRIES = 50_000;
const MAX_REGISTERED_FOLDER_SOURCE_BYTES = 10 * 1024 ** 3;
const MAX_FOLDER_ENUMERATION_MS = 60_000;
const MAX_RAG_CHUNKS_PER_DOCUMENT = 4_096;
const RAG_MEMORY_RESERVE_BYTES = 512 * 1024 * 1024;
const RAG_DISK_RESERVE_BYTES = 2 * 1024 ** 3;

type LmsModel = {
  type: "llm" | "embedding";
  modelKey: string;
  displayName: string;
  publisher: string;
  path: string;
  sizeBytes: number;
  paramsString?: string;
  architecture?: string;
  quantization?: { name?: string; bits?: number };
  vision?: boolean;
  trainedForToolUse?: boolean;
  maxContextLength?: number;
};

type RegisteredFolder = {
  id: string;
  name: string;
  path: string;
  recursive: boolean;
  enabled: boolean;
};

type FolderScanJob = {
  controller: AbortController;
  startedAt: string;
};

const folderScanJobs = new Map<string, FolderScanJob>();
let embeddingReady = false;
let embeddingLoadPromise: Promise<void> | null = null;
let embeddingUnloadPromise: Promise<void> | null = null;
let activeEmbeddingUsers = 0;

async function runLms(args: string[], timeout = 120_000) {
  const result = await execFileAsync(LMS_PATH, args, {
    cwd: path.dirname(LMS_PATH), timeout, windowsHide: true, maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function lmsJson<T>(args: string[], timeout?: number): Promise<T> {
  const output = await runLms(args, timeout);
  return JSON.parse(output || "[]") as T;
}

function classify(model: LmsModel) {
  const value = `${model.modelKey} ${model.displayName}`.toLowerCase();
  if (model.type === "embedding") return "embedding";
  if (value.includes("coder") || value.includes("coding")) return "code";
  if (value.includes("reason") || value.includes("r1") || value.includes("think")) return "reasoning";
  return "chat";
}

async function scanModels() {
  const entries = await lmsJson<LmsModel[]>(["ls", "--json"]);
  return {
    models: entries.map((model) => ({
      id: model.modelKey,
      modelKey: model.modelKey,
      name: model.displayName,
      publisher: model.publisher,
      path: model.path,
      sizeBytes: model.sizeBytes,
      size: `${(model.sizeBytes / 1024 ** 3).toFixed(model.sizeBytes > 10 * 1024 ** 3 ? 1 : 2)} GB`,
      quantization: model.quantization?.name ?? "GGUF",
      kind: classify(model),
      vision: Boolean(model.vision),
      toolUse: Boolean(model.trainedForToolUse),
      parameters: model.paramsString ?? "—",
      architecture: model.architecture ?? "unknown",
      maxContextLength: model.maxContextLength ?? 8192,
      status: "ready",
    })),
    scannedAt: new Date().toISOString(),
    roots: [path.join(os.homedir(), ".lmstudio", "models")],
  };
}

async function readBody(request: IncomingMessage, maxBytes = 1_000_000) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("The local request exceeded the 1 MB safety limit.");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

function sendJson(response: ServerResponse, status: number, data: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(data));
}

async function runtimeStatus(timeout = 120_000) {
  try {
    const loaded = await lmsJson<Array<Record<string, unknown>>>(["ps", "--json"], timeout);
    return { online: loaded.length > 0, loaded, error: null as string | null };
  } catch (error) {
    return { online: false, loaded: [], error: error instanceof Error ? error.message : "UNIT runtime status failed." };
  }
}

async function ensureApiServer() {
  try {
    await fetch(`${API_BASE}/v1/models`, { signal: AbortSignal.timeout(1_000) });
  } catch {
    try { await runLms(["server", "start", "--port", "1234", "--bind", "127.0.0.1"], 30_000); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes("already")) throw error;
    }
  }
}

async function ensureEmbeddingModel() {
  if (embeddingUnloadPromise) await embeddingUnloadPromise;
  if (embeddingReady) return;
  if (!embeddingLoadPromise) {
    embeddingLoadPromise = (async () => {
      await ensureApiServer();
      const status = await runtimeStatus();
      if (!status.loaded.some((entry) => entry.identifier === "voidcat-embed")) {
        await runLms(["load", EMBEDDING_MODEL, "--yes", "--identifier", "voidcat-embed", "--context-length", "2048"], 5 * 60_000);
      }
      embeddingReady = true;
    })();
  }
  try { await embeddingLoadPromise; } finally { embeddingLoadPromise = null; }
}

async function releaseEmbeddingModelIfIdle() {
  if (!embeddingReady || activeEmbeddingUsers > 0 || embeddingUnloadPromise) return;
  embeddingReady = false;
  embeddingUnloadPromise = runLms(["unload", "voidcat-embed"], 120_000).then(() => undefined).catch(() => undefined);
  try { await embeddingUnloadPromise; } finally { embeddingUnloadPromise = null; }
}

async function embedTexts(texts: string[], signal?: AbortSignal) {
  activeEmbeddingUsers += 1;
  try {
    await ensureEmbeddingModel();
    const embeddings: number[][] = [];
    for (let index = 0; index < texts.length; index += 16) {
      if (signal?.aborted) throw abortedError();
      const batch = texts.slice(index, index + 16);
      const timeout = AbortSignal.timeout(5 * 60_000);
      const response = await fetch(`${API_BASE}/v1/embeddings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "voidcat-embed", input: batch }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!response.ok) throw new Error(`Embedding failed: ${await response.text()}`);
      const data = await response.json() as { data?: Array<{ index: number; embedding: number[] }> };
      const ordered = (data.data ?? []).sort((a, b) => a.index - b.index).map((item) => item.embedding);
      if (ordered.length !== batch.length) throw new Error("The embedding runtime returned an incomplete batch.");
      embeddings.push(...ordered);
    }
    return embeddings;
  } finally {
    activeEmbeddingUsers = Math.max(0, activeEmbeddingUsers - 1);
  }
}

function chunkText(input: string) {
  const normalized = input.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const paragraphs = normalized.split(/\n\n+/).filter(Boolean);
  const chunks: string[] = []; let current = "";
  for (const paragraph of paragraphs) {
    if (current.length + paragraph.length + 2 <= 1400) { current += `${current ? "\n\n" : ""}${paragraph}`; continue; }
    if (current) chunks.push(current);
    if (paragraph.length <= 1400) current = paragraph;
    else {
      for (let offset = 0; offset < paragraph.length; offset += 1200) chunks.push(paragraph.slice(offset, offset + 1400));
      current = "";
    }
  }
  if (current) chunks.push(current);
  return chunks.filter((chunk) => chunk.trim().length >= 20);
}

async function extractText(filename: string, buffer: Buffer) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".txt" || extension === ".md") return buffer.toString("utf8");
  if (extension === ".docx") return (await mammoth.extractRawText({ buffer })).value;
  if (extension === ".pdf") {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try { return (await parser.getText()).text; } finally { await parser.destroy(); }
  }
  throw new Error("Unsupported document format. Use PDF, DOCX, TXT, or Markdown.");
}

function readUpload(request: IncomingMessage) {
  return new Promise<{ filename: string; mimeType: string; buffer: Buffer }>((resolve, reject) => {
    let settled = false;
    try {
      const parser = Busboy({ headers: request.headers, limits: { files: 1, fields: 2 } });
      parser.on("file", (_field, stream, info) => {
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        stream.on("data", (chunk: Buffer) => {
          if (settled) return;
          receivedBytes += chunk.length;
          if (os.freemem() < RAG_MEMORY_RESERVE_BYTES + receivedBytes * 4) {
            settled = true;
            chunks.length = 0;
            reject(new Error("The document upload stopped to preserve a safe amount of free memory."));
            return;
          }
          chunks.push(chunk);
        });
        stream.on("end", () => { if (!settled) { settled = true; resolve({ filename: path.basename(info.filename), mimeType: info.mimeType, buffer: Buffer.concat(chunks) }); } });
      });
      parser.on("error", reject); parser.on("finish", () => { if (!settled) reject(new Error("No document was attached.")); });
      request.pipe(parser);
    } catch (error) { reject(error); }
  });
}

async function ingestDocument(request: IncomingMessage) {
  const upload = await readUpload(request);
  const extension = path.extname(upload.filename).toLowerCase();
  if (![".pdf", ".docx", ".txt", ".md"].includes(extension)) throw new Error("Unsupported document format. Use PDF, DOCX, TXT, or Markdown.");
  ensureRagHeadroom(upload.buffer.length);
  const text = await extractText(upload.filename, upload.buffer);
  const chunks = chunkText(text);
  if (!chunks.length) throw new Error("No readable text was found in this document.");
  if (chunks.length > MAX_RAG_CHUNKS_PER_DOCUMENT) throw new Error(`This document produced more than ${MAX_RAG_CHUNKS_PER_DOCUMENT.toLocaleString()} passages. Split it into smaller documents before indexing.`);
  ensureRagHeadroom(upload.buffer.length, text.length * 2 + chunks.length * 4096 * 8);
  const estimatedStorageBytes = estimateRagStorageBytes(upload.buffer.length, text.length, chunks.length, true);
  await ensureRagDiskHeadroom(estimatedStorageBytes);
  const embeddings = await embedTexts(chunks);
  await ensureRagDiskHeadroom(estimatedStorageBytes);
  const documentId = randomUUID();
  const libraryDirectory = path.resolve(process.cwd(), ".voidcat", "library", "files");
  await fs.mkdir(libraryDirectory, { recursive: true });
  const storedPath = path.join(libraryDirectory, `${documentId}${extension}`);
  await fs.writeFile(storedPath, upload.buffer);
  let document: ReturnType<typeof createDocument>;
  try {
    document = createDocument({ id: documentId, name: upload.filename, extension, storedPath, sizeBytes: upload.buffer.length }, chunks.map((content, index) => ({ content, embedding: embeddings[index] })));
  } catch (error) {
    await fs.rm(storedPath, { force: true });
    throw error;
  }
  const indexedChunks = await indexDocumentCompletely(document.id);
  return { ...document, indexedChunks };
}

function cosine(left: number[], right: number[]) {
  let dot = 0; let leftNorm = 0; let rightNorm = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) { dot += left[index] * right[index]; leftNorm += left[index] ** 2; rightNorm += right[index] ** 2; }
  return leftNorm && rightNorm ? dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)) : 0;
}

function abortedError() {
  const error = new Error("The folder scan was canceled safely.");
  error.name = "AbortError";
  return error;
}

async function yieldToEventLoop() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function indexDocumentCompletely(documentId: string, signal?: AbortSignal) {
  let indexedChunks = 0;
  while (true) {
    if (signal?.aborted) throw abortedError();
    const batch = indexDocumentVectors(documentId, { limit: 24 });
    indexedChunks += batch.indexed;
    if (!batch.batchFull || batch.scanned === 0) return indexedChunks;
    await yieldToEventLoop();
  }
}

async function searchDocuments(query: string) {
  const stats = getRagVectorIndexStats();
  if (!stats.enabledChunks) return [];
  // Older library records are migrated incrementally, never in an unbounded
  // startup job. Newly added files are indexed completely during ingestion.
  for (let batchNumber = 0; batchNumber < 8; batchNumber += 1) {
    const batch = indexPendingRagVectors({ limit: 24 });
    if (!batch.batchFull || batch.scanned === 0) break;
    await yieldToEventLoop();
  }
  const [queryEmbedding] = await embedTexts([query]);
  return searchRagVectorIndex(queryEmbedding, { limit: 6, candidateLimit: 192, minScore: 0.2, probeRadius: 1 })
    .map(({ chunkId, ...result }) => ({ id: chunkId, ...result }));
}

function isInsideFolder(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function collectFolderFiles(root: string, recursive: boolean, signal: AbortSignal) {
  const files: string[] = [];
  const pendingDirectories = [root];
  const enumerationStartedAt = Date.now();
  let discoveredDirectories = 1;
  let discoveredEntries = 0;
  let totalSourceBytes = 0;
  while (pendingDirectories.length) {
    if (signal.aborted) throw abortedError();
    if (Date.now() - enumerationStartedAt > MAX_FOLDER_ENUMERATION_MS) throw new Error("Folder enumeration exceeded the 60 second safety budget. Register a smaller knowledge folder.");
    const current = pendingDirectories.shift()!;
    const realCurrent = await fs.realpath(current);
    if (!isInsideFolder(root, realCurrent)) continue;
    const directory = await fs.opendir(realCurrent);
    for await (const entry of directory) {
      if (signal.aborted) throw abortedError();
      if (Date.now() - enumerationStartedAt > MAX_FOLDER_ENUMERATION_MS) throw new Error("Folder enumeration exceeded the 60 second safety budget. Register a smaller knowledge folder.");
      discoveredEntries += 1;
      if (discoveredEntries > MAX_REGISTERED_FOLDER_ENTRIES) throw new Error(`This folder contains more than ${MAX_REGISTERED_FOLDER_ENTRIES.toLocaleString()} entries. Register a smaller knowledge folder.`);
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(realCurrent, entry.name);
      if (entry.isDirectory()) {
        if (recursive && !RAG_IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) {
          discoveredDirectories += 1;
          if (discoveredDirectories > MAX_REGISTERED_FOLDER_DIRECTORIES) throw new Error(`This folder contains more than ${MAX_REGISTERED_FOLDER_DIRECTORIES.toLocaleString()} directories. Register a smaller knowledge folder.`);
          pendingDirectories.push(entryPath);
        }
        continue;
      }
      if (!entry.isFile() || !RAG_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const realFile = await fs.realpath(entryPath);
      if (!isInsideFolder(root, realFile)) continue;
      totalSourceBytes += (await fs.stat(realFile)).size;
      if (totalSourceBytes > MAX_REGISTERED_FOLDER_SOURCE_BYTES) throw new Error("Supported files in this folder exceed the 10 GB cumulative scan safety budget.");
      files.push(realFile);
      if (files.length > MAX_REGISTERED_FOLDER_FILES) {
        throw new Error(`This folder contains more than ${MAX_REGISTERED_FOLDER_FILES.toLocaleString()} supported files. Register a smaller knowledge folder to keep scanning safe.`);
      }
    }
    await yieldToEventLoop();
  }
  return files;
}

function ensureRagHeadroom(fileSize: number, extraBytes = 0) {
  const estimatedWorkingBytes = Math.max(64 * 1024 * 1024, fileSize * 6 + extraBytes);
  if (os.freemem() < RAG_MEMORY_RESERVE_BYTES + estimatedWorkingBytes) {
    throw new Error("The document could not be processed with a safe amount of free memory.");
  }
}

function estimateRagStorageBytes(fileSize: number, textCharacters: number, chunkCount: number, includesStoredCopy: boolean) {
  const storedCopyBytes = includesStoredCopy ? fileSize : 0;
  const textBytes = textCharacters * 2;
  const worstCaseEmbeddingJsonBytes = chunkCount * 4096 * 16;
  // SQLite WAL and transaction pages can temporarily require substantially
  // more room than the final rows alone.
  return Math.ceil((storedCopyBytes + textBytes + worstCaseEmbeddingJsonBytes) * 2.5);
}

async function ensureRagDiskHeadroom(estimatedWriteBytes: number) {
  try {
    const stats = await fs.statfs(process.cwd());
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    if (!Number.isFinite(availableBytes) || availableBytes < RAG_DISK_RESERVE_BYTES + estimatedWriteBytes) {
      throw new Error("Indexing stopped because VoidCat could not preserve at least 2 GB of free disk space.");
    }
  } catch (error) {
    const diskError = new Error(error instanceof Error ? error.message : "VoidCat could not verify safe free disk space.");
    diskError.name = "RagDiskSafetyError";
    throw diskError;
  }
}

async function scanFolderFile(folder: RegisteredFolder, root: string, filePath: string, startedAt: string, signal: AbortSignal) {
  const relativePath = path.relative(root, filePath).split(path.sep).join("/");
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  let fingerprint: string;
  let chunks: string[];
  try {
    stat = await fs.stat(filePath);
    fingerprint = `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
    const existing = getFolderDocumentSource(folder.id, relativePath) as { documentId?: string; fingerprint?: string } | undefined;
    if (existing?.documentId && existing.fingerprint === fingerprint) {
      touchDocumentSource(existing.documentId, { sourcePath: filePath, modifiedAtMs: stat.mtimeMs, sizeBytes: stat.size, fingerprint, seenAt: startedAt });
      return;
    }
    ensureRagHeadroom(stat.size);
    const buffer = await fs.readFile(filePath);
    if (signal.aborted) throw abortedError();
    const text = await extractText(filePath, buffer);
    chunks = chunkText(text);
    if (!chunks.length) throw new Error("No readable text was found.");
    if (chunks.length > MAX_RAG_CHUNKS_PER_DOCUMENT) throw new Error(`The file produced more than ${MAX_RAG_CHUNKS_PER_DOCUMENT.toLocaleString()} passages.`);
    ensureRagHeadroom(stat.size, text.length * 2 + chunks.length * 4096 * 8);
    await ensureRagDiskHeadroom(estimateRagStorageBytes(stat.size, text.length, chunks.length, false));
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw abortedError();
    if (error instanceof Error && error.name === "RagDiskSafetyError") throw error;
    const fileError = new Error(error instanceof Error ? error.message : "The file could not be read safely.");
    fileError.name = "RagFileError";
    throw fileError;
  }
  const embeddings = await embedTexts(chunks, signal);
  if (signal.aborted) throw abortedError();
  await ensureRagDiskHeadroom(estimateRagStorageBytes(stat.size, chunks.reduce((total, chunk) => total + chunk.length, 0), chunks.length, false));
  const document = upsertFolderDocument({
    folderId: folder.id,
    sourcePath: filePath,
    relativePath,
    modifiedAtMs: stat.mtimeMs,
    fingerprint,
    seenAt: startedAt,
    name: path.basename(filePath),
    extension: path.extname(filePath).toLowerCase(),
    storedPath: filePath,
    sizeBytes: stat.size,
  }, chunks.map((content, index) => ({ content, embedding: embeddings[index] })));
  await indexDocumentCompletely(document.id, signal);
}

async function executeFolderScan(folderId: string, startedAt: string, signal: AbortSignal) {
  const folder = getRagFolder(folderId) as RegisteredFolder | null;
  if (!folder) throw new Error("Registered folder was not found.");
  const root = await fs.realpath(folder.path);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new Error("The registered path is no longer a folder.");
  await ensureRagDiskHeadroom(0);
  const files = await collectFolderFiles(root, folder.recursive, signal);
  updateRagFolderScanProgress(folderId, { totalFileCount: files.length, indexedFileCount: 0, skippedFileCount: 0 });

  let indexedFileCount = 0;
  let skippedFileCount = 0;
  for (const filePath of files) {
    if (signal.aborted) throw abortedError();
    const relativePath = path.relative(root, filePath).split(path.sep).join("/");
    const existing = getFolderDocumentSource(folder.id, relativePath) as { documentId?: string } | undefined;
    try {
      await scanFolderFile(folder, root, filePath, startedAt, signal);
      indexedFileCount += 1;
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw abortedError();
      if (!(error instanceof Error) || error.name !== "RagFileError") throw error;
      if (existing?.documentId) touchDocumentSource(existing.documentId, { seenAt: startedAt });
      skippedFileCount += 1;
    }
    updateRagFolderScanProgress(folderId, { totalFileCount: files.length, indexedFileCount, skippedFileCount });
    await yieldToEventLoop();
  }

  while (true) {
    if (signal.aborted) throw abortedError();
    const stale = listStaleFolderDocumentSources(folderId, startedAt, 100);
    if (!stale.length) break;
    stale.forEach(({ documentId }) => { deleteDocument(documentId); });
    await yieldToEventLoop();
  }
}

function startFolderScan(folderId: string) {
  if (folderScanJobs.size > 0) throw new Error("Another folder scan is already active. Wait for it to finish or cancel it first.");
  const { startedAt } = beginRagFolderScan(folderId);
  const controller = new AbortController();
  folderScanJobs.set(folderId, { controller, startedAt });
  void executeFolderScan(folderId, startedAt, controller.signal)
    .then(() => { finishRagFolderScan(folderId, { startedAt }); })
    .catch((error: unknown) => {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) cancelRagFolderScan(folderId, startedAt);
      else finishRagFolderScan(folderId, { startedAt, error: error instanceof Error ? error.message : "Folder scan failed." });
    })
    .finally(async () => {
      await releaseEmbeddingModelIfIdle();
      folderScanJobs.delete(folderId);
    });
  return getRagFolder(folderId);
}

async function registerFolder(folderPath: string) {
  const resolved = await fs.realpath(path.resolve(folderPath));
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new Error("The selected path is not a folder.");
  if (resolved === path.parse(resolved).root) throw new Error("Register a knowledge folder, not an entire drive.");
  return registerRagFolder({ path: resolved, name: path.basename(resolved), recursive: true, enabled: true });
}

async function quickCheckDatabase(databasePath: string) {
  const script = "const { DatabaseSync } = require('node:sqlite'); const database = new DatabaseSync(process.argv[1], { readOnly: true }); try { const row = database.prepare('PRAGMA quick_check(1)').get(); process.stdout.write(String(Object.values(row)[0] || 'unknown')); } finally { database.close(); }";
  const result = await execFileAsync(process.execPath, ["-e", script, databasePath], {
    timeout: 5_000, windowsHide: true, maxBuffer: 64 * 1024,
  });
  return result.stdout.trim();
}

async function collectDiagnostics() {
  const databasePath = path.resolve(process.cwd(), ".voidcat", "data", "voidcat.db");
  const logPath = path.resolve(process.cwd(), ".voidcat", "desktop-server-error.log");
  let cliAvailable = false;
  let writable = false;
  let databaseSizeBytes = 0;
  let databaseIssue: string | null = null;
  let documentCount = 0;
  let folderCount = 0;
  let ragIndex = { totalChunks: 0, indexedChunks: 0, indexedEnabledChunks: 0, pendingEnabledChunks: 0, failedEnabledChunks: 0, coverage: 0 };
  try { await fs.access(LMS_PATH, fsConstants.F_OK); cliAvailable = true; } catch { /* reported below */ }
  try { await fs.access(databasePath, fsConstants.R_OK | fsConstants.W_OK); writable = true; } catch { /* reported below */ }
  try { databaseSizeBytes = (await fs.stat(databasePath)).size; } catch { /* reported below */ }
  if (databaseSizeBytes > 0) {
    try {
      const integrity = await quickCheckDatabase(databasePath);
      if (integrity.toLowerCase() !== "ok") databaseIssue = `SQLite quick check reported: ${integrity}`;
    } catch (error) { databaseIssue = error instanceof Error ? error.message : "SQLite quick check failed."; }
  } else databaseIssue = "The local database file was not found.";
  try {
    const state = getState();
    documentCount = state.documents.length;
    folderCount = state.ragFolders.length;
    ragIndex = getRagVectorIndexStats();
  } catch (error) {
    databaseIssue ||= error instanceof Error ? error.message : "The local database could not be read.";
  }
  const runtime = cliAvailable ? await runtimeStatus(5_000) : { online: false, loaded: [], error: "UNIT CLI unavailable." };
  const loaded = runtime.loaded.find((entry) => entry.identifier === "voidcat-core");
  const loadedUnit = typeof loaded?.modelKey === "string" ? loaded.modelKey : typeof loaded?.path === "string" ? path.basename(loaded.path) : null;
  const runtimeStatusValue = cliAvailable && !runtime.error ? "ok" : "warning";
  const storageStatus = writable && !databaseIssue ? "ok" : "error";
  const ragStatus = databaseIssue || ragIndex.failedEnabledChunks > 0 ? "error" : ragIndex.pendingEnabledChunks > 0 || folderScanJobs.size > 0 ? "warning" : "ok";
  let version = "0.1.0";
  try { version = (JSON.parse(await fs.readFile(path.resolve(process.cwd(), "package.json"), "utf8")) as { version?: string }).version || version; } catch { /* fallback above */ }
  const checks = [
    { id: "unit-cli", label: "UNIT RUNTIME", status: runtimeStatusValue, summary: runtimeStatusValue === "ok" ? "The local UNIT command service responded." : "The local UNIT command service did not respond cleanly.", detail: runtime.error || LMS_PATH },
    { id: "storage", label: "LOCAL DATABASE", status: storageStatus, summary: storageStatus === "ok" ? "The database is writable and passed a bounded SQLite quick check." : "The local database needs attention.", detail: databaseIssue || databasePath },
    { id: "vector-index", label: "VECTOR INDEX", status: ragStatus, summary: ragIndex.pendingEnabledChunks ? `${ragIndex.pendingEnabledChunks} chunks await bounded indexing.` : `${ragIndex.indexedEnabledChunks} enabled chunks are indexed.`, detail: `${Math.round(ragIndex.coverage * 100)}% coverage // ${ragIndex.failedEnabledChunks} quarantined` },
    { id: "folder-jobs", label: "FOLDER SCANNER", status: folderScanJobs.size ? "warning" : "ok", summary: folderScanJobs.size ? "A user-started folder scan is active." : "No folder scans are running.", detail: "Folder scans run one at a time and can be canceled." },
  ] as const;
  return {
    checkedAt: new Date().toISOString(),
    app: { version, platform: process.platform, architecture: process.arch, uptimeSeconds: process.uptime() },
    unitRuntime: { status: runtimeStatusValue, cliAvailable, loadedUnit },
    storage: { status: storageStatus, databasePath, databaseSizeBytes, writable },
    rag: { status: ragStatus, documentCount, folderCount,
      chunkCount: ragIndex.totalChunks, vectorCount: ragIndex.indexedChunks, indexKind: "SQLite SimHash LSH + cosine rerank", pendingJobs: folderScanJobs.size },
    checks,
    logPath,
  };
}

async function saveIndexedMemory(input: MemoryInput) {
  if (!input.content?.trim()) return saveMemory(input);
  const existing = input.id ? getMemoryRecord(input.id) : undefined;
  if (existing?.content === input.content.trim() && existing.embedding) return saveMemory(input);
  const [embedding] = await embedTexts([input.content.trim()]);
  return saveMemory({ ...input, embedding });
}

async function searchMemories(query: string) {
  const candidates = getMemoryCandidates();
  if (!candidates.length) return [];
  const missing = candidates.filter((memory) => !memory.embedding);
  const embeddings = await embedTexts([query, ...missing.map((memory) => memory.content)]);
  missing.forEach((memory, index) => {
    memory.embedding = JSON.stringify(embeddings[index + 1]);
    setMemoryEmbedding(memory.id, embeddings[index + 1]);
  });
  const queryEmbedding = embeddings[0];
  return candidates.map((memory) => {
    const relevance = cosine(queryEmbedding, JSON.parse(memory.embedding || "[]") as number[]);
    const score = relevance * 0.78 + (memory.importance / 5) * 0.22;
    return { id: memory.id, content: memory.content, category: memory.category, importance: memory.importance, relevance, score };
  }).filter((memory) => memory.relevance >= 0.18).sort((left, right) => right.score - left.score).slice(0, 6);
}

async function searchWeb(query: string) {
  const settings = getSettings();
  const discovery = await discoverWeb(query);
  return fetchWebSelection(query, discovery.results.slice(0, settings.maxWebPages));
}

async function discoverWeb(query: string) {
  const settings = getSettings();
  const results = await discoverWebSearchResults(query, {
    provider: settings.webProvider,
    apiKey: settings.webApiKey,
    maxResults: 8,
    maxResponseBytes: Math.min(settings.maxWebBytes, 1_000_000),
  });
  return { provider: settings.webProvider, results };
}

async function fetchWebSelection(query: string, selected: WebSearchHit[]) {
  const settings = getSettings();
  const result = await fetchSelectedWebpages(selected, query, {
    allowedDomains: settings.allowedDomains,
    blockedDomains: settings.blockedDomains,
    maxPages: settings.maxWebPages,
    maxBytesPerPage: settings.maxWebBytes,
    maxTotalBytes: settings.maxWebPages * settings.maxWebBytes,
  });
  return { provider: settings.webProvider, results: result.sources, rejected: result.rejected, bytesRead: result.bytesRead };
}

async function loadModel(modelKey: string, contextLength: number) {
  await ensureApiServer();
  const status = await runtimeStatus();
  const owned = status.loaded.find((entry) => entry.identifier === "voidcat-core");
  if (owned) await runLms(["unload", "voidcat-core"], 120_000);
  await runLms([
    "load", modelKey, "--yes", "--identifier", "voidcat-core",
    "--context-length", String(Math.max(2048, Math.min(contextLength, 32768))),
  ], 10 * 60_000);
  return runtimeStatus();
}

async function proxyChat(request: IncomingMessage, response: ServerResponse) {
  const body = await readBody(request);
  await ensureApiServer();
  const upstream = await fetch(`${API_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, model: "voidcat-core", stream: true }),
    signal: AbortSignal.timeout(30 * 60_000),
  });
  response.statusCode = upstream.status;
  response.setHeader("Content-Type", upstream.headers.get("content-type") ?? "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  if (!upstream.body) { response.end(); return; }
  const reader = upstream.body.getReader();
  request.on("close", () => void reader.cancel());
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    response.write(Buffer.from(value));
  }
  response.end();
}

export function voidcatLocal(): Plugin {
  return {
    name: "voidcat-local-core",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url?.split("?")[0];
        if (!url?.startsWith("/api/")) { next(); return; }
        void (async () => {
          try {
            if (url === "/api/health" && request.method === "GET") sendJson(response, 200, { app: "voidcat-harness", token: process.env.VOIDCAT_DESKTOP_TOKEN || null });
            else if (url === "/api/models" && request.method === "GET") sendJson(response, 200, await scanModels());
            else if (url === "/api/runtime/status" && request.method === "GET") sendJson(response, 200, await runtimeStatus());
            else if (url === "/api/diagnostics" && request.method === "GET") sendJson(response, 200, await collectDiagnostics());
            else if (url === "/api/state" && request.method === "GET") sendJson(response, 200, getState());
            else if (url === "/api/conversations" && request.method === "POST") sendJson(response, 201, createConversation(await readBody(request) as { title?: string; profileId?: string; modelKey?: string; webMode?: WebMode }));
            else if (url?.startsWith("/api/conversations/")) {
              const parts = url.split("/").filter(Boolean);
              const conversationId = parts[2];
              if (!conversationId) throw new Error("Conversation id is required.");
              if (parts[3] === "messages" && request.method === "POST") {
                const body = await readBody(request);
                if (typeof body.role !== "string" || typeof body.content !== "string") throw new Error("Message role and content are required.");
                sendJson(response, 201, addMessage(conversationId, body.role, body.content, Array.isArray(body.sources) ? body.sources : []));
              } else if (request.method === "GET") sendJson(response, 200, getConversation(conversationId));
              else if (request.method === "PATCH") sendJson(response, 200, updateConversation(conversationId, await readBody(request) as { title?: string; profileId?: string; modelKey?: string; webMode?: WebMode }));
              else if (request.method === "DELETE") sendJson(response, 200, deleteConversation(conversationId));
              else sendJson(response, 405, { error: "Unsupported conversation operation." });
            }
            else if (url === "/api/profiles" && request.method === "POST") sendJson(response, 201, saveProfile(await readBody(request) as ProfileInput));
            else if (url?.startsWith("/api/profiles/") && request.method === "PATCH") sendJson(response, 200, saveProfile({ ...(await readBody(request) as ProfileInput), id: url.split("/")[3] }));
            else if (url?.startsWith("/api/profiles/") && request.method === "DELETE") sendJson(response, 200, deleteProfile(url.split("/")[3]));
            else if (url === "/api/memories" && request.method === "POST") sendJson(response, 201, await saveIndexedMemory(await readBody(request) as MemoryInput));
            else if (url === "/api/memories/search" && request.method === "POST") {
              const body = await readBody(request);
              if (typeof body.query !== "string" || !body.query.trim()) throw new Error("A memory query is required.");
              sendJson(response, 200, { results: await searchMemories(body.query) });
            }
            else if (url === "/api/memories/forget" && request.method === "POST") {
              const body = await readBody(request);
              if (typeof body.query !== "string" || !body.query.trim()) throw new Error("A memory description is required.");
              const normalized = body.query.trim().toLowerCase();
              const exact = getMemoryCandidates().find((memory) => memory.content.toLowerCase() === normalized || memory.content.toLowerCase().includes(normalized));
              if (exact) { deleteMemory(exact.id); sendJson(response, 200, { deleted: exact.id, content: exact.content }); }
              else {
                const match = (await searchMemories(body.query))[0];
                if (!match || match.relevance < 0.42) sendJson(response, 404, { error: "No close approved memory was found." });
                else { deleteMemory(match.id); sendJson(response, 200, { deleted: match.id, content: match.content }); }
              }
            }
            else if (url?.startsWith("/api/memories/") && request.method === "PATCH") sendJson(response, 200, await saveIndexedMemory({ ...(await readBody(request) as MemoryInput), id: url.split("/")[3] }));
            else if (url?.startsWith("/api/memories/") && request.method === "DELETE") sendJson(response, 200, deleteMemory(url.split("/")[3]));
            else if (url === "/api/settings" && request.method === "PATCH") sendJson(response, 200, saveSettings(await readBody(request) as SettingsInput));
            else if (url === "/api/web/search" && request.method === "POST") {
              const body = await readBody(request);
              if (typeof body.query !== "string" || !body.query.trim()) throw new Error("A web search query is required.");
              sendJson(response, 200, await searchWeb(body.query.slice(0, 500)));
            }
            else if (url === "/api/web/discover" && request.method === "POST") {
              const body = await readBody(request);
              if (typeof body.query !== "string" || !body.query.trim()) throw new Error("A web search query is required.");
              sendJson(response, 200, await discoverWeb(body.query));
            }
            else if (url === "/api/web/fetch" && request.method === "POST") {
              const body = await readBody(request);
              if (typeof body.query !== "string" || !body.query.trim()) throw new Error("A web search query is required.");
              if (!Array.isArray(body.results)) throw new Error("Select at least one webpage.");
              const selected = body.results.map((candidate) => {
                if (!candidate || typeof candidate !== "object") throw new Error("A selected webpage is invalid.");
                const value = candidate as Record<string, unknown>;
                if (typeof value.id !== "string" || typeof value.url !== "string" || typeof value.title !== "string") throw new Error("A selected webpage is incomplete.");
                return {
                  id: value.id,
                  provider: getSettings().webProvider,
                  title: value.title.slice(0, 300),
                  url: value.url,
                  snippet: typeof value.snippet === "string" ? value.snippet.slice(0, 1_000) : "",
                } satisfies WebSearchHit;
              });
              if (!selected.length) throw new Error("Select at least one webpage.");
              sendJson(response, 200, await fetchWebSelection(body.query, selected));
            }
            else if (url === "/api/documents" && request.method === "POST") sendJson(response, 201, await ingestDocument(request));
            else if (url?.startsWith("/api/documents/") && request.method === "PATCH") {
              const body = await readBody(request); sendJson(response, 200, updateDocument(url.split("/")[3], body.enabled !== false));
            }
            else if (url?.startsWith("/api/documents/") && request.method === "DELETE") {
              const result = deleteDocument(url.split("/")[3]);
              if (result.deleteStoredFile && result.storedPath) await fs.rm(result.storedPath, { force: true });
              sendJson(response, 200, { deleted: result.deleted });
            }
            else if (url === "/api/rag/folders" && request.method === "POST") {
              const body = await readBody(request);
              if (typeof body.path !== "string" || !body.path.trim()) throw new Error("A folder path is required.");
              sendJson(response, 201, await registerFolder(body.path));
            }
            else if (url?.startsWith("/api/rag/folders/")) {
              const parts = url.split("/").filter(Boolean);
              const folderId = parts[3];
              if (!folderId) throw new Error("A registered folder id is required.");
              if (parts[4] === "scan" && request.method === "POST") sendJson(response, 202, startFolderScan(folderId));
              else if (parts[4] === "scan" && request.method === "DELETE") {
                const job = folderScanJobs.get(folderId);
                if (job) job.controller.abort();
                else {
                  const folder = getRagFolder(folderId) as { status?: string; lastScanStartedAt?: string } | null;
                  if ((folder?.status === "queued" || folder?.status === "scanning") && folder.lastScanStartedAt) cancelRagFolderScan(folderId, folder.lastScanStartedAt);
                }
                sendJson(response, job ? 202 : 200, { id: folderId, cancelRequested: Boolean(job) });
              }
              else if (request.method === "PATCH") {
                const body = await readBody(request);
                sendJson(response, 200, updateRagFolder(folderId, { enabled: body.enabled !== false }));
              }
              else if (request.method === "DELETE") {
                if (folderScanJobs.has(folderId)) throw new Error("Cancel the active folder scan before removing this folder.");
                sendJson(response, 200, deleteRagFolder(folderId, { deleteDocuments: true }));
              }
              else sendJson(response, 405, { error: "Unsupported registered-folder operation." });
            }
            else if (url === "/api/rag/search" && request.method === "POST") {
              const body = await readBody(request);
              if (typeof body.query !== "string" || !body.query.trim()) throw new Error("A search query is required.");
              sendJson(response, 200, { results: await searchDocuments(body.query) });
            }
            else if (url?.startsWith("/api/rag/citations/") && request.method === "GET") {
              const citation = getRagCitation(url.split("/")[4]);
              sendJson(response, citation ? 200 : 404, citation ?? { error: "The local passage is no longer available." });
            }
            else if (url === "/api/runtime/load" && request.method === "POST") {
              const body = await readBody(request);
              if (typeof body.modelKey !== "string") throw new Error("A unit key is required.");
              sendJson(response, 200, await loadModel(body.modelKey, Number(body.contextLength) || 8192));
            } else if (url === "/api/runtime/unload" && request.method === "POST") {
              try { await runLms(["unload", "voidcat-core"], 120_000); } catch { /* already unloaded */ }
              sendJson(response, 200, await runtimeStatus());
            } else if (url === "/api/chat" && request.method === "POST") await proxyChat(request, response);
            else sendJson(response, 404, { error: "Unknown local endpoint." });
          } catch (error) {
            if (!response.headersSent) sendJson(response, 500, { error: error instanceof Error ? error.message : "Local core failure" });
            else response.end();
          }
        })();
      });
    },
  };
}
