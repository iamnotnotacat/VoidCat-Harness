import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ProfileInput = { id?: string; name?: string; systemPrompt?: string; temperature?: number; maxTokens?: number };
export type MemoryInput = { id?: string; content?: string; category?: string; importance?: number; enabled?: boolean; embedding?: number[] };
export type WebMode = "off" | "ask" | "auto";
export type SettingsInput = {
  webProvider?: "duckduckgo" | "brave" | "tavily";
  webApiKey?: string;
  allowedDomains?: string;
  blockedDomains?: string;
  maxWebPages?: number;
  maxWebBytes?: number;
  memorySuggestions?: boolean;
};

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
  database.exec(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  database.exec("CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, created_at)");
  database.exec("CREATE INDEX IF NOT EXISTS chunks_document_idx ON document_chunks(document_id, chunk_index)");
  try { database.exec("ALTER TABLE messages ADD COLUMN sources_json TEXT"); } catch { /* migrated already */ }
  try { database.exec("ALTER TABLE memories ADD COLUMN embedding TEXT"); } catch { /* migrated already */ }
  try { database.exec("ALTER TABLE conversations ADD COLUMN web_mode TEXT NOT NULL DEFAULT 'ask'"); } catch { /* migrated already */ }

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
    documents: rows<Record<string, unknown>>("SELECT id, name, extension, size_bytes AS sizeBytes, chunk_count AS chunkCount, enabled, created_at AS createdAt, updated_at AS updatedAt FROM documents ORDER BY updated_at DESC")
      .map((document) => ({ ...document, enabled: Boolean(document.enabled) })),
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
};

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
  };
  const timestamp = now();
  const statement = db().prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");
  Object.entries(next).forEach(([key, value]) => statement.run(key, String(value), timestamp));
  return { ...next, webApiKey: undefined, hasWebApiKey: Boolean(next.webApiKey) };
}

export function createDocument(input: { id?: string; name: string; extension: string; storedPath: string; sizeBytes: number }, chunks: Array<{ content: string; embedding: number[] }>) {
  const id = input.id || randomUUID(); const timestamp = now(); const connection = db();
  connection.exec("BEGIN");
  try {
    connection.prepare("INSERT INTO documents (id, name, extension, stored_path, size_bytes, chunk_count, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)")
      .run(id, input.name, input.extension, input.storedPath, input.sizeBytes, chunks.length, timestamp, timestamp);
    const insert = connection.prepare("INSERT INTO document_chunks (id, document_id, chunk_index, content, embedding) VALUES (?, ?, ?, ?, ?)");
    chunks.forEach((chunk, index) => insert.run(randomUUID(), id, index, chunk.content, JSON.stringify(chunk.embedding)));
    connection.exec("COMMIT");
  } catch (error) { connection.exec("ROLLBACK"); throw error; }
  return { id, ...input, chunkCount: chunks.length, enabled: true, createdAt: timestamp, updatedAt: timestamp };
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
  const document = db().prepare("SELECT stored_path AS storedPath FROM documents WHERE id = ?").get(id) as { storedPath?: string } | undefined;
  db().prepare("DELETE FROM documents WHERE id = ?").run(id);
  return { deleted: id, storedPath: document?.storedPath };
}
