import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HunterSeekerPublicObservation } from "./hunter-seeker-service.ts";
import { cosineSimilarity, createRagVectorProbes, createRagVectorSignature } from "../voidcat-vector-index.ts";

export type HistoricalRetentionClass = "bulk" | "pinned" | "watchlist" | "trigger" | "derived" | "summary";
export type HistoricalRecordType = "summary" | "derived";
export type HistoryQuery = {
  entityId?: string;
  entityType?: string;
  sourceIds?: string[];
  bbox?: { west: number; south: number; east: number; north: number };
  startAt?: string;
  endAt?: string;
  limit?: number;
};
export type HistoricalObservation = HunterSeekerPublicObservation & {
  historical: true;
  recordedAt: string;
  historicalRetentionClass: HistoricalRetentionClass;
  protected: boolean;
};
export type HistoryRagRecord = {
  id: string;
  recordType: HistoricalRecordType;
  entityId: string | null;
  entityType: string | null;
  windowStart: string;
  windowEnd: string;
  sourceFeedIds: string[];
  sourceObservationIds: string[];
  title: string;
  content: string;
  retentionClass: "derived" | "summary";
  createdAt: string;
};
export type HistoryStatus = {
  enabled: boolean;
  initialized: boolean;
  databasePath: string;
  observationCount: number;
  summaryCount: number;
  derivedCount: number;
  vectorCount: number;
  oldestAt: string | null;
  newestAt: string | null;
  lastWriteAt: string | null;
  orphanVectors: number;
  databaseBytes: number;
  walBytes: number;
};
export type HistoryMaintenancePlan = {
  generatedAt: string;
  cutoffAt: string;
  candidates: Array<{ tier: "5-minute" | "hourly" | "6-hour" | "expiry"; records: number; bucketMs: number }>;
  protectedRecords: number;
  estimatedRecordsRemoved: number;
  mutatesData: false;
};

type HistoryStoreOptions = {
  dataRoot?: string;
  now?: () => number;
  ensureWriteAllowed?: (estimatedBytes: number) => Promise<void>;
  minimumFreeBytes?: number;
};

const SCHEMA_VERSION = 1;
const MAX_INGEST_BATCH = 2_500;
const MAX_QUERY_RESULTS = 2_000;
const MAX_RAG_CONTENT = 8_000;
const DAY = 86_400_000;

function iso(ms: number) { return new Date(ms).toISOString(); }
function finiteTime(value: string | undefined, fallback: number) { const parsed = value ? Date.parse(value) : Number.NaN; return Number.isFinite(parsed) ? parsed : fallback; }
function safeJson(value: unknown) { return JSON.stringify(value ?? {}); }
function parseJson<T>(value: string, fallback: T): T { try { return JSON.parse(value) as T; } catch { return fallback; } }
function checkCancelled(signal?: AbortSignal) { if (signal?.aborted) throw new Error("Historical maintenance was cancelled safely."); }
function stableId(parts: Array<string | number>) { return createHash("sha256").update(parts.join("\u001f")).digest("hex"); }
function isProtectedRetention(value: HistoricalRetentionClass) { return value !== "bulk"; }
function validateBbox(bbox: HistoryQuery["bbox"]) {
  if (!bbox) return;
  const values = [bbox.west, bbox.south, bbox.east, bbox.north];
  if (values.some((value) => !Number.isFinite(value)) || bbox.west < -180 || bbox.west > 180 || bbox.east < -180 || bbox.east > 180 || bbox.south < -90 || bbox.north > 90 || bbox.south > bbox.north) {
    throw new Error("Historical bounding box is invalid.");
  }
}

export class HunterHistoryStore {
  readonly dataRoot: string;
  readonly historyRoot: string;
  readonly databasePath: string;
  readonly replayRoot: string;
  private readonly now: () => number;
  private readonly ensureWriteAllowed: (estimatedBytes: number) => Promise<void>;
  private readonly minimumFreeBytes: number;
  private database: DatabaseSync | null = null;
  private enabled = false;
  private lastWriteAt: string | null = null;

  constructor(options: HistoryStoreOptions = {}) {
    this.dataRoot = path.resolve(options.dataRoot ?? path.join(process.cwd(), ".voidcat", "data"));
    this.historyRoot = path.join(this.dataRoot, "hunter");
    this.databasePath = path.join(this.historyRoot, "history.db");
    this.replayRoot = path.join(this.historyRoot, "replay");
    this.now = options.now ?? Date.now;
    this.ensureWriteAllowed = options.ensureWriteAllowed ?? (async () => undefined);
    this.minimumFreeBytes = options.minimumFreeBytes ?? 256 * 1024 * 1024;
  }

  private schema(database: DatabaseSync) {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(`CREATE TABLE IF NOT EXISTS history_metadata_v1 (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history_observations_v1 (
        observation_id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, entity_type TEXT NOT NULL,
        observed_at_ms INTEGER NOT NULL, source_feed_id TEXT NOT NULL,
        latitude REAL NOT NULL, longitude REAL NOT NULL, altitude_meters REAL, accuracy_meters REAL,
        confidence REAL NOT NULL, basis TEXT NOT NULL, retention_class TEXT NOT NULL DEFAULT 'bulk',
        protected INTEGER NOT NULL DEFAULT 0, provenance_json TEXT NOT NULL, attributes_json TEXT NOT NULL,
        recorded_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS history_entity_time_v1 ON history_observations_v1(entity_id, observed_at_ms DESC);
      CREATE INDEX IF NOT EXISTS history_bbox_time_v1 ON history_observations_v1(latitude, longitude, observed_at_ms DESC);
      CREATE INDEX IF NOT EXISTS history_source_time_v1 ON history_observations_v1(source_feed_id, observed_at_ms DESC);
      CREATE INDEX IF NOT EXISTS history_retention_time_v1 ON history_observations_v1(protected, retention_class, observed_at_ms);
      CREATE TABLE IF NOT EXISTS history_rag_records_v1 (
        id TEXT PRIMARY KEY, record_type TEXT NOT NULL, entity_id TEXT, entity_type TEXT,
        window_start_ms INTEGER NOT NULL, window_end_ms INTEGER NOT NULL,
        source_feed_ids_json TEXT NOT NULL, source_observation_ids_json TEXT NOT NULL,
        title TEXT NOT NULL, content TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}',
        retention_class TEXT NOT NULL, protected INTEGER NOT NULL DEFAULT 1,
        created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS history_rag_window_v1 ON history_rag_records_v1(window_start_ms, window_end_ms);
      CREATE TABLE IF NOT EXISTS history_rag_vectors_v1 (
        record_id TEXT PRIMARY KEY, index_version INTEGER NOT NULL, dimensions INTEGER NOT NULL,
        signature TEXT NOT NULL, embedding_fingerprint TEXT NOT NULL, embedding_json TEXT NOT NULL,
        indexed_at_ms INTEGER NOT NULL,
        FOREIGN KEY(record_id) REFERENCES history_rag_records_v1(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS history_rag_buckets_v1 (
        record_id TEXT NOT NULL, band INTEGER NOT NULL, bucket INTEGER NOT NULL,
        PRIMARY KEY(record_id, band),
        FOREIGN KEY(record_id) REFERENCES history_rag_vectors_v1(record_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS history_rag_bucket_lookup_v1 ON history_rag_buckets_v1(band, bucket);
    `);
    database.prepare("INSERT OR REPLACE INTO history_metadata_v1(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  }

  async enable() {
    if (this.database) { this.enabled = true; return this.status(); }
    await fs.mkdir(this.historyRoot, { recursive: true });
    const free = await fs.statfs(this.historyRoot);
    if (Number(free.bavail) * Number(free.bsize) < this.minimumFreeBytes) throw new Error("Historical recording requires at least 256 MiB of free disk space.");
    try { await fs.access(this.databasePath); }
    catch {
      await this.ensureWriteAllowed(1024 * 1024);
      const temporaryPath = `${this.databasePath}.${randomUUID()}.new`;
      const temporary = new DatabaseSync(temporaryPath);
      try { this.schema(temporary); const result = temporary.prepare("PRAGMA quick_check(1)").get() as Record<string, unknown>; if (String(Object.values(result)[0]).toLowerCase() !== "ok") throw new Error("New history database validation failed."); }
      finally { temporary.close(); }
      await fs.rename(temporaryPath, this.databasePath);
    }
    const database = new DatabaseSync(this.databasePath);
    try {
      this.schema(database);
      const result = database.prepare("PRAGMA quick_check(1)").get() as Record<string, unknown>;
      if (String(Object.values(result)[0]).toLowerCase() !== "ok") throw new Error("History database failed SQLite validation.");
      database.exec("PRAGMA journal_mode = WAL");
      this.database = database;
      this.enabled = true;
    } catch (error) { database.close(); throw error; }
    return this.status();
  }

  async openExisting() {
    if (this.database) return this.status();
    try { await fs.access(this.databasePath); } catch { return this.status(); }
    const database = new DatabaseSync(this.databasePath);
    try {
      database.exec("PRAGMA foreign_keys = ON");
      const version = database.prepare("SELECT value FROM history_metadata_v1 WHERE key='schema_version'").get() as { value?: string } | undefined;
      const checked = database.prepare("PRAGMA quick_check(1)").get() as Record<string, unknown>;
      if (Number(version?.value) !== SCHEMA_VERSION || String(Object.values(checked)[0]).toLowerCase() !== "ok") throw new Error("Existing history database failed schema or integrity validation.");
      this.database = database;
    } catch (error) { database.close(); throw error; }
    return this.status();
  }

  disable() { this.enabled = false; return this.status(); }
  close() { this.enabled = false; this.database?.close(); this.database = null; }
  isEnabled() { return this.enabled; }
  isInitialized() { return Boolean(this.database); }
  private requireDatabase() { if (!this.database) throw new Error("Historical storage is not initialized. Enable recording first."); return this.database; }

  async ingest(observations: readonly HunterSeekerPublicObservation[]) {
    if (!this.enabled || !observations.length) return { accepted: 0, duplicate: 0, persisted: false };
    const clean = observations.slice(0, MAX_INGEST_BATCH);
    const estimatedBytes = clean.reduce((total, observation) => total + Buffer.byteLength(safeJson(observation), "utf8") + 512, 0);
    await this.ensureWriteAllowed(estimatedBytes);
    const database = this.requireDatabase(); const recordedAt = this.now();
    const statement = database.prepare(`INSERT OR IGNORE INTO history_observations_v1
      (observation_id, entity_id, entity_type, observed_at_ms, source_feed_id, latitude, longitude,
       altitude_meters, accuracy_meters, confidence, basis, retention_class, protected,
       provenance_json, attributes_json, recorded_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let accepted = 0;
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const observation of clean) {
        const observedAt = finiteTime(observation.timestamp, recordedAt);
        const retention: HistoricalRetentionClass = observation.retentionClass === "derived" ? "derived" : observation.retentionClass === "protected" ? "pinned" : "bulk";
        const result = statement.run(observation.observationId.slice(0, 250), observation.entityId.slice(0, 250), observation.entityType.slice(0, 100), observedAt,
          observation.provenance.sourceFeedId.slice(0, 150), observation.position.latitude, observation.position.longitude,
          observation.position.altitudeMeters ?? null, observation.position.accuracyMeters ?? null, observation.confidence, observation.basis,
          retention, Number(isProtectedRetention(retention)), safeJson(observation.provenance), safeJson(observation.attributes), recordedAt);
        accepted += Number(result.changes);
      }
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
    if (accepted) this.lastWriteAt = iso(recordedAt);
    return { accepted, duplicate: clean.length - accepted, persisted: true };
  }

  query(input: HistoryQuery = {}): HistoricalObservation[] {
    validateBbox(input.bbox);
    const database = this.requireDatabase(); const where: string[] = []; const parameters: Array<string | number> = [];
    if (input.entityId) { where.push("entity_id = ?"); parameters.push(input.entityId.slice(0, 250)); }
    if (input.entityType) { where.push("entity_type = ?"); parameters.push(input.entityType.slice(0, 100)); }
    if (input.startAt) { where.push("observed_at_ms >= ?"); parameters.push(finiteTime(input.startAt, 0)); }
    if (input.endAt) { where.push("observed_at_ms <= ?"); parameters.push(finiteTime(input.endAt, this.now())); }
    if (input.sourceIds?.length) { const sources = [...new Set(input.sourceIds)].slice(0, 20); where.push(`source_feed_id IN (${sources.map(() => "?").join(",")})`); parameters.push(...sources); }
    if (input.bbox) {
      where.push("latitude BETWEEN ? AND ?"); parameters.push(input.bbox.south, input.bbox.north);
      if (input.bbox.west <= input.bbox.east) { where.push("longitude BETWEEN ? AND ?"); parameters.push(input.bbox.west, input.bbox.east); }
      else { where.push("(longitude >= ? OR longitude <= ?)"); parameters.push(input.bbox.west, input.bbox.east); }
    }
    const limit = Math.max(1, Math.min(MAX_QUERY_RESULTS, Math.round(input.limit ?? 500)));
    const rows = database.prepare(`SELECT * FROM history_observations_v1 ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY observed_at_ms DESC LIMIT ?`).all(...parameters, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.hydrateObservation(row));
  }

  private hydrateObservation(row: Record<string, unknown>): HistoricalObservation {
    return {
      observationId: String(row.observation_id), entityId: String(row.entity_id), entityType: String(row.entity_type),
      position: { latitude: Number(row.latitude), longitude: Number(row.longitude), ...(row.altitude_meters === null ? {} : { altitudeMeters: Number(row.altitude_meters) }), ...(row.accuracy_meters === null ? {} : { accuracyMeters: Number(row.accuracy_meters) }) },
      timestamp: iso(Number(row.observed_at_ms)), provenance: parseJson(String(row.provenance_json), { sourceFeedId: String(row.source_feed_id), fetchedAt: iso(Number(row.recorded_at_ms)), receivedAt: iso(Number(row.recorded_at_ms)), stalenessMs: 0 }),
      confidence: Number(row.confidence), basis: String(row.basis) as HistoricalObservation["basis"], retentionClass: String(row.retention_class) === "bulk" ? "bulk" : String(row.retention_class) === "derived" ? "derived" : "protected",
      attributes: parseJson(String(row.attributes_json), {}), historical: true, recordedAt: iso(Number(row.recorded_at_ms)),
      historicalRetentionClass: String(row.retention_class) as HistoricalRetentionClass, protected: Boolean(row.protected),
    };
  }

  protectObservation(observationId: string, retentionClass: "pinned" | "watchlist" | "trigger") {
    const result = this.requireDatabase().prepare("UPDATE history_observations_v1 SET retention_class = ?, protected = 1 WHERE observation_id = ?").run(retentionClass, observationId);
    return { updated: Number(result.changes), observationId, retentionClass };
  }

  async createDerivedEvent(input: { title: string; content: string; entityId?: string; entityType?: string; windowStart: string; windowEnd: string; sourceFeedIds: string[]; sourceObservationIds: string[]; metadata?: Record<string, unknown> }) {
    const title = input.title.trim().slice(0, 200); const content = input.content.trim().slice(0, MAX_RAG_CONTENT);
    if (!title || !content) throw new Error("A derived event requires a title and content.");
    const start = finiteTime(input.windowStart, Number.NaN); const end = finiteTime(input.windowEnd, Number.NaN);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new Error("Derived event time window is invalid.");
    await this.ensureWriteAllowed(Buffer.byteLength(content, "utf8") + Buffer.byteLength(title, "utf8") + 2_048);
    const id = randomUUID(); const now = this.now();
    this.requireDatabase().prepare(`INSERT INTO history_rag_records_v1
      (id, record_type, entity_id, entity_type, window_start_ms, window_end_ms, source_feed_ids_json, source_observation_ids_json, title, content, metadata_json, retention_class, protected, created_at_ms, updated_at_ms)
      VALUES (?, 'derived', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'derived', 1, ?, ?)`)
      .run(id, input.entityId?.slice(0, 250) ?? null, input.entityType?.slice(0, 100) ?? null, start, end, safeJson([...new Set(input.sourceFeedIds)].slice(0, 50)), safeJson([...new Set(input.sourceObservationIds)].slice(0, 500)), title, content, safeJson(input.metadata), now, now);
    this.lastWriteAt = iso(now); return { id };
  }

  private rowToRag(row: Record<string, unknown>): HistoryRagRecord {
    return { id: String(row.id), recordType: String(row.record_type) as HistoricalRecordType, entityId: row.entity_id === null ? null : String(row.entity_id), entityType: row.entity_type === null ? null : String(row.entity_type),
      windowStart: iso(Number(row.window_start_ms)), windowEnd: iso(Number(row.window_end_ms)), sourceFeedIds: parseJson(String(row.source_feed_ids_json), []), sourceObservationIds: parseJson(String(row.source_observation_ids_json), []),
      title: String(row.title), content: String(row.content), retentionClass: String(row.retention_class) as "derived" | "summary", createdAt: iso(Number(row.created_at_ms)) };
  }

  /** Builds bounded, protected comparison summaries without deleting raw positions. */
  async refreshRollingSummaries(windowMs = 7 * DAY, maximumEntities = 100) {
    const database = this.requireDatabase(); const end = this.now(); const start = end - Math.max(DAY, Math.min(30 * DAY, windowMs));
    const entities = database.prepare("SELECT entity_id FROM history_observations_v1 WHERE observed_at_ms BETWEEN ? AND ? GROUP BY entity_id HAVING COUNT(*) >= 2 ORDER BY MAX(observed_at_ms) DESC LIMIT ?")
      .all(start, end, Math.max(1, Math.min(100, maximumEntities))) as Array<{ entity_id: string }>;
    if (!entities.length) return { summaries: 0 };
    await this.ensureWriteAllowed(entities.length * 12_000);
    let summaries = 0;
    for (const { entity_id } of entities) {
      const rows = database.prepare("SELECT * FROM history_observations_v1 WHERE entity_id=? AND observed_at_ms BETWEEN ? AND ? ORDER BY observed_at_ms DESC LIMIT 500").all(entity_id, start, end) as Array<Record<string, unknown>>;
      if (rows.length < 2) continue;
      const first = rows.at(-1)!; const last = rows[0]; const sources = [...new Set(rows.map((row) => String(row.source_feed_id)))]; const ids = rows.map((row) => String(row.observation_id));
      const id = stableId(["rolling-summary-v1", entity_id, Math.floor(start / DAY), Math.floor(end / DAY)]);
      const title = `${String(last.entity_type)} ${entity_id} changed over time`;
      const content = `${entity_id} produced ${rows.length} observations from ${sources.join(", ")} between ${iso(Number(first.observed_at_ms))} and ${iso(Number(last.observed_at_ms))}. Its earliest retained position was ${Number(first.latitude).toFixed(5)}, ${Number(first.longitude).toFixed(5)} and its latest was ${Number(last.latitude).toFixed(5)}, ${Number(last.longitude).toFixed(5)}. This comparison is bounded to retained opt-in history and does not prove continuous tracking.`;
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare("DELETE FROM history_rag_buckets_v1 WHERE record_id=?").run(id);
        database.prepare("DELETE FROM history_rag_vectors_v1 WHERE record_id=?").run(id);
        database.prepare(`INSERT INTO history_rag_records_v1(id,record_type,entity_id,entity_type,window_start_ms,window_end_ms,source_feed_ids_json,source_observation_ids_json,title,content,metadata_json,retention_class,protected,created_at_ms,updated_at_ms)
          VALUES(?, 'summary', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'summary', 1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET window_start_ms=excluded.window_start_ms,window_end_ms=excluded.window_end_ms,source_feed_ids_json=excluded.source_feed_ids_json,source_observation_ids_json=excluded.source_observation_ids_json,title=excluded.title,content=excluded.content,metadata_json=excluded.metadata_json,updated_at_ms=excluded.updated_at_ms`)
          .run(id, entity_id, String(last.entity_type), Number(first.observed_at_ms), Number(last.observed_at_ms), safeJson(sources), safeJson(ids), title, content.slice(0, MAX_RAG_CONTENT), safeJson({ rollingComparison: true, observationCount: rows.length }), this.now(), this.now());
        if (!this.verifyVectorConsistency(database).valid) throw new Error("Rolling summary refresh would leave orphaned vectors.");
        database.exec("COMMIT"); summaries += 1;
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    }
    if (summaries) this.lastWriteAt = iso(this.now());
    return { summaries };
  }

  listPendingRagRecords(limit = 32) {
    return (this.requireDatabase().prepare(`SELECT r.* FROM history_rag_records_v1 r LEFT JOIN history_rag_vectors_v1 v ON v.record_id = r.id WHERE v.record_id IS NULL ORDER BY r.updated_at_ms ASC LIMIT ?`).all(Math.max(1, Math.min(100, limit))) as Array<Record<string, unknown>>).map((row) => this.rowToRag(row));
  }

  async indexRagRecords(records: Array<{ id: string; embedding: number[] }>) {
    await this.ensureWriteAllowed(records.slice(0, 100).reduce((total, record) => total + record.embedding.length * 16 + 1_024, 0));
    const database = this.requireDatabase(); const now = this.now(); let indexed = 0;
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const record of records.slice(0, 100)) {
        if (!database.prepare("SELECT 1 FROM history_rag_records_v1 WHERE id = ?").get(record.id)) continue;
        const signature = createRagVectorSignature(record.embedding);
        database.prepare(`INSERT INTO history_rag_vectors_v1(record_id,index_version,dimensions,signature,embedding_fingerprint,embedding_json,indexed_at_ms) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(record_id) DO UPDATE SET index_version=excluded.index_version,dimensions=excluded.dimensions,signature=excluded.signature,embedding_fingerprint=excluded.embedding_fingerprint,embedding_json=excluded.embedding_json,indexed_at_ms=excluded.indexed_at_ms`)
          .run(record.id, signature.version, signature.dimensions, signature.signature, signature.fingerprint, safeJson(record.embedding), now);
        database.prepare("DELETE FROM history_rag_buckets_v1 WHERE record_id = ?").run(record.id);
        const insert = database.prepare("INSERT INTO history_rag_buckets_v1(record_id,band,bucket) VALUES(?,?,?)");
        signature.buckets.forEach((bucket, band) => insert.run(record.id, band, bucket)); indexed += 1;
      }
      const consistency = this.verifyVectorConsistency(database); if (!consistency.valid) throw new Error("Historical vector consistency failed during indexing.");
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
    if (indexed) this.lastWriteAt = iso(now); return { indexed, consistency: this.verifyVectorConsistency() };
  }

  search(queryEmbedding: number[], limit = 8) {
    const database = this.requireDatabase(); const signature = createRagVectorSignature(queryEmbedding);
    const probes = createRagVectorProbes(signature.buckets, 1); const conditions = probes.map(() => "(band = ? AND bucket = ?)").join(" OR ");
    const args = probes.flatMap(({ band, bucket }) => [band, bucket]);
    const candidates = database.prepare(`SELECT record_id, COUNT(*) matches FROM history_rag_buckets_v1 WHERE ${conditions} GROUP BY record_id ORDER BY matches DESC LIMIT 192`).all(...args) as Array<{ record_id: string }>;
    const results = candidates.map(({ record_id }) => {
      const row = database.prepare("SELECT r.*, v.embedding_json FROM history_rag_records_v1 r JOIN history_rag_vectors_v1 v ON v.record_id=r.id WHERE r.id=?").get(record_id) as Record<string, unknown> | undefined;
      if (!row) return null;
      return { ...this.rowToRag(row), score: cosineSimilarity(queryEmbedding, parseJson(String(row.embedding_json), [] as number[])) };
    }).filter((value): value is HistoryRagRecord & { score: number } => Boolean(value && Number.isFinite(value.score))).sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(25, limit)));
    return results;
  }

  deleteRagRecord(id: string) {
    const database = this.requireDatabase(); let deleted = 0;
    database.exec("BEGIN IMMEDIATE");
    try { database.prepare("DELETE FROM history_rag_buckets_v1 WHERE record_id = ?").run(id); database.prepare("DELETE FROM history_rag_vectors_v1 WHERE record_id = ?").run(id); deleted = Number(database.prepare("DELETE FROM history_rag_records_v1 WHERE id = ?").run(id).changes); const check = this.verifyVectorConsistency(database); if (!check.valid) throw new Error("Historical source/vector deletion would leave orphaned vectors."); database.exec("COMMIT"); }
    catch (error) { database.exec("ROLLBACK"); throw error; }
    return { deleted, consistency: this.verifyVectorConsistency() };
  }

  verifyVectorConsistency(database = this.requireDatabase()) {
    const orphanVectors = Number((database.prepare("SELECT COUNT(*) count FROM history_rag_vectors_v1 v LEFT JOIN history_rag_records_v1 r ON r.id=v.record_id WHERE r.id IS NULL").get() as { count: number }).count);
    const orphanBuckets = Number((database.prepare("SELECT COUNT(*) count FROM history_rag_buckets_v1 b LEFT JOIN history_rag_vectors_v1 v ON v.record_id=b.record_id WHERE v.record_id IS NULL").get() as { count: number }).count);
    return { orphanVectors, orphanBuckets, valid: orphanVectors === 0 && orphanBuckets === 0 };
  }

  planMaintenance(retentionDays = 90): HistoryMaintenancePlan {
    const database = this.requireDatabase(); const now = this.now(); const cutoff = now - Math.max(7, Math.min(365, retentionDays)) * DAY;
    const ranges: Array<{ tier: HistoryMaintenancePlan["candidates"][number]["tier"]; before: number; after: number; bucketMs: number }> = [
      { tier: "5-minute", before: now - DAY, after: now - 7 * DAY, bucketMs: 5 * 60_000 },
      { tier: "hourly", before: now - 7 * DAY, after: now - 30 * DAY, bucketMs: 60 * 60_000 },
      { tier: "6-hour", before: now - 30 * DAY, after: cutoff, bucketMs: 6 * 60 * 60_000 },
      { tier: "expiry", before: cutoff, after: 0, bucketMs: DAY },
    ];
    const candidates = ranges.map((range) => {
      const row = database.prepare("SELECT COUNT(*) count FROM history_observations_v1 WHERE protected=0 AND retention_class='bulk' AND observed_at_ms < ? AND observed_at_ms >= ?").get(range.before, range.after) as { count: number };
      return { tier: range.tier, records: Number(row.count), bucketMs: range.bucketMs };
    });
    const protectedRecords = Number((database.prepare("SELECT COUNT(*) count FROM history_observations_v1 WHERE protected=1 OR retention_class <> 'bulk'").get() as { count: number }).count);
    return { generatedAt: iso(now), cutoffAt: iso(cutoff), candidates, protectedRecords, estimatedRecordsRemoved: candidates.reduce((total, candidate) => total + candidate.records, 0), mutatesData: false };
  }

  private insertSummary(database: DatabaseSync, rows: Array<Record<string, unknown>>, bucketMs: number) {
    if (!rows.length) return null;
    const first = rows.at(-1)!; const last = rows[0]; const ids = rows.map((row) => String(row.observation_id)); const sources = [...new Set(rows.map((row) => String(row.source_feed_id)))];
    const start = Number(first.observed_at_ms); const end = Number(last.observed_at_ms); const entityId = String(last.entity_id); const entityType = String(last.entity_type);
    const id = stableId(["summary-v1", entityId, Math.floor(start / bucketMs), bucketMs]);
    const title = `${entityType} ${entityId} historical movement summary`;
    const content = `${entityId} had ${rows.length} retained observations from ${sources.join(", ")} between ${iso(start)} and ${iso(end)}. Position changed from ${Number(first.latitude).toFixed(5)}, ${Number(first.longitude).toFixed(5)} to ${Number(last.latitude).toFixed(5)}, ${Number(last.longitude).toFixed(5)}. This is a downsampled historical summary; intermediate positions were intentionally pruned.`;
    database.prepare(`INSERT OR IGNORE INTO history_rag_records_v1(id,record_type,entity_id,entity_type,window_start_ms,window_end_ms,source_feed_ids_json,source_observation_ids_json,title,content,metadata_json,retention_class,protected,created_at_ms,updated_at_ms)
      VALUES(?, 'summary', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'summary', 1, ?, ?)`)
      .run(id, entityId, entityType, start, end, safeJson(sources), safeJson(ids.slice(0, 500)), title, content.slice(0, MAX_RAG_CONTENT), safeJson({ downsampled: true, originalCount: rows.length, bucketMs }), this.now(), this.now());
    return id;
  }

  async runMaintenance(retentionDays = 90, options: { signal?: AbortSignal; maximumGroups?: number } = {}) {
    checkCancelled(options.signal); const database = this.requireDatabase(); const now = this.now(); const cutoff = now - Math.max(7, Math.min(365, retentionDays)) * DAY;
    await fs.mkdir(this.replayRoot, { recursive: true });
    const backupPath = path.join(this.replayRoot, `history-maintenance-${iso(now).replaceAll(":", "-")}-${randomUUID().slice(0, 8)}.db`);
    const dbBytes = (await fs.stat(this.databasePath)).size; await this.ensureWriteAllowed(dbBytes + 1024 * 1024);
    const checkpoint = database.prepare("PRAGMA wal_checkpoint(FULL)").get() as { busy?: number; log?: number; checkpointed?: number };
    if (Number(checkpoint.busy ?? 0) !== 0 || Number(checkpoint.checkpointed ?? 0) < Number(checkpoint.log ?? 0)) throw new Error("History maintenance could not capture a complete WAL checkpoint; no records were changed.");
    await fs.copyFile(this.databasePath, backupPath);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try { const result = backup.prepare("PRAGMA quick_check(1)").get() as Record<string, unknown>; if (String(Object.values(result)[0]).toLowerCase() !== "ok") throw new Error("History maintenance backup failed validation."); } finally { backup.close(); }
    const tiers = [{ before: now - DAY, after: now - 7 * DAY, bucketMs: 5 * 60_000 }, { before: now - 7 * DAY, after: now - 30 * DAY, bucketMs: 60 * 60_000 }, { before: now - 30 * DAY, after: cutoff, bucketMs: 6 * 60 * 60_000 }, { before: cutoff, after: 0, bucketMs: DAY }];
    let groups = 0; let deleted = 0; let summaries = 0; const maximumGroups = Math.max(1, Math.min(1_000, options.maximumGroups ?? 100));
    for (const tier of tiers) {
      checkCancelled(options.signal);
      const keys = database.prepare(`SELECT entity_id, source_feed_id, CAST(observed_at_ms / ? AS INTEGER) bucket FROM history_observations_v1 WHERE protected=0 AND retention_class='bulk' AND observed_at_ms < ? AND observed_at_ms >= ? GROUP BY entity_id, source_feed_id, bucket ORDER BY bucket LIMIT ?`).all(tier.bucketMs, tier.before, tier.after, maximumGroups - groups) as Array<{ entity_id: string; source_feed_id: string; bucket: number }>;
      for (const key of keys) {
        checkCancelled(options.signal); if (groups >= maximumGroups) break;
        const rows = database.prepare("SELECT * FROM history_observations_v1 WHERE protected=0 AND retention_class='bulk' AND entity_id=? AND source_feed_id=? AND CAST(observed_at_ms / ? AS INTEGER)=? ORDER BY observed_at_ms DESC LIMIT 5000").all(key.entity_id, key.source_feed_id, tier.bucketMs, key.bucket) as Array<Record<string, unknown>>;
        if (rows.length <= 1 && tier.after > 0) { groups += 1; continue; }
        database.exec("BEGIN IMMEDIATE");
        try {
          if (rows.length > 1 && this.insertSummary(database, rows, tier.bucketMs)) summaries += 1;
          const keepId = tier.after > 0 ? String(rows[0]?.observation_id ?? "") : "";
          for (const row of rows) if (String(row.observation_id) !== keepId) deleted += Number(database.prepare("DELETE FROM history_observations_v1 WHERE observation_id=? AND protected=0").run(String(row.observation_id)).changes);
          const consistency = this.verifyVectorConsistency(database); if (!consistency.valid) throw new Error("Downsampling would leave orphaned historical vectors.");
          database.exec("COMMIT");
        } catch (error) { database.exec("ROLLBACK"); throw error; }
        groups += 1; await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (groups >= maximumGroups) break;
    }
    this.lastWriteAt = iso(this.now());
    return { deleted, summaries, groups, backupPath, consistency: this.verifyVectorConsistency(), vacuumUsed: false };
  }

  async status(): Promise<HistoryStatus> {
    let databaseBytes = 0; let walBytes = 0;
    try { databaseBytes = (await fs.stat(this.databasePath)).size; } catch { /* not initialized */ }
    try { walBytes = (await fs.stat(`${this.databasePath}-wal`)).size; } catch { /* no WAL */ }
    if (!this.database) return { enabled: this.enabled, initialized: databaseBytes > 0, databasePath: this.databasePath, observationCount: 0, summaryCount: 0, derivedCount: 0, vectorCount: 0, oldestAt: null, newestAt: null, lastWriteAt: this.lastWriteAt, orphanVectors: 0, databaseBytes, walBytes };
    const summary = this.database.prepare(`SELECT COUNT(*) observation_count, MIN(observed_at_ms) oldest, MAX(observed_at_ms) newest FROM history_observations_v1`).get() as { observation_count: number; oldest: number | null; newest: number | null };
    const rag = this.database.prepare("SELECT SUM(CASE WHEN record_type='summary' THEN 1 ELSE 0 END) summaries, SUM(CASE WHEN record_type='derived' THEN 1 ELSE 0 END) derived FROM history_rag_records_v1").get() as { summaries: number | null; derived: number | null };
    const vectorCount = Number((this.database.prepare("SELECT COUNT(*) count FROM history_rag_vectors_v1").get() as { count: number }).count);
    const consistency = this.verifyVectorConsistency();
    return { enabled: this.enabled, initialized: true, databasePath: this.databasePath, observationCount: Number(summary.observation_count), summaryCount: Number(rag.summaries ?? 0), derivedCount: Number(rag.derived ?? 0), vectorCount, oldestAt: summary.oldest === null ? null : iso(Number(summary.oldest)), newestAt: summary.newest === null ? null : iso(Number(summary.newest)), lastWriteAt: this.lastWriteAt, orphanVectors: consistency.orphanVectors + consistency.orphanBuckets, databaseBytes, walBytes };
  }
}
