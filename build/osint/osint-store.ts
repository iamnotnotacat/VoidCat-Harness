import { createHash, randomUUID } from "node:crypto";
import { lstatSync, promises as fs, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MockInvestigationResult } from "./mock-investigation-runtime.ts";

export const OSINT_STORE_SCHEMA_VERSION = 3;
export const OSINT_MAX_RAW_RESPONSE_BYTES = 256 * 1024;
export type OsintClearScope = "investigation" | "provider-cache" | "raw-responses" | "invocation-logs" | "decision-logs";

export class OsintStoreError extends Error {
  readonly code: "BUDGET_REJECTED" | "CANCELLED" | "CORRUPT_DATABASE" | "EXPORT_REQUIRED" | "INSUFFICIENT_DISK" | "NOT_INITIALIZED" | "PRODUCTION_EVICTION_LOCKED" | "UNSAFE_PATH" | "VALIDATION_FAILED";
  constructor(code: OsintStoreError["code"], message: string) { super(message); this.name = "OsintStoreError"; this.code = code; }
}

export type OsintStoreWriteGuard = (estimatedBytes: number, signal?: AbortSignal) => Promise<unknown>;
export type OsintRawResponse = { evidenceId: string; body: unknown; headers?: Record<string, unknown> };
export type OsintProviderCacheInput = {
  cacheKey: string; providerId: string; queryId: string; storedAt: string; expiresAt: string; sourceRetrievedAt: string;
  result: unknown; provenance: { provider: string; sourceRefs: string[]; termsUrl?: string };
};
export type OsintInvocationLogInput = {
  id?: string; investigationId?: string; providerId?: string; action: string; status: "started" | "completed" | "failed" | "cancelled";
  startedAt: string; completedAt?: string; durationMs?: number; externalCalls?: number; requestCost?: number; cacheStatus?: string; errorCode?: string; metadata?: unknown;
};
export type OsintDecisionLogInput = { id?: string; investigationId?: string; decisionType: string; decisionId: string; outcome: string; createdAt: string; detail: unknown };
export type OsintRateLimitStateInput = { providerId: string; windowStartedAt: string; used: number; limit: number; resetAt: string; updatedAt: string };
export type OsintConsistencyReport = { quickCheck: "ok" | string; foreignKeyViolations: number; orphanedRows: number; valid: boolean };

type StoreOptions = {
  dataRoot?: string;
  mode?: "production" | "synthetic";
  writeGuard: OsintStoreWriteGuard;
  now?: () => number;
  freeDiskBytes?: (targetPath: string) => Promise<number>;
  minimumFreeBytes?: number;
  maxRawResponseBytes?: number;
  productionEvictionApproved?: boolean;
};

const MIB = 1024 ** 2;
const REDACTED = "[REDACTED]";
const SECRET_KEYS = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|passwd|credential)$/i;
const QUERY_SECRET_KEYS = /^(key|api[-_]?key|access[-_]?token|token|secret|password|signature|sig)$/i;

function abort(signal?: AbortSignal) { if (signal?.aborted) throw new OsintStoreError("CANCELLED", "The OSINT storage operation was cancelled safely."); }
function isInside(root: string, candidate: string) { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function json(value: unknown) { return JSON.stringify(value ?? null); }
function bytes(value: unknown) { return Buffer.byteLength(json(value), "utf8"); }
function sha256(value: string | Buffer) { return createHash("sha256").update(value).digest("hex"); }
function rowValue(row: unknown) { return String(Object.values((row ?? {}) as Record<string, unknown>)[0] ?? "unknown").toLowerCase(); }

function redactUrl(value: string) {
  try {
    const parsed = new URL(value);
    for (const key of [...parsed.searchParams.keys()]) if (QUERY_SECRET_KEYS.test(key)) parsed.searchParams.set(key, REDACTED);
    if (parsed.username) parsed.username = REDACTED;
    if (parsed.password) parsed.password = REDACTED;
    return parsed.toString();
  } catch { return value; }
}

export function redactOsintValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return /^https?:\/\//i.test(value) ? redactUrl(value) : value;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 2_000).map((item) => redactOsintValue(item, seen));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 2_000)) output[key] = SECRET_KEYS.test(key) ? REDACTED : redactOsintValue(item, seen);
  return output;
}

export function boundAndRedactRawResponse(input: unknown, maximumBytes = OSINT_MAX_RAW_RESPONSE_BYTES) {
  const sanitized = redactOsintValue(input);
  const serialized = json(sanitized);
  const originalBytes = Buffer.byteLength(serialized, "utf8");
  if (originalBytes <= maximumBytes) return { value: sanitized, storedBytes: originalBytes, originalBytes, truncated: false, sha256: sha256(serialized) };
  const digest = sha256(serialized);
  const allowance = Math.max(0, maximumBytes - 256);
  let preview = Buffer.from(serialized, "utf8").subarray(0, allowance).toString("utf8");
  while (Buffer.byteLength(preview, "utf8") > allowance) preview = preview.slice(0, -1);
  const value = { truncated: true, originalBytes, sha256: digest, sanitizedPreview: preview };
  return { value, storedBytes: Buffer.byteLength(json(value), "utf8"), originalBytes, truncated: true, sha256: digest };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS osint_schema_v1 (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, migrated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS osint_investigations_v1 (id TEXT PRIMARY KEY, schema_version TEXT NOT NULL, seed_json TEXT NOT NULL, objective TEXT NOT NULL, authorization_mode TEXT NOT NULL, status TEXT NOT NULL, budget_json TEXT NOT NULL, plan_id TEXT, counts_json TEXT NOT NULL, warnings_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT);
CREATE TABLE IF NOT EXISTS osint_entities_v1 (investigation_id TEXT NOT NULL, id TEXT NOT NULL, schema_version TEXT NOT NULL, type TEXT NOT NULL, display_name TEXT NOT NULL, attributes_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(investigation_id,id), FOREIGN KEY(investigation_id) REFERENCES osint_investigations_v1(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS osint_entity_aliases_v1 (investigation_id TEXT NOT NULL, entity_id TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL, value TEXT NOT NULL, normalized_value TEXT NOT NULL, confidence REAL NOT NULL, first_seen_at TEXT, last_seen_at TEXT, evidence_ids_json TEXT NOT NULL, PRIMARY KEY(investigation_id,id), FOREIGN KEY(investigation_id,entity_id) REFERENCES osint_entities_v1(investigation_id,id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS osint_evidence_v1 (investigation_id TEXT NOT NULL, id TEXT NOT NULL, provider_id TEXT NOT NULL, source_type TEXT NOT NULL, source_ref TEXT NOT NULL, retrieved_at TEXT NOT NULL, observed_at TEXT, title TEXT NOT NULL, excerpt TEXT, url TEXT, mime_type TEXT, sha256 TEXT NOT NULL, byte_length INTEGER NOT NULL, sensitivity TEXT NOT NULL, cache_status TEXT NOT NULL, cache_age_ms INTEGER NOT NULL, cache_expires_at TEXT, attribution_json TEXT NOT NULL, metadata_json TEXT NOT NULL, raw_response_json TEXT, raw_response_bytes INTEGER NOT NULL DEFAULT 0, raw_original_bytes INTEGER NOT NULL DEFAULT 0, raw_truncated INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(investigation_id,id), FOREIGN KEY(investigation_id) REFERENCES osint_investigations_v1(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS osint_observations_v1 (investigation_id TEXT NOT NULL, id TEXT NOT NULL, entity_id TEXT NOT NULL, provider_id TEXT NOT NULL, observed_at TEXT NOT NULL, retrieved_at TEXT NOT NULL, attributes_json TEXT NOT NULL, confidence REAL NOT NULL, confidence_category TEXT NOT NULL, directness TEXT NOT NULL, freshness TEXT NOT NULL, coverage_limitations_json TEXT NOT NULL, PRIMARY KEY(investigation_id,id), FOREIGN KEY(investigation_id) REFERENCES osint_investigations_v1(id) ON DELETE CASCADE, FOREIGN KEY(investigation_id,entity_id) REFERENCES osint_entities_v1(investigation_id,id));
CREATE TABLE IF NOT EXISTS osint_observation_evidence_v1 (investigation_id TEXT NOT NULL, observation_id TEXT NOT NULL, evidence_id TEXT NOT NULL, PRIMARY KEY(investigation_id,observation_id,evidence_id), FOREIGN KEY(investigation_id,observation_id) REFERENCES osint_observations_v1(investigation_id,id) ON DELETE CASCADE, FOREIGN KEY(investigation_id,evidence_id) REFERENCES osint_evidence_v1(investigation_id,id));
CREATE TABLE IF NOT EXISTS osint_alias_evidence_v1 (investigation_id TEXT NOT NULL, alias_id TEXT NOT NULL, evidence_id TEXT NOT NULL, PRIMARY KEY(investigation_id,alias_id,evidence_id), FOREIGN KEY(investigation_id,alias_id) REFERENCES osint_entity_aliases_v1(investigation_id,id) ON DELETE CASCADE, FOREIGN KEY(investigation_id,evidence_id) REFERENCES osint_evidence_v1(investigation_id,id));
CREATE TABLE IF NOT EXISTS osint_claims_v1 (investigation_id TEXT NOT NULL, id TEXT NOT NULL, subject_entity_id TEXT NOT NULL, predicate TEXT NOT NULL, value_json TEXT NOT NULL, valid_from TEXT, valid_to TEXT, status TEXT NOT NULL, confidence REAL NOT NULL, confidence_category TEXT NOT NULL, explanation TEXT NOT NULL, PRIMARY KEY(investigation_id,id), FOREIGN KEY(investigation_id) REFERENCES osint_investigations_v1(id) ON DELETE CASCADE, FOREIGN KEY(investigation_id,subject_entity_id) REFERENCES osint_entities_v1(investigation_id,id));
CREATE TABLE IF NOT EXISTS osint_claim_evidence_v1 (investigation_id TEXT NOT NULL, claim_id TEXT NOT NULL, evidence_id TEXT NOT NULL, PRIMARY KEY(investigation_id,claim_id,evidence_id), FOREIGN KEY(investigation_id,claim_id) REFERENCES osint_claims_v1(investigation_id,id) ON DELETE CASCADE, FOREIGN KEY(investigation_id,evidence_id) REFERENCES osint_evidence_v1(investigation_id,id));
CREATE TABLE IF NOT EXISTS osint_claim_observations_v1 (investigation_id TEXT NOT NULL, claim_id TEXT NOT NULL, observation_id TEXT NOT NULL, PRIMARY KEY(investigation_id,claim_id,observation_id), FOREIGN KEY(investigation_id,claim_id) REFERENCES osint_claims_v1(investigation_id,id) ON DELETE CASCADE, FOREIGN KEY(investigation_id,observation_id) REFERENCES osint_observations_v1(investigation_id,id));
CREATE TABLE IF NOT EXISTS osint_relationships_v1 (investigation_id TEXT NOT NULL, id TEXT NOT NULL, source_entity_id TEXT NOT NULL, target_entity_id TEXT NOT NULL, type TEXT NOT NULL, direction TEXT NOT NULL, observed_at TEXT NOT NULL, valid_from TEXT, valid_to TEXT, confidence REAL NOT NULL, confidence_category TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(investigation_id,id), FOREIGN KEY(investigation_id) REFERENCES osint_investigations_v1(id) ON DELETE CASCADE, FOREIGN KEY(investigation_id,source_entity_id) REFERENCES osint_entities_v1(investigation_id,id), FOREIGN KEY(investigation_id,target_entity_id) REFERENCES osint_entities_v1(investigation_id,id));
CREATE TABLE IF NOT EXISTS osint_relationship_evidence_v1 (investigation_id TEXT NOT NULL, relationship_id TEXT NOT NULL, evidence_id TEXT NOT NULL, PRIMARY KEY(investigation_id,relationship_id,evidence_id), FOREIGN KEY(investigation_id,relationship_id) REFERENCES osint_relationships_v1(investigation_id,id) ON DELETE CASCADE, FOREIGN KEY(investigation_id,evidence_id) REFERENCES osint_evidence_v1(investigation_id,id));
CREATE TABLE IF NOT EXISTS osint_contradictions_v1 (investigation_id TEXT NOT NULL, id TEXT NOT NULL, subject_entity_id TEXT NOT NULL, predicate TEXT NOT NULL, claim_ids_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(investigation_id,id), FOREIGN KEY(investigation_id) REFERENCES osint_investigations_v1(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS osint_contradiction_claims_v1 (investigation_id TEXT NOT NULL, contradiction_id TEXT NOT NULL, claim_id TEXT NOT NULL, PRIMARY KEY(investigation_id,contradiction_id,claim_id), FOREIGN KEY(investigation_id,contradiction_id) REFERENCES osint_contradictions_v1(investigation_id,id) ON DELETE CASCADE, FOREIGN KEY(investigation_id,claim_id) REFERENCES osint_claims_v1(investigation_id,id));
CREATE TABLE IF NOT EXISTS osint_identity_links_v2 (investigation_id TEXT NOT NULL, id TEXT NOT NULL, canonical_entity_id TEXT NOT NULL, match_kind TEXT NOT NULL, detail_json TEXT NOT NULL, PRIMARY KEY(investigation_id,id), FOREIGN KEY(investigation_id) REFERENCES osint_investigations_v1(id) ON DELETE CASCADE, FOREIGN KEY(investigation_id,canonical_entity_id) REFERENCES osint_entities_v1(investigation_id,id));
CREATE TABLE IF NOT EXISTS osint_claim_conclusions_v2 (investigation_id TEXT NOT NULL, claim_id TEXT NOT NULL, assessment_json TEXT NOT NULL, PRIMARY KEY(investigation_id,claim_id), FOREIGN KEY(investigation_id,claim_id) REFERENCES osint_claims_v1(investigation_id,id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS osint_temporal_changes_v2 (investigation_id TEXT NOT NULL, id TEXT NOT NULL, entity_id TEXT NOT NULL, predicate TEXT NOT NULL, change_type TEXT NOT NULL, from_claim_id TEXT NOT NULL, to_claim_id TEXT NOT NULL, observed_at TEXT NOT NULL, detail_json TEXT NOT NULL, PRIMARY KEY(investigation_id,id), FOREIGN KEY(investigation_id) REFERENCES osint_investigations_v1(id) ON DELETE CASCADE, FOREIGN KEY(investigation_id,entity_id) REFERENCES osint_entities_v1(investigation_id,id), FOREIGN KEY(investigation_id,from_claim_id) REFERENCES osint_claims_v1(investigation_id,id), FOREIGN KEY(investigation_id,to_claim_id) REFERENCES osint_claims_v1(investigation_id,id));
CREATE TABLE IF NOT EXISTS osint_contradiction_details_v2 (investigation_id TEXT NOT NULL, contradiction_id TEXT NOT NULL, detail_json TEXT NOT NULL, PRIMARY KEY(investigation_id,contradiction_id), FOREIGN KEY(investigation_id,contradiction_id) REFERENCES osint_contradictions_v1(investigation_id,id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS osint_candidate_leads_v1 (investigation_id TEXT NOT NULL, id TEXT NOT NULL, entity_id TEXT NOT NULL, seed_json TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL, depth INTEGER NOT NULL, evidence_ids_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(investigation_id,id), FOREIGN KEY(investigation_id) REFERENCES osint_investigations_v1(id) ON DELETE CASCADE, FOREIGN KEY(investigation_id,entity_id) REFERENCES osint_entities_v1(investigation_id,id));
CREATE TABLE IF NOT EXISTS osint_lead_evidence_v1 (investigation_id TEXT NOT NULL, lead_id TEXT NOT NULL, evidence_id TEXT NOT NULL, PRIMARY KEY(investigation_id,lead_id,evidence_id), FOREIGN KEY(investigation_id,lead_id) REFERENCES osint_candidate_leads_v1(investigation_id,id) ON DELETE CASCADE, FOREIGN KEY(investigation_id,evidence_id) REFERENCES osint_evidence_v1(investigation_id,id));
CREATE TABLE IF NOT EXISTS osint_provider_cache_v1 (cache_key TEXT PRIMARY KEY, provider_id TEXT NOT NULL, query_id TEXT NOT NULL, stored_at TEXT NOT NULL, expires_at TEXT NOT NULL, source_retrieved_at TEXT NOT NULL, result_json TEXT NOT NULL, result_bytes INTEGER NOT NULL, provenance_json TEXT NOT NULL, last_accessed_at TEXT NOT NULL, hit_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS osint_rate_limit_state_v1 (provider_id TEXT PRIMARY KEY, window_started_at TEXT NOT NULL, used INTEGER NOT NULL, request_limit INTEGER NOT NULL, reset_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS osint_invocation_logs_v1 (id TEXT PRIMARY KEY, investigation_id TEXT, provider_id TEXT, action TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT, duration_ms INTEGER, external_calls INTEGER NOT NULL DEFAULT 0, request_cost REAL NOT NULL DEFAULT 0, cache_status TEXT, error_code TEXT, metadata_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS osint_decision_logs_v1 (id TEXT PRIMARY KEY, investigation_id TEXT, decision_type TEXT NOT NULL, decision_id TEXT NOT NULL, outcome TEXT NOT NULL, created_at TEXT NOT NULL, detail_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS osint_project_investigations_v1 (investigation_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, accounted_bytes INTEGER NOT NULL, assigned_at TEXT NOT NULL, FOREIGN KEY(investigation_id) REFERENCES osint_investigations_v1(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS osint_project_unit_memories_v1 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, tool_name TEXT NOT NULL, summary_json TEXT NOT NULL, accounted_bytes INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS osint_project_investigations_project_idx ON osint_project_investigations_v1(project_id,assigned_at);
CREATE INDEX IF NOT EXISTS osint_project_unit_memories_project_idx ON osint_project_unit_memories_v1(project_id,created_at);
CREATE INDEX IF NOT EXISTS osint_evidence_provider_idx ON osint_evidence_v1(provider_id,retrieved_at);
CREATE INDEX IF NOT EXISTS osint_observation_time_idx ON osint_observations_v1(investigation_id,observed_at);
CREATE INDEX IF NOT EXISTS osint_cache_expiry_idx ON osint_provider_cache_v1(expires_at);
`;

export class OsintStore {
  readonly dataRoot: string;
  readonly storeRoot: string;
  readonly databasePath: string;
  readonly backupRoot: string;
  private readonly mode: "production" | "synthetic";
  private readonly writeGuard: OsintStoreWriteGuard;
  private readonly now: () => number;
  private readonly freeDiskBytes: (targetPath: string) => Promise<number>;
  private readonly minimumFreeBytes: number;
  private readonly maxRawResponseBytes: number;
  private readonly productionEvictionApproved: boolean;
  private database: DatabaseSync | null = null;
  private writing = false;

  constructor(options: StoreOptions) {
    if (typeof options.writeGuard !== "function") throw new OsintStoreError("VALIDATION_FAILED", "The OSINT store requires a fail-closed storage-budget write guard.");
    this.dataRoot = path.resolve(options.dataRoot ?? path.join(process.cwd(), ".voidcat", "data"));
    this.storeRoot = path.join(this.dataRoot, "osint"); this.databasePath = path.join(this.storeRoot, "osint.db"); this.backupRoot = path.join(this.storeRoot, "backups");
    this.mode = options.mode ?? "production"; this.writeGuard = options.writeGuard; this.now = options.now ?? Date.now;
    this.freeDiskBytes = options.freeDiskBytes ?? (async (target) => { const stats = await fs.statfs(target); return Number(stats.bavail) * Number(stats.bsize); });
    this.minimumFreeBytes = Math.max(0, options.minimumFreeBytes ?? 512 * MIB); this.maxRawResponseBytes = Math.max(1_024, Math.min(OSINT_MAX_RAW_RESPONSE_BYTES, options.maxRawResponseBytes ?? OSINT_MAX_RAW_RESPONSE_BYTES));
    this.productionEvictionApproved = options.productionEvictionApproved === true;
    if (this.mode === "synthetic") {
      const temp = realpathSync(os.tmpdir()); const root = realpathSync(this.dataRoot);
      if (lstatSync(this.dataRoot).isSymbolicLink() || !isInside(temp, root) || !path.basename(root).startsWith("voidcat-osint-test-")) throw new OsintStoreError("UNSAFE_PATH", "Synthetic OSINT operations are restricted to a disposable voidcat-osint-test-* directory.");
    }
  }

  private db() { if (!this.database) throw new OsintStoreError("NOT_INITIALIZED", "Initialize the isolated OSINT store before using it."); return this.database; }
  private async guard(estimatedBytes: number, signal?: AbortSignal) { abort(signal); try { await this.writeGuard(Math.max(1, Math.ceil(estimatedBytes)), signal); } catch (error) { if (error instanceof OsintStoreError) throw error; throw new OsintStoreError("BUDGET_REJECTED", error instanceof Error ? error.message : "The OSINT storage budget rejected the write."); } abort(signal); }
  private transaction<T>(operation: (database: DatabaseSync) => T, signal?: AbortSignal) {
    abort(signal); if (this.writing) throw new OsintStoreError("VALIDATION_FAILED", "Concurrent OSINT write transactions are not permitted.");
    const database = this.db(); this.writing = true; database.exec("BEGIN IMMEDIATE");
    try { abort(signal); const value = operation(database); abort(signal); database.exec("COMMIT"); return value; }
    catch (error) { try { database.exec("ROLLBACK"); } catch { /* retain original error */ } throw error; }
    finally { this.writing = false; }
  }

  private async createValidatedMigrationBackup(signal?: AbortSignal) {
    abort(signal);
    let checkpoint: DatabaseSync | null = null;
    try {
      checkpoint = new DatabaseSync(this.databasePath);
      checkpoint.exec("PRAGMA busy_timeout=3000;");
      const result = checkpoint.prepare("PRAGMA wal_checkpoint(FULL)").get() as { busy?: number; log?: number; checkpointed?: number } | undefined;
      const busy = Number(result?.busy ?? 0); const log = Number(result?.log ?? 0); const checkpointed = Number(result?.checkpointed ?? 0);
      if (busy !== 0 || checkpointed < log) throw new OsintStoreError("VALIDATION_FAILED", "The OSINT database has active writes; migration was not attempted.");
      if (rowValue(checkpoint.prepare("PRAGMA quick_check(1)").get()) !== "ok") throw new OsintStoreError("CORRUPT_DATABASE", "The OSINT database failed validation after its migration checkpoint.");
    } catch (error) {
      if (error instanceof OsintStoreError) throw error;
      throw new OsintStoreError("VALIDATION_FAILED", `The OSINT migration checkpoint could not be secured: ${error instanceof Error ? error.message : "unknown SQLite error"}`);
    } finally { checkpoint?.close(); }

    abort(signal);
    const backupPath = path.join(this.backupRoot, `pre-migration-${this.now()}-${randomUUID()}.db`);
    await fs.copyFile(this.databasePath, backupPath);
    abort(signal);
    let probe: DatabaseSync | null = null;
    try {
      probe = new DatabaseSync(backupPath, { readOnly: true });
      if (rowValue(probe.prepare("PRAGMA quick_check(1)").get()) !== "ok") throw new OsintStoreError("CORRUPT_DATABASE", "The OSINT pre-migration backup failed validation; migration was not attempted.");
    } finally { probe?.close(); }
    return backupPath;
  }

  async initialize(signal?: AbortSignal) {
    abort(signal); await this.guard(512 * 1024, signal); await fs.mkdir(this.storeRoot, { recursive: true }); await fs.mkdir(this.backupRoot, { recursive: true });
    const existing = await fs.stat(this.databasePath).then((item) => item.size).catch(() => 0);
    const walBytes = await fs.stat(`${this.databasePath}-wal`).then((item) => item.size).catch(() => 0);
    const shmBytes = await fs.stat(`${this.databasePath}-shm`).then((item) => item.size).catch(() => 0);
    const existingFootprint = existing + walBytes + shmBytes;
    if (existingFootprint > 512 * 1024) await this.guard(existingFootprint, signal);
    const free = await this.freeDiskBytes(this.storeRoot); if (free < this.minimumFreeBytes + existingFootprint) throw new OsintStoreError("INSUFFICIENT_DISK", "The OSINT migration reserve is not available.");
    let existingSchemaVersion: number | null = null;
    if (existing) {
      let probe: DatabaseSync | null = null;
      try {
        probe = new DatabaseSync(this.databasePath, { readOnly: true });
        if (rowValue(probe.prepare("PRAGMA quick_check(1)").get()) !== "ok") throw new Error("quick_check failed");
        try { existingSchemaVersion = Number((probe.prepare("SELECT version FROM osint_schema_v1 WHERE singleton=1").get() as { version?: number } | undefined)?.version ?? Number.NaN); }
        catch { existingSchemaVersion = null; }
        if (!Number.isInteger(existingSchemaVersion)) existingSchemaVersion = null;
      }
      catch { throw new OsintStoreError("CORRUPT_DATABASE", "The OSINT database failed validation; migration was not attempted."); }
      finally { probe?.close(); }
      if (existingSchemaVersion !== OSINT_STORE_SCHEMA_VERSION) await this.createValidatedMigrationBackup(signal);
    }
    const database = new DatabaseSync(this.databasePath); this.database = database;
    try {
      database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;");
      if (!existing || existingSchemaVersion !== OSINT_STORE_SCHEMA_VERSION) {
        database.exec("BEGIN IMMEDIATE");
        try { database.exec(SCHEMA); database.prepare("INSERT INTO osint_schema_v1(singleton,version,migrated_at) VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET version=excluded.version,migrated_at=excluded.migrated_at").run(OSINT_STORE_SCHEMA_VERSION, new Date(this.now()).toISOString()); database.exec("COMMIT"); }
        catch (error) { database.exec("ROLLBACK"); throw error; }
      }
      const consistency = this.checkConsistency(); if (!consistency.valid) throw new OsintStoreError("CORRUPT_DATABASE", "The migrated OSINT database failed consistency checks.");
      return { databasePath: this.databasePath, schemaVersion: OSINT_STORE_SCHEMA_VERSION, backupCreated: existing > 0 && existingSchemaVersion !== OSINT_STORE_SCHEMA_VERSION, consistency };
    } catch (error) { database.close(); this.database = null; throw error; }
  }

  close() { this.database?.close(); this.database = null; }

  status() {
    const database = this.db();
    const count = (table: string) => Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
    return {
      schemaVersion: OSINT_STORE_SCHEMA_VERSION,
      consistency: this.checkConsistency(),
      cleanup: this.productionEvictionApproved || this.mode === "synthetic" ? "available" as const : "approval-locked" as const,
      records: {
        investigations: count("osint_investigations_v1"),
        entities: count("osint_entities_v1"),
        observations: count("osint_observations_v1"),
        claims: count("osint_claims_v1"),
        relationships: count("osint_relationships_v1"),
        contradictions: count("osint_contradictions_v1"),
        identityLinks: count("osint_identity_links_v2"),
        conclusions: count("osint_claim_conclusions_v2"),
        changes: count("osint_temporal_changes_v2"),
        leads: count("osint_candidate_leads_v1"),
        providerCache: count("osint_provider_cache_v1"),
        rateLimits: count("osint_rate_limit_state_v1"),
        invocationLogs: count("osint_invocation_logs_v1"),
        decisionLogs: count("osint_decision_logs_v1"),
      },
    };
  }

  listInvestigations(limit = 100, projectId?: string) {
    const bounded = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = projectId ? this.db().prepare("SELECT i.* FROM osint_investigations_v1 i JOIN osint_project_investigations_v1 p ON p.investigation_id=i.id WHERE p.project_id=? ORDER BY i.updated_at DESC LIMIT ?").all(projectId, bounded) as Record<string, unknown>[] : this.db().prepare("SELECT * FROM osint_investigations_v1 ORDER BY updated_at DESC LIMIT ?").all(bounded) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id), schemaVersion: String(row.schema_version), seed: JSON.parse(String(row.seed_json)), objective: String(row.objective),
      authorizationMode: String(row.authorization_mode), status: String(row.status), budget: JSON.parse(String(row.budget_json)), planId: row.plan_id ? String(row.plan_id) : undefined,
      counts: JSON.parse(String(row.counts_json)), warnings: JSON.parse(String(row.warnings_json)), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      ...(row.completed_at ? { completedAt: String(row.completed_at) } : {}),
    }));
  }

  projectUsage(projectId: string) {
    const row = this.db().prepare("SELECT COALESCE(SUM(accounted_bytes),0) AS bytes, COUNT(*) AS investigations FROM osint_project_investigations_v1 WHERE project_id=?").get(projectId) as { bytes: number; investigations: number }; const unit = this.db().prepare("SELECT COALESCE(SUM(accounted_bytes),0) AS bytes, COUNT(*) AS memories FROM osint_project_unit_memories_v1 WHERE project_id=?").get(projectId) as { bytes: number; memories: number };
    return { bytes: Number(row.bytes || 0) + Number(unit.bytes || 0), investigations: Number(row.investigations || 0), unitMemories: Number(unit.memories || 0) };
  }

  async saveUnitMemory(input: { id: string; projectId: string; toolName: string; summary: unknown; limitBytes: number }, signal?: AbortSignal) {
    const bounded = boundAndRedactRawResponse(input.summary, 512 * 1024); const accountedBytes = bounded.storedBytes + 2_048; await this.guard(accountedBytes, signal); const usage = this.projectUsage(input.projectId); if (usage.bytes + accountedBytes > input.limitBytes) throw new OsintStoreError("BUDGET_REJECTED", "This project's persistent OSINT memory allotment is full.");
    return this.transaction((database) => { database.prepare("INSERT OR REPLACE INTO osint_project_unit_memories_v1(id,project_id,tool_name,summary_json,accounted_bytes,created_at) VALUES(?,?,?,?,?,?)").run(input.id, input.projectId, input.toolName, json(bounded.value), accountedBytes, new Date(this.now()).toISOString()); return { id: input.id, accountedBytes }; }, signal);
  }

  assignInvestigationProject(investigationId: string, projectId: string, accountedBytes: number, limitBytes: number) {
    if (!/^[0-9a-f-]{36}$|^default$/i.test(projectId)) throw new OsintStoreError("VALIDATION_FAILED", "A valid project id is required for persistent OSINT memory."); const database = this.db(); if (!database.prepare("SELECT id FROM osint_investigations_v1 WHERE id=?").get(investigationId)) throw new OsintStoreError("VALIDATION_FAILED", "The investigation must be saved before project assignment.");
    const current = this.projectUsage(projectId); const existing = database.prepare("SELECT accounted_bytes AS bytes FROM osint_project_investigations_v1 WHERE investigation_id=?").get(investigationId) as { bytes: number } | undefined; const projected = current.bytes - Number(existing?.bytes || 0) + Math.max(0, Math.round(accountedBytes));
    if (projected > limitBytes) throw new OsintStoreError("BUDGET_REJECTED", "This project's persistent OSINT memory allotment is full."); database.prepare("INSERT INTO osint_project_investigations_v1(investigation_id,project_id,accounted_bytes,assigned_at) VALUES(?,?,?,?) ON CONFLICT(investigation_id) DO UPDATE SET project_id=excluded.project_id,accounted_bytes=excluded.accounted_bytes,assigned_at=excluded.assigned_at").run(investigationId, projectId, Math.max(0, Math.round(accountedBytes)), new Date(this.now()).toISOString()); return this.projectUsage(projectId);
  }

  async saveInvestigationBundle(result: MockInvestigationResult, options: { rawResponses?: OsintRawResponse[]; signal?: AbortSignal } = {}) {
    const { investigation, correlation } = result; const raw = new Map((options.rawResponses ?? []).map((item) => [item.evidenceId, item]));
    const estimated = bytes(result) + [...raw.values()].reduce((total, item) => total + Math.min(bytes(item), this.maxRawResponseBytes), 0) + 64 * 1024;
    await this.guard(estimated, options.signal);
    return this.transaction((database) => {
      const run = (sql: string, ...params: unknown[]) => database.prepare(sql).run(...params as never[]);
      run("INSERT OR REPLACE INTO osint_investigations_v1 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", investigation.id, investigation.schemaVersion, json(investigation.seed), investigation.objective, investigation.authorizationMode, investigation.status, json(investigation.budget), investigation.planId ?? null, json(investigation.counts), json(investigation.warnings), investigation.createdAt, investigation.updatedAt, investigation.completedAt ?? null);
      for (const entity of correlation.entities) {
        run("INSERT OR REPLACE INTO osint_entities_v1 VALUES(?,?,?,?,?,?,?,?)", investigation.id, entity.id, entity.schemaVersion, entity.type, entity.displayName, json(entity.attributes), entity.createdAt, entity.updatedAt);
        for (const alias of entity.identifiers) run("INSERT OR REPLACE INTO osint_entity_aliases_v1 VALUES(?,?,?,?,?,?,?,?,?,?)", investigation.id, entity.id, alias.id, alias.type, alias.value, alias.normalizedValue, alias.confidence, alias.firstSeenAt ?? null, alias.lastSeenAt ?? null, json(alias.evidenceIds));
      }
      for (const link of correlation.identityLinks) run("INSERT OR REPLACE INTO osint_identity_links_v2 VALUES(?,?,?,?,?)", investigation.id, link.id, link.canonicalEntityId, link.matchKind, json(link));
      for (const evidence of correlation.evidence) {
        const item = raw.get(evidence.id); const bounded = item ? boundAndRedactRawResponse({ headers: item.headers ?? {}, body: item.body }, this.maxRawResponseBytes) : null;
        run("INSERT OR REPLACE INTO osint_evidence_v1 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", investigation.id, evidence.id, evidence.providerId, evidence.sourceType, redactUrl(evidence.sourceRef), evidence.retrievedAt, evidence.observedAt ?? null, evidence.title, evidence.excerpt ?? null, evidence.url ? redactUrl(evidence.url) : null, evidence.mimeType ?? null, evidence.sha256, evidence.byteLength, evidence.sensitivity, evidence.cache.status, evidence.cache.ageMs, evidence.cache.expiresAt ?? null, json(redactOsintValue(evidence.attribution)), json(redactOsintValue(evidence.metadata)), bounded ? json(bounded.value) : null, bounded?.storedBytes ?? 0, bounded?.originalBytes ?? 0, bounded?.truncated ? 1 : 0);
      }
      for (const entity of correlation.entities) for (const alias of entity.identifiers) for (const evidenceId of alias.evidenceIds) run("INSERT OR IGNORE INTO osint_alias_evidence_v1 VALUES(?,?,?)", investigation.id, alias.id, evidenceId);
      for (const observation of correlation.observations) {
        run("INSERT OR REPLACE INTO osint_observations_v1 VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", investigation.id, observation.id, observation.entityId, observation.providerId, observation.observedAt, observation.retrievedAt, json(observation.attributes), observation.confidence, observation.confidenceCategory, observation.directness, observation.freshness, json(observation.coverageLimitations));
        for (const evidenceId of observation.evidenceIds) run("INSERT OR IGNORE INTO osint_observation_evidence_v1 VALUES(?,?,?)", investigation.id, observation.id, evidenceId);
      }
      for (const claim of correlation.claims) {
        run("INSERT OR REPLACE INTO osint_claims_v1 VALUES(?,?,?,?,?,?,?,?,?,?,?)", investigation.id, claim.id, claim.subjectEntityId, claim.predicate, json(claim.value), claim.validFrom ?? null, claim.validTo ?? null, claim.status, claim.confidence, claim.confidenceCategory, claim.explanation);
        for (const evidenceId of claim.evidenceIds) run("INSERT OR IGNORE INTO osint_claim_evidence_v1 VALUES(?,?,?)", investigation.id, claim.id, evidenceId);
        for (const observationId of claim.observationIds) run("INSERT OR IGNORE INTO osint_claim_observations_v1 VALUES(?,?,?)", investigation.id, claim.id, observationId);
      }
      for (const conclusion of correlation.conclusions) run("INSERT OR REPLACE INTO osint_claim_conclusions_v2 VALUES(?,?,?)", investigation.id, conclusion.claimId, json(conclusion));
      for (const change of correlation.changes) run("INSERT OR REPLACE INTO osint_temporal_changes_v2 VALUES(?,?,?,?,?,?,?,?,?)", investigation.id, change.id, change.entityId, change.predicate, change.changeType, change.fromClaimId, change.toClaimId, change.observedAt, json(change));
      for (const relationship of correlation.relationships) {
        run("INSERT OR REPLACE INTO osint_relationships_v1 VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", investigation.id, relationship.id, relationship.sourceEntityId, relationship.targetEntityId, relationship.type, relationship.direction, relationship.observedAt, relationship.validFrom ?? null, relationship.validTo ?? null, relationship.confidence, relationship.confidenceCategory, relationship.status);
        for (const evidenceId of relationship.evidenceIds) run("INSERT OR IGNORE INTO osint_relationship_evidence_v1 VALUES(?,?,?)", investigation.id, relationship.id, evidenceId);
      }
      for (const contradiction of correlation.contradictions) { const id = contradiction.id; run("INSERT OR REPLACE INTO osint_contradictions_v1 VALUES(?,?,?,?,?,?)", investigation.id, id, contradiction.subjectEntityId, contradiction.predicate, json(contradiction.claimIds), contradiction.detectedAt); for (const claimId of contradiction.claimIds) run("INSERT OR IGNORE INTO osint_contradiction_claims_v1 VALUES(?,?,?)", investigation.id, id, claimId); run("INSERT OR REPLACE INTO osint_contradiction_details_v2 VALUES(?,?,?)", investigation.id, id, json(contradiction)); }
      for (const lead of correlation.leads) { run("INSERT OR REPLACE INTO osint_candidate_leads_v1 VALUES(?,?,?,?,?,?,?,?,?,?)", investigation.id, lead.id, lead.entityId, json(lead.seed), lead.reason, lead.status, lead.depth, json(lead.discoveredByEvidenceIds), lead.createdAt, lead.updatedAt); for (const evidenceId of lead.discoveredByEvidenceIds) run("INSERT OR IGNORE INTO osint_lead_evidence_v1 VALUES(?,?,?)", investigation.id, lead.id, evidenceId); }
      run("INSERT OR REPLACE INTO osint_decision_logs_v1 VALUES(?,?,?,?,?,?,?)", result.policyDecision.id, investigation.id, "policy", result.policyDecision.id, result.policyDecision.outcome, result.policyDecision.evaluatedAt, json(redactOsintValue(result.policyDecision)));
      run("INSERT OR REPLACE INTO osint_invocation_logs_v1 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", `invocation_${sha256(investigation.id).slice(0, 24)}`, investigation.id, null, "investigation.persist", "completed", investigation.updatedAt, investigation.updatedAt, 0, investigation.counts.externalCalls, 0, "not-applicable", null, json({ planId: result.plan.id, reportId: result.report.id }));
      return { investigationId: investigation.id, estimatedBytes: estimated, rawResponses: raw.size };
    }, options.signal);
  }

  async putProviderCache(input: OsintProviderCacheInput, signal?: AbortSignal) {
    const safeResult = redactOsintValue(input.result); const safeProvenance = redactOsintValue(input.provenance); await this.guard(bytes(safeResult) + bytes(safeProvenance) + 4_096, signal);
    return this.transaction((database) => database.prepare("INSERT OR REPLACE INTO osint_provider_cache_v1 VALUES(?,?,?,?,?,?,?,?,?,?,COALESCE((SELECT hit_count FROM osint_provider_cache_v1 WHERE cache_key=?),0))").run(input.cacheKey, input.providerId, input.queryId, input.storedAt, input.expiresAt, input.sourceRetrievedAt, json(safeResult), bytes(safeResult), json(safeProvenance), input.storedAt, input.cacheKey), signal);
  }

  getProviderCache(cacheKey: string) {
    const row = this.db().prepare("SELECT * FROM osint_provider_cache_v1 WHERE cache_key=?").get(cacheKey) as Record<string, unknown> | undefined; if (!row) return null;
    const now = this.now(); const ageMs = Math.max(0, now - Date.parse(String(row.stored_at))); const expired = now >= Date.parse(String(row.expires_at));
    return { cacheKey, providerId: row.provider_id, queryId: row.query_id, storedAt: row.stored_at, expiresAt: row.expires_at, sourceRetrievedAt: row.source_retrieved_at, ageMs, expired, result: JSON.parse(String(row.result_json)), provenance: JSON.parse(String(row.provenance_json)) };
  }

  async putRateLimitState(input: OsintRateLimitStateInput, signal?: AbortSignal) { await this.guard(bytes(input) + 1_024, signal); return this.transaction((database) => database.prepare("INSERT OR REPLACE INTO osint_rate_limit_state_v1 VALUES(?,?,?,?,?,?)").run(input.providerId, input.windowStartedAt, input.used, input.limit, input.resetAt, input.updatedAt), signal); }
  async appendInvocationLog(input: OsintInvocationLogInput, signal?: AbortSignal) { const safe = redactOsintValue(input.metadata ?? {}); await this.guard(bytes(input) + 2_048, signal); const id = input.id ?? randomUUID(); this.transaction((database) => database.prepare("INSERT INTO osint_invocation_logs_v1 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, input.investigationId ?? null, input.providerId ?? null, input.action, input.status, input.startedAt, input.completedAt ?? null, input.durationMs ?? null, input.externalCalls ?? 0, input.requestCost ?? 0, input.cacheStatus ?? null, input.errorCode ?? null, json(safe)), signal); return id; }
  async appendDecisionLog(input: OsintDecisionLogInput, signal?: AbortSignal) { const safe = redactOsintValue(input.detail); await this.guard(bytes(input) + 2_048, signal); const id = input.id ?? randomUUID(); this.transaction((database) => database.prepare("INSERT INTO osint_decision_logs_v1 VALUES(?,?,?,?,?,?,?)").run(id, input.investigationId ?? null, input.decisionType, input.decisionId, input.outcome, input.createdAt, json(safe)), signal); return id; }

  getInvestigationGraph(investigationId: string) {
    const database = this.db(); const select = (table: string, orderBy = "id") => database.prepare(`SELECT * FROM ${table} WHERE investigation_id=? ORDER BY ${orderBy}`).all(investigationId);
    const investigation = database.prepare("SELECT * FROM osint_investigations_v1 WHERE id=?").get(investigationId); if (!investigation) return null;
    return { investigation, entities: select("osint_entities_v1"), aliases: select("osint_entity_aliases_v1"), identityLinks: select("osint_identity_links_v2"), evidence: select("osint_evidence_v1"), observations: select("osint_observations_v1"), claims: select("osint_claims_v1"), conclusions: select("osint_claim_conclusions_v2", "claim_id"), changes: select("osint_temporal_changes_v2"), relationships: select("osint_relationships_v1"), contradictions: select("osint_contradictions_v1"), contradictionDetails: select("osint_contradiction_details_v2", "contradiction_id"), leads: select("osint_candidate_leads_v1") };
  }

  getInvestigationView(investigationId: string) {
    const raw = this.getInvestigationGraph(investigationId); if (!raw) return null;
    const database = this.db();
    const links = (table: string, owner: string, item: string) => {
      const rows = database.prepare(`SELECT ${owner},${item} FROM ${table} WHERE investigation_id=? ORDER BY ${owner},${item}`).all(investigationId) as Record<string, unknown>[];
      const mapped = new Map<string, string[]>();
      for (const row of rows) { const key = String(row[owner]); const values = mapped.get(key) ?? []; values.push(String(row[item])); mapped.set(key, values); }
      return mapped;
    };
    const observationEvidence = links("osint_observation_evidence_v1", "observation_id", "evidence_id");
    const claimEvidence = links("osint_claim_evidence_v1", "claim_id", "evidence_id");
    const claimObservations = links("osint_claim_observations_v1", "claim_id", "observation_id");
    const relationshipEvidence = links("osint_relationship_evidence_v1", "relationship_id", "evidence_id");
    const investigationRow = raw.investigation as Record<string, unknown>;
    const investigation = { id: String(investigationRow.id), schemaVersion: String(investigationRow.schema_version), seed: JSON.parse(String(investigationRow.seed_json)), objective: String(investigationRow.objective), authorizationMode: String(investigationRow.authorization_mode), status: String(investigationRow.status), budget: JSON.parse(String(investigationRow.budget_json)), ...(investigationRow.plan_id ? { planId: String(investigationRow.plan_id) } : {}), counts: JSON.parse(String(investigationRow.counts_json)), warnings: JSON.parse(String(investigationRow.warnings_json)), createdAt: String(investigationRow.created_at), updatedAt: String(investigationRow.updated_at), ...(investigationRow.completed_at ? { completedAt: String(investigationRow.completed_at) } : {}) };
    const aliasesByEntity = new Map<string, unknown[]>();
    for (const row of raw.aliases as Record<string, unknown>[]) {
      const entityId = String(row.entity_id); const values = aliasesByEntity.get(entityId) ?? [];
      values.push({ id: String(row.id), type: String(row.type), value: String(row.value), normalizedValue: String(row.normalized_value), confidence: Number(row.confidence), ...(row.first_seen_at ? { firstSeenAt: String(row.first_seen_at) } : {}), ...(row.last_seen_at ? { lastSeenAt: String(row.last_seen_at) } : {}), evidenceIds: JSON.parse(String(row.evidence_ids_json)) }); aliasesByEntity.set(entityId, values);
    }
    return {
      investigation,
      entities: (raw.entities as Record<string, unknown>[]).map((row) => ({ id: String(row.id), type: String(row.type), displayName: String(row.display_name), attributes: JSON.parse(String(row.attributes_json)), identifiers: aliasesByEntity.get(String(row.id)) ?? [], createdAt: String(row.created_at), updatedAt: String(row.updated_at) })),
      evidence: (raw.evidence as Record<string, unknown>[]).map((row) => ({ id: String(row.id), providerId: String(row.provider_id), sourceType: String(row.source_type), sourceRef: String(row.source_ref), retrievedAt: String(row.retrieved_at), ...(row.observed_at ? { observedAt: String(row.observed_at) } : {}), title: String(row.title), ...(row.excerpt ? { excerpt: String(row.excerpt) } : {}), ...(row.url ? { url: String(row.url) } : {}), ...(row.mime_type ? { mimeType: String(row.mime_type) } : {}), sha256: String(row.sha256), byteLength: Number(row.byte_length), sensitivity: String(row.sensitivity), cache: { status: String(row.cache_status), ageMs: Number(row.cache_age_ms), ...(row.cache_expires_at ? { expiresAt: String(row.cache_expires_at) } : {}) }, attribution: JSON.parse(String(row.attribution_json)), metadata: JSON.parse(String(row.metadata_json)), rawResponse: { storedBytes: Number(row.raw_response_bytes), originalBytes: Number(row.raw_original_bytes), truncated: Boolean(row.raw_truncated) } })),
      observations: (raw.observations as Record<string, unknown>[]).map((row) => ({ id: String(row.id), entityId: String(row.entity_id), providerId: String(row.provider_id), observedAt: String(row.observed_at), retrievedAt: String(row.retrieved_at), attributes: JSON.parse(String(row.attributes_json)), confidence: Number(row.confidence), confidenceCategory: String(row.confidence_category), directness: String(row.directness), freshness: String(row.freshness), coverageLimitations: JSON.parse(String(row.coverage_limitations_json)), evidenceIds: observationEvidence.get(String(row.id)) ?? [] })),
      claims: (raw.claims as Record<string, unknown>[]).map((row) => ({ id: String(row.id), subjectEntityId: String(row.subject_entity_id), predicate: String(row.predicate), value: JSON.parse(String(row.value_json)), ...(row.valid_from ? { validFrom: String(row.valid_from) } : {}), ...(row.valid_to ? { validTo: String(row.valid_to) } : {}), status: String(row.status), confidence: Number(row.confidence), confidenceCategory: String(row.confidence_category), explanation: String(row.explanation), evidenceIds: claimEvidence.get(String(row.id)) ?? [], observationIds: claimObservations.get(String(row.id)) ?? [] })),
      conclusions: (raw.conclusions as Record<string, unknown>[]).map((row) => JSON.parse(String(row.assessment_json))),
      relationships: (raw.relationships as Record<string, unknown>[]).map((row) => ({ id: String(row.id), sourceEntityId: String(row.source_entity_id), targetEntityId: String(row.target_entity_id), type: String(row.type), direction: String(row.direction), observedAt: String(row.observed_at), ...(row.valid_from ? { validFrom: String(row.valid_from) } : {}), ...(row.valid_to ? { validTo: String(row.valid_to) } : {}), confidence: Number(row.confidence), confidenceCategory: String(row.confidence_category), status: String(row.status), evidenceIds: relationshipEvidence.get(String(row.id)) ?? [] })),
      contradictions: (raw.contradictionDetails as Record<string, unknown>[]).map((row) => JSON.parse(String(row.detail_json))),
      changes: (raw.changes as Record<string, unknown>[]).map((row) => JSON.parse(String(row.detail_json))),
      leads: (raw.leads as Record<string, unknown>[]).map((row) => ({ id: String(row.id), entityId: String(row.entity_id), seed: JSON.parse(String(row.seed_json)), reason: String(row.reason), status: String(row.status), depth: Number(row.depth), discoveredByEvidenceIds: JSON.parse(String(row.evidence_ids_json)), createdAt: String(row.created_at), updatedAt: String(row.updated_at) })),
    };
  }

  async setCandidateLeadStatus(investigationId: string, leadId: string, status: "approved" | "rejected", signal?: AbortSignal) {
    await this.guard(4_096, signal); const updatedAt = new Date(this.now()).toISOString();
    return this.transaction((database) => {
      const row = database.prepare("SELECT status FROM osint_candidate_leads_v1 WHERE investigation_id=? AND id=?").get(investigationId, leadId) as { status?: string } | undefined;
      if (!row) throw new OsintStoreError("VALIDATION_FAILED", "The candidate lead does not belong to that investigation.");
      if (!["candidate", "approved", "rejected"].includes(String(row.status))) throw new OsintStoreError("VALIDATION_FAILED", "That candidate lead can no longer be reviewed.");
      database.prepare("UPDATE osint_candidate_leads_v1 SET status=?,updated_at=? WHERE investigation_id=? AND id=?").run(status, updatedAt, investigationId, leadId);
      return { investigationId, leadId, status, updatedAt, providerRequestStarted: false, automaticExpansion: false };
    }, signal);
  }

  private exportPayload(scope: OsintClearScope, investigationId?: string) {
    const database = this.db();
    if (scope === "investigation") { if (!investigationId) throw new OsintStoreError("VALIDATION_FAILED", "An investigation ID is required."); return this.getInvestigationGraph(investigationId); }
    const table = scope === "provider-cache" ? "osint_provider_cache_v1" : scope === "raw-responses" ? "osint_evidence_v1" : scope === "invocation-logs" ? "osint_invocation_logs_v1" : "osint_decision_logs_v1";
    return database.prepare(`SELECT * FROM ${table}`).all();
  }

  async exportScope(scope: OsintClearScope, exportDirectory: string, investigationId?: string, signal?: AbortSignal) {
    abort(signal); const resolved = path.resolve(exportDirectory); if (isInside(this.dataRoot, resolved)) throw new OsintStoreError("UNSAFE_PATH", "OSINT safety exports must be outside the managed data root.");
    const payload = this.exportPayload(scope, investigationId); await fs.mkdir(resolved, { recursive: true }); abort(signal);
    const body = json({ version: 1, scope, investigationId: investigationId ?? null, exportedAt: new Date(this.now()).toISOString(), payload });
    const target = path.join(resolved, `voidcat-osint-${scope}-${this.now()}-${randomUUID()}.json`); await fs.writeFile(target, body, { encoding: "utf8", flag: "wx" });
    const written = await fs.readFile(target, "utf8"); if (sha256(written) !== sha256(body)) throw new OsintStoreError("VALIDATION_FAILED", "The OSINT safety export failed hash verification.");
    return { path: target, bytes: Buffer.byteLength(body), sha256: sha256(body), records: Array.isArray(payload) ? payload.length : payload ? 1 : 0 };
  }

  private mutationApproved() { if (this.mode !== "synthetic" && !this.productionEvictionApproved) throw new OsintStoreError("PRODUCTION_EVICTION_LOCKED", "Production OSINT cleanup remains approval-gated."); }

  async clearScope(input: { scope: OsintClearScope; exportDirectory: string; investigationId?: string; signal?: AbortSignal }) {
    this.mutationApproved(); abort(input.signal); const exported = await this.exportScope(input.scope, input.exportDirectory, input.investigationId, input.signal); await this.guard(4_096, input.signal);
    const changes = this.transaction((database) => {
      if (input.scope === "investigation") { if (!input.investigationId) throw new OsintStoreError("VALIDATION_FAILED", "An investigation ID is required."); return database.prepare("DELETE FROM osint_investigations_v1 WHERE id=?").run(input.investigationId).changes; }
      if (input.scope === "provider-cache") return database.prepare("DELETE FROM osint_provider_cache_v1").run().changes;
      if (input.scope === "raw-responses") return database.prepare("UPDATE osint_evidence_v1 SET raw_response_json=NULL,raw_response_bytes=0,raw_original_bytes=0,raw_truncated=0 WHERE raw_response_json IS NOT NULL").run().changes;
      if (input.scope === "invocation-logs") return database.prepare("DELETE FROM osint_invocation_logs_v1").run().changes;
      return database.prepare("DELETE FROM osint_decision_logs_v1").run().changes;
    }, input.signal);
    this.db().exec("PRAGMA wal_checkpoint(PASSIVE); PRAGMA incremental_vacuum(64);"); const consistency = this.checkConsistency(); if (!consistency.valid) throw new OsintStoreError("CORRUPT_DATABASE", "OSINT cleanup was committed but consistency verification failed.");
    return { scope: input.scope, changes: Number(changes), exported, consistency };
  }

  dryRunEviction(targetBytes: number) {
    const database = this.db(); const rows = database.prepare("SELECT i.id,i.updated_at,COALESCE((SELECT SUM(byte_length+raw_response_bytes) FROM osint_evidence_v1 e WHERE e.investigation_id=i.id),0) AS evidence_bytes FROM osint_investigations_v1 i ORDER BY i.updated_at ASC,i.id ASC").all() as Array<Record<string, unknown>>;
    let total = 0; const candidates: Array<{ investigationId: string; estimatedBytes: number; updatedAt: string }> = [];
    for (const row of rows) { if (total >= Math.max(0, targetBytes)) break; const estimatedBytes = Math.max(1, Number(row.evidence_bytes)); candidates.push({ investigationId: String(row.id), estimatedBytes, updatedAt: String(row.updated_at) }); total += estimatedBytes; }
    return { dryRun: true as const, targetBytes: Math.max(0, targetBytes), estimatedBytes: total, candidates, note: "No rows or files were changed. Every selected investigation requires a verified export before deletion." };
  }

  async evict(input: { targetBytes: number; exportDirectory: string; signal?: AbortSignal }) {
    this.mutationApproved(); const plan = this.dryRunEviction(input.targetBytes); const completed = [];
    for (const candidate of plan.candidates) { abort(input.signal); completed.push(await this.clearScope({ scope: "investigation", investigationId: candidate.investigationId, exportDirectory: input.exportDirectory, signal: input.signal })); await new Promise<void>((resolve) => setImmediate(resolve)); }
    return { plan, completed, consistency: this.checkConsistency() };
  }

  checkConsistency(): OsintConsistencyReport {
    const database = this.db(); const quickCheck = rowValue(database.prepare("PRAGMA quick_check(1)").get()); const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all().length;
    const checks = [
      "SELECT COUNT(*) n FROM osint_observation_evidence_v1 j LEFT JOIN osint_observations_v1 o ON o.investigation_id=j.investigation_id AND o.id=j.observation_id LEFT JOIN osint_evidence_v1 e ON e.investigation_id=j.investigation_id AND e.id=j.evidence_id WHERE o.id IS NULL OR e.id IS NULL",
      "SELECT COUNT(*) n FROM osint_claim_evidence_v1 j LEFT JOIN osint_claims_v1 c ON c.investigation_id=j.investigation_id AND c.id=j.claim_id LEFT JOIN osint_evidence_v1 e ON e.investigation_id=j.investigation_id AND e.id=j.evidence_id WHERE c.id IS NULL OR e.id IS NULL",
      "SELECT COUNT(*) n FROM osint_claim_observations_v1 j LEFT JOIN osint_claims_v1 c ON c.investigation_id=j.investigation_id AND c.id=j.claim_id LEFT JOIN osint_observations_v1 o ON o.investigation_id=j.investigation_id AND o.id=j.observation_id WHERE c.id IS NULL OR o.id IS NULL",
      "SELECT COUNT(*) n FROM osint_relationship_evidence_v1 j LEFT JOIN osint_relationships_v1 r ON r.investigation_id=j.investigation_id AND r.id=j.relationship_id LEFT JOIN osint_evidence_v1 e ON e.investigation_id=j.investigation_id AND e.id=j.evidence_id WHERE r.id IS NULL OR e.id IS NULL",
      "SELECT COUNT(*) n FROM osint_alias_evidence_v1 j LEFT JOIN osint_entity_aliases_v1 a ON a.investigation_id=j.investigation_id AND a.id=j.alias_id LEFT JOIN osint_evidence_v1 e ON e.investigation_id=j.investigation_id AND e.id=j.evidence_id WHERE a.id IS NULL OR e.id IS NULL",
      "SELECT COUNT(*) n FROM osint_contradiction_claims_v1 j LEFT JOIN osint_contradictions_v1 c ON c.investigation_id=j.investigation_id AND c.id=j.contradiction_id LEFT JOIN osint_claims_v1 q ON q.investigation_id=j.investigation_id AND q.id=j.claim_id WHERE c.id IS NULL OR q.id IS NULL",
      "SELECT COUNT(*) n FROM osint_identity_links_v2 j LEFT JOIN osint_entities_v1 e ON e.investigation_id=j.investigation_id AND e.id=j.canonical_entity_id WHERE e.id IS NULL",
      "SELECT COUNT(*) n FROM osint_claim_conclusions_v2 j LEFT JOIN osint_claims_v1 c ON c.investigation_id=j.investigation_id AND c.id=j.claim_id WHERE c.id IS NULL",
      "SELECT COUNT(*) n FROM osint_temporal_changes_v2 j LEFT JOIN osint_entities_v1 e ON e.investigation_id=j.investigation_id AND e.id=j.entity_id LEFT JOIN osint_claims_v1 f ON f.investigation_id=j.investigation_id AND f.id=j.from_claim_id LEFT JOIN osint_claims_v1 t ON t.investigation_id=j.investigation_id AND t.id=j.to_claim_id WHERE e.id IS NULL OR f.id IS NULL OR t.id IS NULL",
      "SELECT COUNT(*) n FROM osint_contradiction_details_v2 j LEFT JOIN osint_contradictions_v1 c ON c.investigation_id=j.investigation_id AND c.id=j.contradiction_id WHERE c.id IS NULL",
      "SELECT COUNT(*) n FROM osint_lead_evidence_v1 j LEFT JOIN osint_candidate_leads_v1 l ON l.investigation_id=j.investigation_id AND l.id=j.lead_id LEFT JOIN osint_evidence_v1 e ON e.investigation_id=j.investigation_id AND e.id=j.evidence_id WHERE l.id IS NULL OR e.id IS NULL",
    ];
    const orphanedRows = checks.reduce((total, sql) => total + Number((database.prepare(sql).get() as { n: number }).n), 0); return { quickCheck, foreignKeyViolations, orphanedRows, valid: quickCheck === "ok" && foreignKeyViolations === 0 && orphanedRows === 0 };
  }

  async recoverFromBackup(backupPath: string, signal?: AbortSignal) {
    if (this.mode !== "synthetic") throw new OsintStoreError("PRODUCTION_EVICTION_LOCKED", "Database recovery is restricted to the disposable Gate 3 test harness until approval."); abort(signal);
    const resolved = path.resolve(backupPath); if (!isInside(this.backupRoot, resolved)) throw new OsintStoreError("UNSAFE_PATH", "Recovery can only use a validated OSINT migration backup.");
    const probe = new DatabaseSync(resolved, { readOnly: true }); try { if (rowValue(probe.prepare("PRAGMA quick_check(1)").get()) !== "ok") throw new OsintStoreError("CORRUPT_DATABASE", "The selected OSINT backup is corrupt."); } finally { probe.close(); }
    const size = (await fs.stat(resolved)).size; await this.guard(size, signal); this.close(); const temporary = `${this.databasePath}.recover-${randomUUID()}`; await fs.copyFile(resolved, temporary); abort(signal); await fs.rename(temporary, this.databasePath); return this.initialize(signal);
  }
}
