import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  cosineSimilarity,
  createRagVectorProbes,
  createRagVectorSignature,
  RAG_VECTOR_BANDS,
  RAG_VECTOR_BITS_PER_BAND,
  RAG_VECTOR_INDEX_VERSION,
} from "./voidcat-vector-index.ts";

export type ProfileInput = { id?: string; name?: string; systemPrompt?: string; temperature?: number; maxTokens?: number };
export type MemoryInput = { id?: string; content?: string; category?: string; importance?: number; enabled?: boolean; embedding?: number[] };
export type WebMode = "off" | "ask" | "auto";
export type HunterSourceSetting = { enabled: boolean; pollCadenceMs: number; requestBudgetPercent: number };
export type SettingsInput = {
  webProvider?: "duckduckgo" | "brave" | "tavily";
  webApiKey?: string;
  allowedDomains?: string;
  blockedDomains?: string;
  maxWebPages?: number;
  maxWebBytes?: number;
  memorySuggestions?: boolean;
  hunterSetupCompleted?: boolean;
  hunterSetupStep?: number;
  hunterSourceSettings?: Record<string, Partial<HunterSourceSetting>>;
};
export type RagFolderInput = { path: string; name?: string; recursive?: boolean; enabled?: boolean };
export type RagFolderPatch = { name?: string; recursive?: boolean; enabled?: boolean };
export type DocumentSourceInput = {
  kind: "upload" | "folder";
  folderId?: string;
  sourcePath?: string;
  relativePath?: string;
  modifiedAtMs?: number;
  sizeBytes?: number;
  fingerprint?: string;
  seenAt?: string;
};
export type RagDocumentInput = {
  id?: string;
  name: string;
  extension: string;
  storedPath: string;
  sizeBytes: number;
  source?: DocumentSourceInput;
};
export type RagIndexBatchOptions = { documentId?: string; limit?: number; retryFailed?: boolean };
export type RagVectorSearchOptions = {
  limit?: number;
  candidateLimit?: number;
  minScore?: number;
  probeRadius?: 0 | 1;
  folderIds?: string[];
  includeUploads?: boolean;
};

const MAX_RAG_INDEX_BATCH = 256;
const MAX_RAG_VECTOR_DIMENSIONS = 4096;
const MAX_RAG_SEARCH_CANDIDATES = 256;

let database: DatabaseSync | null = null;
const now = () => new Date().toISOString();

function db() {
  if (database) return database;
  const dataDirectory = path.resolve(process.cwd(), ".voidcat", "data");
  fs.mkdirSync(dataDirectory, { recursive: true });
  database = new DatabaseSync(path.join(dataDirectory, "voidcat.db"));
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec(`CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, system_prompt TEXT NOT NULL,
    temperature REAL NOT NULL DEFAULT 0.7, max_tokens INTEGER NOT NULL DEFAULT 2048,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  database.exec(`CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, profile_id TEXT,
    model_key TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    FOREIGN KEY(profile_id) REFERENCES profiles(id) ON DELETE SET NULL
  )`);
  database.exec(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
    content TEXT NOT NULL, created_at TEXT NOT NULL,
    FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  )`);
  database.exec(`CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY, content TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'general',
    importance INTEGER NOT NULL DEFAULT 3, enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  database.exec(`CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, extension TEXT NOT NULL, stored_path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL, chunk_count INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  database.exec(`CREATE TABLE IF NOT EXISTS document_chunks (
    id TEXT PRIMARY KEY, document_id TEXT NOT NULL, chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL, embedding TEXT NOT NULL,
    FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
  )`);
  // Versioned, additive RAG tables deliberately avoid mutating any experimental
  // folder/index schema a previous build may have left behind.
  database.exec(`CREATE TABLE IF NOT EXISTS rag_registered_folders_v1 (
    id TEXT PRIMARY KEY, folder_path TEXT NOT NULL, name TEXT NOT NULL,
    recursive INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1,
    scan_status TEXT NOT NULL DEFAULT 'idle', last_scan_started_at TEXT,
    last_scan_completed_at TEXT, last_error TEXT, total_file_count INTEGER NOT NULL DEFAULT 0,
    indexed_file_count INTEGER NOT NULL DEFAULT 0, skipped_file_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  database.exec(`CREATE TABLE IF NOT EXISTS rag_document_sources_v1 (
    document_id TEXT PRIMARY KEY, folder_id TEXT, source_kind TEXT NOT NULL DEFAULT 'upload',
    source_path TEXT, relative_path TEXT, source_modified_ms INTEGER,
    source_size_bytes INTEGER, source_fingerprint TEXT, last_seen_at TEXT NOT NULL,
    FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE,
    FOREIGN KEY(folder_id) REFERENCES rag_registered_folders_v1(id) ON DELETE SET NULL
  )`);
  database.exec(`CREATE TABLE IF NOT EXISTS rag_vector_index_v1 (
    chunk_id TEXT PRIMARY KEY, index_version INTEGER NOT NULL, dimensions INTEGER NOT NULL,
    signature TEXT NOT NULL, embedding_fingerprint TEXT NOT NULL, indexed_at TEXT NOT NULL,
    FOREIGN KEY(chunk_id) REFERENCES document_chunks(id) ON DELETE CASCADE
  )`);
  database.exec(`CREATE TABLE IF NOT EXISTS rag_vector_buckets_v1 (
    chunk_id TEXT NOT NULL, band INTEGER NOT NULL, bucket INTEGER NOT NULL,
    PRIMARY KEY(chunk_id, band),
    FOREIGN KEY(chunk_id) REFERENCES rag_vector_index_v1(chunk_id) ON DELETE CASCADE
  )`);
  database.exec(`CREATE TABLE IF NOT EXISTS rag_vector_errors_v1 (
    chunk_id TEXT PRIMARY KEY, reason TEXT NOT NULL, attempted_at TEXT NOT NULL,
    FOREIGN KEY(chunk_id) REFERENCES document_chunks(id) ON DELETE CASCADE
  )`);
  database.exec(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  database.exec("CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, created_at)");
  database.exec("CREATE INDEX IF NOT EXISTS chunks_document_idx ON document_chunks(document_id, chunk_index)");
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS rag_folder_path_v1_idx ON rag_registered_folders_v1(folder_path COLLATE NOCASE)");
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS rag_folder_source_v1_idx ON rag_document_sources_v1(folder_id, relative_path COLLATE NOCASE) WHERE folder_id IS NOT NULL AND relative_path IS NOT NULL");
  database.exec("CREATE INDEX IF NOT EXISTS rag_document_source_folder_v1_idx ON rag_document_sources_v1(folder_id, last_seen_at)");
  database.exec("CREATE INDEX IF NOT EXISTS rag_vector_bucket_lookup_v1_idx ON rag_vector_buckets_v1(band, bucket, chunk_id)");
  try { database.exec("ALTER TABLE messages ADD COLUMN sources_json TEXT"); } catch { /* migrated already */ }
  try { database.exec("ALTER TABLE memories ADD COLUMN embedding TEXT"); } catch { /* migrated already */ }
  try { database.exec("ALTER TABLE conversations ADD COLUMN web_mode TEXT NOT NULL DEFAULT 'ask'"); } catch { /* migrated already */ }
  try { database.exec("ALTER TABLE rag_registered_folders_v1 ADD COLUMN total_file_count INTEGER NOT NULL DEFAULT 0"); } catch { /* migrated already */ }
  try { database.exec("ALTER TABLE rag_registered_folders_v1 ADD COLUMN indexed_file_count INTEGER NOT NULL DEFAULT 0"); } catch { /* migrated already */ }
  try { database.exec("ALTER TABLE rag_registered_folders_v1 ADD COLUMN skipped_file_count INTEGER NOT NULL DEFAULT 0"); } catch { /* migrated already */ }
  database.prepare(`UPDATE rag_registered_folders_v1 SET scan_status = 'error',
    last_error = 'The previous folder scan was interrupted before it completed.', updated_at = ?
    WHERE scan_status IN ('queued', 'scanning')`).run(now());

  const profileCount = database.prepare("SELECT COUNT(*) AS count FROM profiles").get() as { count: number };
  if (profileCount.count === 0) {
    const timestamp = now();
    database.prepare("INSERT INTO profiles (id, name, system_prompt, temperature, max_tokens, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("default", "VoidCat Core", "You are a thoughtful, capable local AI assistant. Be direct, accurate, and transparent about uncertainty.", 0.7, 2048, timestamp, timestamp);
  }
  return database;
}

function rows<T>(statement: string, ...values: Array<string | number | null>) {
  return db().prepare(statement).all(...values) as T[];
}

export function getState() {
  const settings = getSettings();
  return {
    profiles: rows<Record<string, unknown>>("SELECT id, name, system_prompt AS systemPrompt, temperature, max_tokens AS maxTokens, created_at AS createdAt, updated_at AS updatedAt FROM profiles ORDER BY created_at"),
    conversations: rows<Record<string, unknown>>(`SELECT c.id, c.title, c.profile_id AS profileId, c.model_key AS modelKey, c.web_mode AS webMode,
      c.created_at AS createdAt, c.updated_at AS updatedAt, COUNT(m.id) AS messageCount,
      COALESCE((SELECT substr(content, 1, 100) FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1), '') AS preview
      FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id
      GROUP BY c.id ORDER BY c.updated_at DESC`),
    memories: rows<Record<string, unknown>>("SELECT id, content, category, importance, enabled, created_at AS createdAt, updated_at AS updatedAt FROM memories ORDER BY importance DESC, updated_at DESC")
      .map((memory) => ({ ...memory, enabled: Boolean(memory.enabled) })),
    documents: rows<Record<string, unknown>>(`SELECT d.id, d.name, d.extension, d.size_bytes AS sizeBytes,
      d.chunk_count AS chunkCount, d.enabled, d.created_at AS createdAt, d.updated_at AS updatedAt,
      s.source_kind AS sourceKind, s.folder_id AS folderId, s.source_path AS sourcePath,
      s.relative_path AS relativePath, s.source_modified_ms AS sourceModifiedAtMs,
      s.source_fingerprint AS sourceFingerprint
      FROM documents d LEFT JOIN rag_document_sources_v1 s ON s.document_id = d.id
      ORDER BY d.updated_at DESC`)
      .map((document) => ({ ...document, enabled: Boolean(document.enabled) })),
    ragFolders: listRagFolders(),
    ragIndex: getRagVectorIndexStats(),
    settings: { ...settings, webApiKey: undefined, hasWebApiKey: Boolean(settings.webApiKey) },
  };
}

export function createConversation(input: { title?: string; profileId?: string; modelKey?: string; webMode?: WebMode }) {
  const id = randomUUID(); const timestamp = now();
  db().prepare("INSERT INTO conversations (id, title, profile_id, model_key, web_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, input.title?.trim() || "New transmission", input.profileId || "default", input.modelKey || null, input.webMode || "ask", timestamp, timestamp);
  return getConversation(id);
}

export function getConversation(id: string) {
  const conversation = db().prepare("SELECT id, title, profile_id AS profileId, model_key AS modelKey, web_mode AS webMode, created_at AS createdAt, updated_at AS updatedAt FROM conversations WHERE id = ?").get(id);
  if (!conversation) return null;
  const messages = rows<Record<string, unknown>>("SELECT id, role, content, sources_json AS sourcesJson, created_at AS createdAt FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid", id)
    .map((message) => ({ ...message, sources: message.sourcesJson ? JSON.parse(String(message.sourcesJson)) : [], sourcesJson: undefined }));
  return { ...conversation, messages };
}

export function updateConversation(id: string, input: { title?: string; profileId?: string; modelKey?: string; webMode?: WebMode }) {
  const current = getConversation(id) as Record<string, unknown> | null;
  if (!current) return null;
  db().prepare("UPDATE conversations SET title = ?, profile_id = ?, model_key = ?, web_mode = ?, updated_at = ? WHERE id = ?")
    .run(input.title?.trim() || String(current.title), input.profileId ?? String(current.profileId || "default"), input.modelKey ?? (current.modelKey ? String(current.modelKey) : null), input.webMode ?? String(current.webMode || "ask"), now(), id);
  return getConversation(id);
}

export function deleteConversation(id: string) {
  db().prepare("DELETE FROM conversations WHERE id = ?").run(id);
  return { deleted: id };
}

export function addMessage(conversationId: string, role: string, content: string, sources: unknown[] = []) {
  const id = randomUUID(); const timestamp = now();
  db().prepare("INSERT INTO messages (id, conversation_id, role, content, sources_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, conversationId, role, content, JSON.stringify(sources), timestamp);
  const conversation = getConversation(conversationId) as { title?: string } | null;
  if (role === "user" && conversation?.title === "New transmission") {
    const title = content.replace(/\s+/g, " ").trim().slice(0, 56) || "New transmission";
    db().prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?").run(title, timestamp, conversationId);
  } else db().prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(timestamp, conversationId);
  return { id, conversationId, role, content, sources, createdAt: timestamp };
}

export function saveProfile(input: ProfileInput) {
  const timestamp = now();
  if (input.id && db().prepare("SELECT id FROM profiles WHERE id = ?").get(input.id)) {
    const current = db().prepare("SELECT * FROM profiles WHERE id = ?").get(input.id) as Record<string, unknown>;
    db().prepare("UPDATE profiles SET name = ?, system_prompt = ?, temperature = ?, max_tokens = ?, updated_at = ? WHERE id = ?")
      .run(input.name?.trim() || String(current.name), input.systemPrompt ?? String(current.system_prompt), input.temperature ?? Number(current.temperature), input.maxTokens ?? Number(current.max_tokens), timestamp, input.id);
    return { id: input.id };
  }
  const id = randomUUID();
  db().prepare("INSERT INTO profiles (id, name, system_prompt, temperature, max_tokens, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, input.name?.trim() || "New Assistant", input.systemPrompt?.trim() || "You are a helpful local AI assistant.", input.temperature ?? 0.7, input.maxTokens ?? 2048, timestamp, timestamp);
  return { id };
}

export function deleteProfile(id: string) {
  if (id === "default") throw new Error("The default profile cannot be deleted.");
  db().prepare("DELETE FROM profiles WHERE id = ?").run(id);
  return { deleted: id };
}

export function saveMemory(input: MemoryInput) {
  const timestamp = now();
  if (input.id && db().prepare("SELECT id FROM memories WHERE id = ?").get(input.id)) {
    const current = db().prepare("SELECT * FROM memories WHERE id = ?").get(input.id) as Record<string, unknown>;
    const nextContent = input.content?.trim() || String(current.content);
    const embedding = input.embedding ? JSON.stringify(input.embedding) : (nextContent === current.content ? current.embedding : null);
    db().prepare("UPDATE memories SET content = ?, category = ?, importance = ?, enabled = ?, embedding = ?, updated_at = ? WHERE id = ?")
      .run(nextContent, input.category ?? String(current.category), Math.max(1, Math.min(5, input.importance ?? Number(current.importance))), input.enabled === undefined ? Number(current.enabled) : Number(input.enabled), embedding as string | null, timestamp, input.id);
    return { id: input.id };
  }
  const id = randomUUID();
  if (!input.content?.trim()) throw new Error("Memory content cannot be empty.");
  db().prepare("INSERT INTO memories (id, content, category, importance, enabled, embedding, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, input.content.trim(), input.category || "general", Math.max(1, Math.min(5, input.importance ?? 3)), input.enabled === false ? 0 : 1, input.embedding ? JSON.stringify(input.embedding) : null, timestamp, timestamp);
  return { id };
}

export function deleteMemory(id: string) {
  db().prepare("DELETE FROM memories WHERE id = ?").run(id);
  return { deleted: id };
}

export function getMemoryCandidates() {
  return rows<{ id: string; content: string; category: string; importance: number; embedding: string | null }>(
    "SELECT id, content, category, importance, embedding FROM memories WHERE enabled = 1 ORDER BY importance DESC, updated_at DESC",
  );
}

export function getMemoryRecord(id: string) {
  return db().prepare("SELECT id, content, category, importance, enabled, embedding FROM memories WHERE id = ?").get(id) as { id: string; content: string; category: string; importance: number; enabled: number; embedding: string | null } | undefined;
}

export function setMemoryEmbedding(id: string, embedding: number[]) {
  db().prepare("UPDATE memories SET embedding = ? WHERE id = ?").run(JSON.stringify(embedding), id);
}

const defaultSettings = {
  webProvider: "duckduckgo" as const,
  webApiKey: "",
  allowedDomains: "",
  blockedDomains: "",
  maxWebPages: 3,
  maxWebBytes: 1_000_000,
  memorySuggestions: false,
  hunterSetupCompleted: false,
  hunterSetupStep: 0,
  hunterSourceSettings: {} as Record<string, HunterSourceSetting>,
};

function sanitizeHunterSourceSettings(value: unknown): Record<string, HunterSourceSetting> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const sanitized: Record<string, HunterSourceSetting> = {};
  for (const [sourceId, candidate] of Object.entries(value)) {
    if (!/^[a-z0-9][a-z0-9.-]{1,99}$/.test(sourceId) || !candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    if (typeof record.enabled !== "boolean") continue;
    const pollCadenceMs = Number(record.pollCadenceMs);
    const requestBudgetPercent = Number(record.requestBudgetPercent ?? 100);
    if (!Number.isFinite(pollCadenceMs) || pollCadenceMs < 30_000 || pollCadenceMs > 12 * 60 * 60_000) continue;
    if (!Number.isFinite(requestBudgetPercent) || requestBudgetPercent < 10 || requestBudgetPercent > 100) continue;
    sanitized[sourceId] = { enabled: record.enabled, pollCadenceMs: Math.round(pollCadenceMs), requestBudgetPercent: Math.round(requestBudgetPercent) };
  }
  return sanitized;
}

function parseHunterSourceSettings(value: string | undefined) {
  if (!value) return {};
  try { return sanitizeHunterSourceSettings(JSON.parse(value)); }
  catch { return {}; }
}

export function getSettings() {
  const saved = Object.fromEntries(rows<{ key: string; value: string }>("SELECT key, value FROM settings").map(({ key, value }) => [key, value]));
  return {
    webProvider: (["duckduckgo", "brave", "tavily"].includes(saved.webProvider) ? saved.webProvider : defaultSettings.webProvider) as "duckduckgo" | "brave" | "tavily",
    webApiKey: saved.webApiKey || "",
    allowedDomains: saved.allowedDomains || "",
    blockedDomains: saved.blockedDomains || "",
    maxWebPages: Number(saved.maxWebPages) || defaultSettings.maxWebPages,
    maxWebBytes: Number(saved.maxWebBytes) || defaultSettings.maxWebBytes,
    memorySuggestions: saved.memorySuggestions === "true",
    hunterSetupCompleted: saved.hunterSetupCompleted === "true",
    hunterSetupStep: Math.max(0, Math.min(4, Number(saved.hunterSetupStep) || defaultSettings.hunterSetupStep)),
    hunterSourceSettings: parseHunterSourceSettings(saved.hunterSourceSettings),
  };
}

export function saveSettings(input: SettingsInput) {
  const current = getSettings();
  const next = {
    webProvider: input.webProvider ?? current.webProvider,
    webApiKey: input.webApiKey === undefined ? current.webApiKey : input.webApiKey.trim(),
    allowedDomains: input.allowedDomains === undefined ? current.allowedDomains : input.allowedDomains.trim(),
    blockedDomains: input.blockedDomains === undefined ? current.blockedDomains : input.blockedDomains.trim(),
    maxWebPages: Math.max(1, Math.min(5, input.maxWebPages ?? current.maxWebPages)),
    maxWebBytes: Math.max(100_000, Math.min(3_000_000, input.maxWebBytes ?? current.maxWebBytes)),
    memorySuggestions: input.memorySuggestions ?? current.memorySuggestions,
    hunterSetupCompleted: input.hunterSetupCompleted ?? current.hunterSetupCompleted,
    hunterSetupStep: Math.max(0, Math.min(4, Math.round(input.hunterSetupStep ?? current.hunterSetupStep))),
    hunterSourceSettings: input.hunterSourceSettings === undefined ? current.hunterSourceSettings : sanitizeHunterSourceSettings(input.hunterSourceSettings),
  };
  const timestamp = now();
  const statement = db().prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");
    Object.entries(next).forEach(([key, value]) => statement.run(key, typeof value === "object" ? JSON.stringify(value) : String(value), timestamp));
  return { ...next, webApiKey: undefined, hasWebApiKey: Boolean(next.webApiKey) };
}

function writeDocumentSource(connection: DatabaseSync, documentId: string, input: DocumentSourceInput, timestamp: string) {
  if (input.kind === "folder" && (!input.folderId || !input.relativePath?.trim())) {
    throw new Error("Folder documents require a registered folder and relative path.");
  }
  connection.prepare(`INSERT INTO rag_document_sources_v1
    (document_id, folder_id, source_kind, source_path, relative_path, source_modified_ms,
      source_size_bytes, source_fingerprint, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(document_id) DO UPDATE SET folder_id = excluded.folder_id,
      source_kind = excluded.source_kind, source_path = excluded.source_path,
      relative_path = excluded.relative_path, source_modified_ms = excluded.source_modified_ms,
      source_size_bytes = excluded.source_size_bytes, source_fingerprint = excluded.source_fingerprint,
      last_seen_at = excluded.last_seen_at`)
    .run(documentId, input.folderId || null, input.kind, input.sourcePath || null,
      input.relativePath?.trim() || null, input.modifiedAtMs ?? null, input.sizeBytes ?? null,
      input.fingerprint || null, input.seenAt || timestamp);
}

export function createDocument(input: RagDocumentInput, chunks: Array<{ content: string; embedding: number[] }>) {
  const id = input.id || randomUUID(); const timestamp = now(); const connection = db();
  const source = input.source || { kind: "upload" as const, sourcePath: input.storedPath, sizeBytes: input.sizeBytes };
  connection.exec("BEGIN");
  try {
    connection.prepare("INSERT INTO documents (id, name, extension, stored_path, size_bytes, chunk_count, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)")
      .run(id, input.name, input.extension, input.storedPath, input.sizeBytes, chunks.length, timestamp, timestamp);
    const insert = connection.prepare("INSERT INTO document_chunks (id, document_id, chunk_index, content, embedding) VALUES (?, ?, ?, ?, ?)");
    chunks.forEach((chunk, index) => insert.run(randomUUID(), id, index, chunk.content, JSON.stringify(chunk.embedding)));
    writeDocumentSource(connection, id, source, timestamp);
    connection.exec("COMMIT");
  } catch (error) { connection.exec("ROLLBACK"); throw error; }
  return { id, name: input.name, extension: input.extension, sizeBytes: input.sizeBytes, chunkCount: chunks.length,
    enabled: true, sourceKind: source.kind, folderId: source.folderId, relativePath: source.relativePath,
    createdAt: timestamp, updatedAt: timestamp };
}

function mapFolder(folder: Record<string, unknown>) {
  const documentCount = Number(folder.documentCount || 0);
  const indexedFileCount = Number(folder.indexedFileCount || 0) || (folder.status === "ready" ? documentCount : 0);
  const skippedFileCount = Number(folder.skippedFileCount || 0);
  return { ...folder, documentCount, indexedFileCount, skippedFileCount,
    totalFileCount: Math.max(Number(folder.totalFileCount || 0), indexedFileCount + skippedFileCount),
    recursive: Boolean(folder.recursive), enabled: Boolean(folder.enabled) };
}

export function listRagFolders() {
  return rows<Record<string, unknown>>(`SELECT f.id, f.folder_path AS path, f.name, f.recursive, f.enabled,
    f.scan_status AS status, f.last_scan_started_at AS lastScanStartedAt,
    f.last_scan_completed_at AS lastScannedAt, f.last_error AS error,
    f.total_file_count AS totalFileCount, f.indexed_file_count AS indexedFileCount,
    f.skipped_file_count AS skippedFileCount,
    f.created_at AS createdAt, f.updated_at AS updatedAt,
    (SELECT COUNT(*) FROM rag_document_sources_v1 s WHERE s.folder_id = f.id) AS documentCount
    FROM rag_registered_folders_v1 f ORDER BY f.name COLLATE NOCASE, f.folder_path COLLATE NOCASE`).map(mapFolder);
}

export function getRagFolder(id: string) {
  const folder = db().prepare(`SELECT f.id, f.folder_path AS path, f.name, f.recursive, f.enabled,
    f.scan_status AS status, f.last_scan_started_at AS lastScanStartedAt,
    f.last_scan_completed_at AS lastScannedAt, f.last_error AS error,
    f.total_file_count AS totalFileCount, f.indexed_file_count AS indexedFileCount,
    f.skipped_file_count AS skippedFileCount,
    f.created_at AS createdAt, f.updated_at AS updatedAt,
    (SELECT COUNT(*) FROM rag_document_sources_v1 s WHERE s.folder_id = f.id) AS documentCount
    FROM rag_registered_folders_v1 f WHERE f.id = ?`).get(id) as Record<string, unknown> | undefined;
  return folder ? mapFolder(folder) : null;
}

export function registerRagFolder(input: RagFolderInput) {
  const rawPath = input.path?.trim();
  if (!rawPath) throw new Error("A folder path is required.");
  const folderPath = path.resolve(rawPath);
  const existing = db().prepare("SELECT id FROM rag_registered_folders_v1 WHERE folder_path = ? COLLATE NOCASE").get(folderPath) as { id: string } | undefined;
  if (existing) return updateRagFolder(existing.id, input);

  const id = randomUUID();
  const timestamp = now();
  db().prepare(`INSERT INTO rag_registered_folders_v1
    (id, folder_path, name, recursive, enabled, scan_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'idle', ?, ?)`)
    .run(id, folderPath, input.name?.trim() || path.basename(folderPath) || folderPath,
      input.recursive === false ? 0 : 1, input.enabled === false ? 0 : 1, timestamp, timestamp);
  return getRagFolder(id);
}

export function updateRagFolder(id: string, input: RagFolderPatch) {
  const current = db().prepare("SELECT name, recursive, enabled FROM rag_registered_folders_v1 WHERE id = ?").get(id) as { name: string; recursive: number; enabled: number } | undefined;
  if (!current) return null;
  db().prepare("UPDATE rag_registered_folders_v1 SET name = ?, recursive = ?, enabled = ?, updated_at = ? WHERE id = ?")
    .run(input.name?.trim() || current.name, input.recursive === undefined ? current.recursive : Number(input.recursive),
      input.enabled === undefined ? current.enabled : Number(input.enabled), now(), id);
  return getRagFolder(id);
}

export function unregisterRagFolder(id: string, options: { deleteDocuments?: boolean } = {}) {
  const linked = rows<{ documentId: string }>("SELECT document_id AS documentId FROM rag_document_sources_v1 WHERE folder_id = ?", id);
  const connection = db();
  connection.exec("BEGIN");
  try {
    if (options.deleteDocuments) {
      const remove = connection.prepare("DELETE FROM documents WHERE id = ?");
      linked.forEach(({ documentId }) => remove.run(documentId));
    }
    connection.prepare("DELETE FROM rag_registered_folders_v1 WHERE id = ?").run(id);
    connection.exec("COMMIT");
  } catch (error) { connection.exec("ROLLBACK"); throw error; }
  return { deleted: id, linkedDocuments: linked.length, documentsDeleted: options.deleteDocuments ? linked.length : 0 };
}

export function deleteRagFolder(id: string, options: { deleteDocuments?: boolean } = {}) {
  return unregisterRagFolder(id, options);
}

export function beginRagFolderScan(id: string) {
  if (!getRagFolder(id)) throw new Error("Registered folder was not found.");
  const startedAt = now();
  db().prepare(`UPDATE rag_registered_folders_v1 SET scan_status = 'scanning', last_scan_started_at = ?,
    last_error = NULL, total_file_count = 0, indexed_file_count = 0, skipped_file_count = 0,
    updated_at = ? WHERE id = ?`)
    .run(startedAt, startedAt, id);
  return { id, startedAt };
}

export function finishRagFolderScan(id: string, input: { startedAt: string; error?: string }) {
  const timestamp = now();
  const scanStatus = input.error ? "error" : "ready";
  db().prepare(`UPDATE rag_registered_folders_v1 SET scan_status = ?, last_scan_completed_at = ?,
    last_error = ?, updated_at = ? WHERE id = ? AND last_scan_started_at = ?`)
    .run(scanStatus, timestamp, input.error?.slice(0, 1000) || null, timestamp, id, input.startedAt);
  return getRagFolder(id);
}

export function cancelRagFolderScan(id: string, startedAt: string) {
  db().prepare(`UPDATE rag_registered_folders_v1 SET scan_status = 'idle', last_error = NULL,
    updated_at = ? WHERE id = ? AND last_scan_started_at = ?`)
    .run(now(), id, startedAt);
  return getRagFolder(id);
}

export function updateRagFolderScanProgress(id: string, input: { totalFileCount?: number; indexedFileCount?: number; skippedFileCount?: number }) {
  const current = db().prepare(`SELECT total_file_count AS totalFileCount, indexed_file_count AS indexedFileCount,
    skipped_file_count AS skippedFileCount FROM rag_registered_folders_v1 WHERE id = ?`).get(id) as Record<string, number> | undefined;
  if (!current) return null;
  const bounded = (value: number | undefined, fallback: number) => Math.max(0, Math.min(1_000_000, Math.trunc(value ?? fallback)));
  db().prepare(`UPDATE rag_registered_folders_v1 SET total_file_count = ?, indexed_file_count = ?,
    skipped_file_count = ?, updated_at = ? WHERE id = ?`)
    .run(bounded(input.totalFileCount, current.totalFileCount), bounded(input.indexedFileCount, current.indexedFileCount),
      bounded(input.skippedFileCount, current.skippedFileCount), now(), id);
  return getRagFolder(id);
}

export function getFolderDocumentSource(folderId: string, relativePath: string) {
  return db().prepare(`SELECT s.document_id AS documentId, s.folder_id AS folderId, s.source_kind AS sourceKind,
    s.source_path AS sourcePath, s.relative_path AS relativePath, s.source_modified_ms AS modifiedAtMs,
    s.source_size_bytes AS sizeBytes, s.source_fingerprint AS fingerprint, s.last_seen_at AS lastSeenAt
    FROM rag_document_sources_v1 s WHERE s.folder_id = ? AND s.relative_path = ? COLLATE NOCASE`)
    .get(folderId, relativePath) as Record<string, unknown> | undefined;
}

export function listFolderDocumentSources(folderId: string, options: { afterRelativePath?: string; limit?: number } = {}) {
  const limit = Math.max(1, Math.min(1000, Math.trunc(options.limit || 250)));
  return rows<Record<string, unknown>>(`SELECT s.document_id AS documentId, s.folder_id AS folderId,
    s.source_path AS sourcePath, s.relative_path AS relativePath, s.source_modified_ms AS modifiedAtMs,
    s.source_size_bytes AS sizeBytes, s.source_fingerprint AS fingerprint, s.last_seen_at AS lastSeenAt
    FROM rag_document_sources_v1 s WHERE s.folder_id = ? AND COALESCE(s.relative_path, '') > ? COLLATE NOCASE
    ORDER BY s.relative_path COLLATE NOCASE LIMIT ?`, folderId, options.afterRelativePath || "", limit);
}

export function listStaleFolderDocumentSources(folderId: string, seenAfter: string, limit = 250) {
  const boundedLimit = Math.max(1, Math.min(1000, Math.trunc(limit)));
  return rows<{ documentId: string; relativePath: string }>(`SELECT document_id AS documentId,
    COALESCE(relative_path, '') AS relativePath FROM rag_document_sources_v1
    WHERE folder_id = ? AND last_seen_at < ? ORDER BY relative_path COLLATE NOCASE LIMIT ?`, folderId, seenAfter, boundedLimit);
}

export function touchDocumentSource(documentId: string, input: Partial<Omit<DocumentSourceInput, "kind">> = {}) {
  const timestamp = input.seenAt || now();
  db().prepare(`UPDATE rag_document_sources_v1 SET source_path = COALESCE(?, source_path),
    source_modified_ms = COALESCE(?, source_modified_ms), source_size_bytes = COALESCE(?, source_size_bytes),
    source_fingerprint = COALESCE(?, source_fingerprint), last_seen_at = ? WHERE document_id = ?`)
    .run(input.sourcePath || null, input.modifiedAtMs ?? null, input.sizeBytes ?? null, input.fingerprint || null, timestamp, documentId);
  return { documentId, seenAt: timestamp };
}

export function replaceDocumentContents(documentId: string, input: Omit<RagDocumentInput, "id">, chunks: Array<{ content: string; embedding: number[] }>) {
  const connection = db();
  if (!connection.prepare("SELECT id FROM documents WHERE id = ?").get(documentId)) throw new Error("Document was not found.");
  const timestamp = now();
  connection.exec("BEGIN");
  try {
    connection.prepare(`UPDATE documents SET name = ?, extension = ?, stored_path = ?, size_bytes = ?,
      chunk_count = ?, updated_at = ? WHERE id = ?`)
      .run(input.name, input.extension, input.storedPath, input.sizeBytes, chunks.length, timestamp, documentId);
    connection.prepare("DELETE FROM document_chunks WHERE document_id = ?").run(documentId);
    const insert = connection.prepare("INSERT INTO document_chunks (id, document_id, chunk_index, content, embedding) VALUES (?, ?, ?, ?, ?)");
    chunks.forEach((chunk, index) => insert.run(randomUUID(), documentId, index, chunk.content, JSON.stringify(chunk.embedding)));
    writeDocumentSource(connection, documentId, input.source || { kind: "upload", sourcePath: input.storedPath, sizeBytes: input.sizeBytes }, timestamp);
    connection.exec("COMMIT");
  } catch (error) { connection.exec("ROLLBACK"); throw error; }
  return { documentId, chunkCount: chunks.length, updatedAt: timestamp };
}

export function upsertFolderDocument(input: Omit<RagDocumentInput, "id" | "source"> & {
  folderId: string; sourcePath: string; relativePath: string; modifiedAtMs?: number; fingerprint?: string; seenAt?: string;
}, chunks: Array<{ content: string; embedding: number[] }>) {
  const source: DocumentSourceInput = { kind: "folder", folderId: input.folderId, sourcePath: input.sourcePath,
    relativePath: input.relativePath, modifiedAtMs: input.modifiedAtMs, sizeBytes: input.sizeBytes,
    fingerprint: input.fingerprint, seenAt: input.seenAt };
  const existing = getFolderDocumentSource(input.folderId, input.relativePath) as { documentId?: string } | undefined;
  const documentInput = { name: input.name, extension: input.extension, storedPath: input.storedPath, sizeBytes: input.sizeBytes, source };
  if (!existing?.documentId) return createDocument(documentInput, chunks);
  const replaced = replaceDocumentContents(existing.documentId, documentInput, chunks);
  return { id: replaced.documentId, name: input.name, extension: input.extension, sizeBytes: input.sizeBytes,
    chunkCount: replaced.chunkCount, enabled: true, sourceKind: "folder", folderId: input.folderId,
    relativePath: input.relativePath, updatedAt: replaced.updatedAt };
}

function parseEmbedding(serialized: string) {
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_RAG_VECTOR_DIMENSIONS || !parsed.every(Number.isFinite)) {
    throw new Error("Stored embedding is invalid.");
  }
  return parsed as number[];
}

export function indexPendingRagVectors(options: RagIndexBatchOptions = {}) {
  const limit = Math.max(1, Math.min(MAX_RAG_INDEX_BATCH, Math.trunc(options.limit || 64)));
  const conditions = [`(v.chunk_id IS NULL OR v.index_version <> ${RAG_VECTOR_INDEX_VERSION})`];
  const values: Array<string | number | null> = [];
  if (!options.retryFailed) conditions.push("e.chunk_id IS NULL");
  if (options.documentId) { conditions.push("c.document_id = ?"); values.push(options.documentId); }
  values.push(limit);
  const pending = rows<{ chunkId: string; embedding: string }>(`SELECT c.id AS chunkId, c.embedding
    FROM document_chunks c
    LEFT JOIN rag_vector_index_v1 v ON v.chunk_id = c.id
    LEFT JOIN rag_vector_errors_v1 e ON e.chunk_id = c.id
    WHERE ${conditions.join(" AND ")} ORDER BY c.document_id, c.chunk_index LIMIT ?`, ...values);

  const indexed: Array<{ chunkId: string; signature: ReturnType<typeof createRagVectorSignature> }> = [];
  const failed: Array<{ chunkId: string; reason: string }> = [];
  pending.forEach(({ chunkId, embedding }) => {
    try { indexed.push({ chunkId, signature: createRagVectorSignature(parseEmbedding(embedding)) }); }
    catch (error) { failed.push({ chunkId, reason: error instanceof Error ? error.message : "Invalid embedding." }); }
  });

  const connection = db();
  const timestamp = now();
  connection.exec("BEGIN");
  try {
    const upsertVector = connection.prepare(`INSERT INTO rag_vector_index_v1
      (chunk_id, index_version, dimensions, signature, embedding_fingerprint, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(chunk_id) DO UPDATE SET index_version = excluded.index_version,
      dimensions = excluded.dimensions, signature = excluded.signature,
      embedding_fingerprint = excluded.embedding_fingerprint, indexed_at = excluded.indexed_at`);
    const deleteBuckets = connection.prepare("DELETE FROM rag_vector_buckets_v1 WHERE chunk_id = ?");
    const insertBucket = connection.prepare("INSERT INTO rag_vector_buckets_v1 (chunk_id, band, bucket) VALUES (?, ?, ?)");
    const clearError = connection.prepare("DELETE FROM rag_vector_errors_v1 WHERE chunk_id = ?");
    indexed.forEach(({ chunkId, signature }) => {
      upsertVector.run(chunkId, signature.version, signature.dimensions, signature.signature, signature.fingerprint, timestamp);
      deleteBuckets.run(chunkId);
      signature.buckets.forEach((bucket, band) => insertBucket.run(chunkId, band, bucket));
      clearError.run(chunkId);
    });
    const saveError = connection.prepare(`INSERT INTO rag_vector_errors_v1 (chunk_id, reason, attempted_at) VALUES (?, ?, ?)
      ON CONFLICT(chunk_id) DO UPDATE SET reason = excluded.reason, attempted_at = excluded.attempted_at`);
    failed.forEach(({ chunkId, reason }) => saveError.run(chunkId, reason.slice(0, 500), timestamp));
    connection.exec("COMMIT");
  } catch (error) { connection.exec("ROLLBACK"); throw error; }

  return { scanned: pending.length, indexed: indexed.length, failed: failed.length, limit,
    batchFull: pending.length === limit, stats: getRagVectorIndexStats(options.documentId) };
}

export function indexDocumentVectors(documentId: string, options: Omit<RagIndexBatchOptions, "documentId"> = {}) {
  return indexPendingRagVectors({ ...options, documentId });
}

export function clearRagVectorIndexErrors(documentId?: string) {
  const result = documentId
    ? db().prepare(`DELETE FROM rag_vector_errors_v1 WHERE chunk_id IN
      (SELECT id FROM document_chunks WHERE document_id = ?)`).run(documentId)
    : db().prepare("DELETE FROM rag_vector_errors_v1").run();
  return { cleared: Number(result.changes) };
}

export function getRagVectorIndexStats(documentId?: string) {
  const where = documentId ? "WHERE c.document_id = ?" : "";
  const result = db().prepare(`SELECT COUNT(*) AS totalChunks,
    COALESCE(SUM(CASE WHEN d.enabled = 1 THEN 1 ELSE 0 END), 0) AS enabledChunks,
    COALESCE(SUM(CASE WHEN v.chunk_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS indexedChunks,
    COALESCE(SUM(CASE WHEN d.enabled = 1 AND v.chunk_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS indexedEnabledChunks,
    COALESCE(SUM(CASE WHEN d.enabled = 1 AND e.chunk_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS failedEnabledChunks
    FROM document_chunks c JOIN documents d ON d.id = c.document_id
    LEFT JOIN rag_vector_index_v1 v ON v.chunk_id = c.id AND v.index_version = ${RAG_VECTOR_INDEX_VERSION}
    LEFT JOIN rag_vector_errors_v1 e ON e.chunk_id = c.id ${where}`)
    .get(...(documentId ? [documentId] : [])) as Record<string, number>;
  const enabledChunks = Number(result.enabledChunks || 0);
  const indexedEnabledChunks = Number(result.indexedEnabledChunks || 0);
  const failedEnabledChunks = Number(result.failedEnabledChunks || 0);
  return { indexVersion: RAG_VECTOR_INDEX_VERSION, bands: RAG_VECTOR_BANDS, bitsPerBand: RAG_VECTOR_BITS_PER_BAND,
    maxBatchSize: MAX_RAG_INDEX_BATCH, maxDimensions: MAX_RAG_VECTOR_DIMENSIONS,
    totalChunks: Number(result.totalChunks || 0), enabledChunks, indexedChunks: Number(result.indexedChunks || 0),
    indexedEnabledChunks, missingEnabledChunks: Math.max(0, enabledChunks - indexedEnabledChunks), failedEnabledChunks,
    pendingEnabledChunks: Math.max(0, enabledChunks - indexedEnabledChunks - failedEnabledChunks),
    coverage: enabledChunks === 0 ? 1 : indexedEnabledChunks / enabledChunks };
}

export function searchRagVectorIndex(queryEmbedding: number[], options: RagVectorSearchOptions = {}) {
  if (queryEmbedding.length > MAX_RAG_VECTOR_DIMENSIONS) throw new Error(`Embedding exceeds the ${MAX_RAG_VECTOR_DIMENSIONS}-dimension safety limit.`);
  const query = createRagVectorSignature(queryEmbedding);
  const probes = createRagVectorProbes(query.buckets, options.probeRadius ?? 1);
  const limit = Math.max(1, Math.min(50, Math.trunc(options.limit || 6)));
  const candidateLimit = Math.max(limit, Math.min(MAX_RAG_SEARCH_CANDIDATES, Math.trunc(options.candidateLimit || 96)));
  const valuesSql = probes.map(() => "(?, ?)").join(", ");
  const parameters: Array<string | number | null> = probes.flatMap(({ band, bucket }) => [band, bucket]);
  parameters.push(RAG_VECTOR_INDEX_VERSION, query.dimensions);

  const folderIds = [...new Set((options.folderIds || []).filter(Boolean))].slice(0, 32);
  let sourceFilter = "";
  if (folderIds.length) {
    const folderPlaceholders = folderIds.map(() => "?").join(", ");
    sourceFilter = options.includeUploads === false
      ? `AND s.folder_id IN (${folderPlaceholders})`
      : `AND (s.folder_id IN (${folderPlaceholders}) OR s.source_kind = 'upload')`;
    parameters.push(...folderIds);
  } else if (options.includeUploads === false) {
    sourceFilter = "AND s.source_kind = 'folder' AND s.folder_id IS NOT NULL";
  }
  parameters.push(candidateLimit);

  const candidates = rows<{ chunkId: string; documentId: string; documentName: string; chunkIndex: number;
    content: string; embedding: string; sourceKind: string | null; sourcePath: string | null;
    relativePath: string | null; folderId: string | null; bucketMatches: number }>(`WITH probes(band, bucket) AS (VALUES ${valuesSql})
    SELECT c.id AS chunkId, c.document_id AS documentId, d.name AS documentName,
      c.chunk_index AS chunkIndex, c.content, c.embedding, s.source_kind AS sourceKind,
      s.source_path AS sourcePath, s.relative_path AS relativePath, s.folder_id AS folderId,
      COUNT(*) AS bucketMatches
    FROM probes p
    JOIN rag_vector_buckets_v1 b ON b.band = p.band AND b.bucket = p.bucket
    JOIN rag_vector_index_v1 v ON v.chunk_id = b.chunk_id
    JOIN document_chunks c ON c.id = b.chunk_id
    JOIN documents d ON d.id = c.document_id
    LEFT JOIN rag_document_sources_v1 s ON s.document_id = d.id
    LEFT JOIN rag_registered_folders_v1 f ON f.id = s.folder_id
    WHERE d.enabled = 1 AND (s.source_kind IS NULL OR s.source_kind = 'upload'
      OR (s.source_kind = 'folder' AND f.enabled = 1))
      AND v.index_version = ? AND v.dimensions = ? ${sourceFilter}
    GROUP BY c.id ORDER BY bucketMatches DESC, d.updated_at DESC LIMIT ?`, ...parameters);

  return candidates.map((candidate) => {
    let score = Number.NEGATIVE_INFINITY;
    try { score = cosineSimilarity(queryEmbedding, parseEmbedding(candidate.embedding)); } catch { /* excluded below */ }
    return { chunkId: candidate.chunkId, documentId: candidate.documentId, documentName: candidate.documentName,
      chunkIndex: candidate.chunkIndex, content: candidate.content, score,
      bucketMatches: Number(candidate.bucketMatches), sourceKind: candidate.sourceKind || "upload",
      sourcePath: candidate.sourcePath, relativePath: candidate.relativePath, folderId: candidate.folderId,
      citationId: `rag:${candidate.documentId}:${candidate.chunkIndex}` };
  }).filter((candidate) => Number.isFinite(candidate.score) && candidate.score >= (options.minScore ?? -1))
    .sort((left, right) => right.score - left.score || right.bucketMatches - left.bucketMatches)
    .slice(0, limit);
}

export function getRagCitation(chunkId: string) {
  return db().prepare(`SELECT c.id AS chunkId, c.document_id AS documentId, d.name AS documentName,
    c.chunk_index AS chunkIndex, c.content, s.source_kind AS sourceKind, s.source_path AS sourcePath,
    s.relative_path AS relativePath, s.folder_id AS folderId
    FROM document_chunks c JOIN documents d ON d.id = c.document_id
    LEFT JOIN rag_document_sources_v1 s ON s.document_id = d.id WHERE c.id = ?`).get(chunkId) as Record<string, unknown> | undefined;
}

export function getRagChunks() {
  return rows<{ id: string; documentId: string; documentName: string; chunkIndex: number; content: string; embedding: string }>(`SELECT dc.id, dc.document_id AS documentId, d.name AS documentName,
    dc.chunk_index AS chunkIndex, dc.content, dc.embedding FROM document_chunks dc
    JOIN documents d ON d.id = dc.document_id WHERE d.enabled = 1`);
}

export function updateDocument(id: string, enabled: boolean) {
  db().prepare("UPDATE documents SET enabled = ?, updated_at = ? WHERE id = ?").run(Number(enabled), now(), id);
  return { id, enabled };
}

export function deleteDocument(id: string) {
  const document = db().prepare(`SELECT d.stored_path AS storedPath, s.source_kind AS sourceKind
    FROM documents d LEFT JOIN rag_document_sources_v1 s ON s.document_id = d.id WHERE d.id = ?`).get(id) as { storedPath?: string; sourceKind?: string } | undefined;
  db().prepare("DELETE FROM documents WHERE id = ?").run(id);
  // Never hand the original path of a registered-folder document to the
  // existing upload cleanup path, which deletes returned files from disk.
  const sourceKind = document?.sourceKind || "upload";
  return { deleted: id, sourceKind, deleteStoredFile: sourceKind !== "folder",
    storedPath: sourceKind === "folder" ? undefined : document?.storedPath };
}
