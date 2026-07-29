/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstatSync, promises as fs, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type StorageBudgetId = "hunter-observations" | "chat-memory" | "imagery-cache" | "osint-investigations";
export type StorageComponentId = "database" | "wal" | "history-database" | "history-wal" | "vectors" | "blobs" | "replay" | "imagery" | "osint-database" | "osint-wal" | "osint-backups";
export type StorageClearScope = "hunter-observation-rows" | "hunter-vectors" | "hunter-blobs" | "hunter-replay" | "imagery-cache" | "chat-memory";
export type StorageActivityKind = "hunter" | "rag";

export type StorageBudgetConfig = {
  id: StorageBudgetId;
  label: string;
  limitBytes: number;
  highWatermark: number;
  lowWatermark: number;
  automaticCleanup: boolean;
};

export type StorageComponentMeasurement = {
  id: StorageComponentId;
  bytes: number;
  files: number;
  path: string;
  measurement: "physical" | "logical";
  detail: string;
  ownership?: Record<string, number>;
};

export type StorageBudgetMeasurement = StorageBudgetConfig & {
  usedBytes: number;
  utilization: number;
  state: "normal" | "high" | "full";
  projectedTimeToFullMs: number | null;
  projectedFullAt: string | null;
};

export type StorageMeasurementReport = {
  measuredAt: string;
  components: Record<StorageComponentId, StorageComponentMeasurement>;
  budgets: Record<StorageBudgetId, StorageBudgetMeasurement>;
  activity: StorageWriteActivitySnapshot;
  note: string;
};

export type StorageCleanupAction = {
  scope: StorageClearScope;
  estimatedBytes: number;
  estimatedRecords: number;
  reason: string;
};

export type StorageDryRunReport = {
  id: string;
  createdAt: string;
  budgetId: StorageBudgetId;
  currentBytes: number;
  highBytes: number;
  targetBytes: number;
  bytesToRecover: number;
  actions: StorageCleanupAction[];
  protectedScopes: StorageClearScope[];
  realEvictionEnabled: false;
  note: string;
};

export type StorageWriteActivitySnapshot = { hunterWrites: number; ragWrites: number };
export type StorageManagerEvent = {
  sequence: number;
  type: "activity" | "configured" | "measured" | "dry-run" | "exported" | "cleared" | "migrated";
  at: string;
  budgetId?: StorageBudgetId;
  scope?: StorageClearScope;
};

export type StorageExportReport = {
  id: string;
  scope: StorageClearScope;
  exportedAt: string;
  directory: string;
  files: number;
  bytes: number;
  databaseValidated: boolean;
};

export type StorageClearReport = {
  scope: StorageClearScope;
  startedAt: string;
  completedAt: string;
  recordsDeleted: number;
  filesDeleted: number;
  bytesRecoveredEstimate: number;
  export: StorageExportReport;
  consistency: StorageConsistencyReport;
};

export type StorageConsistencyReport = {
  checkedAt: string;
  orphanVectors: number;
  orphanSources: number;
  valid: boolean;
};

export type StorageMigrationReport = {
  name: string;
  startedAt: string;
  completedAt: string;
  statementsApplied: number;
  backup: StorageExportReport;
  databaseValidated: boolean;
};

export class StorageBudgetError extends Error {
  readonly code: "APPROVAL_REQUIRED" | "ACTIVE_WRITES" | "BUDGET_EXCEEDED" | "CANCELLED" | "INVALID_CONFIG" | "INSUFFICIENT_DISK" | "UNSAFE_PATH" | "VALIDATION_FAILED" | "UNSUPPORTED_SCOPE";
  constructor(code: StorageBudgetError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "StorageBudgetError";
  }
}

export class StorageWriteActivityTracker {
  private counts: Record<StorageActivityKind, number> = { hunter: 0, rag: 0 };
  private listeners = new Set<(snapshot: StorageWriteActivitySnapshot) => void>();

  private emit() {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) { try { listener(clone(snapshot)); } catch { /* activity guards cannot be interrupted */ } }
  }

  begin(kind: StorageActivityKind) {
    this.counts[kind] += 1;
    this.emit();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.counts[kind] = Math.max(0, this.counts[kind] - 1);
      this.emit();
    };
  }

  snapshot(): StorageWriteActivitySnapshot {
    return { hunterWrites: this.counts.hunter, ragWrites: this.counts.rag };
  }

  subscribe(listener: (snapshot: StorageWriteActivitySnapshot) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

type ManagerOptions = {
  dataRoot?: string;
  databasePath?: string;
  mode?: "production" | "synthetic";
  activitySnapshot?: () => StorageWriteActivitySnapshot;
  now?: () => number;
  freeDiskBytes?: (targetPath: string) => Promise<number>;
  minimumMigrationReserveBytes?: number;
  maxOperationMs?: number;
  batchSize?: number;
  initialConfigs?: Partial<Record<StorageBudgetId, Partial<Pick<StorageBudgetConfig, "limitBytes" | "highWatermark" | "lowWatermark">>>>;
};

type FileRecord = { absolutePath: string; relativePath: string; size: number; modifiedMs: number };
type TableMeasurement = { bytes: number; rows: number };

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const DEFAULT_BUDGETS: Record<StorageBudgetId, StorageBudgetConfig> = {
  "hunter-observations": { id: "hunter-observations", label: "Hunter observations", limitBytes: 5 * GIB, highWatermark: 0.85, lowWatermark: 0.70, automaticCleanup: false },
  "chat-memory": { id: "chat-memory", label: "Chat memory", limitBytes: 500 * MIB, highWatermark: 0.90, lowWatermark: 0.75, automaticCleanup: false },
  "imagery-cache": { id: "imagery-cache", label: "Imagery cache", limitBytes: 2 * GIB, highWatermark: 0.85, lowWatermark: 0.70, automaticCleanup: false },
  "osint-investigations": { id: "osint-investigations", label: "OSINT investigations", limitBytes: 2 * GIB, highWatermark: 0.85, lowWatermark: 0.70, automaticCleanup: false },
};
const TABLES = {
  hunterObservations: "hunter_observations_v1",
  hunterVectors: "hunter_observation_vectors_v1",
  hunterSources: "hunter_observation_sources_v1",
  chat: ["conversations", "messages", "memories"],
  ragVectors: ["rag_vector_index_v1", "rag_vector_buckets_v1"],
  ragEmbeddingTable: "document_chunks",
  ragEmbeddingColumn: "embedding",
} as const;
const MIGRATION_WORKER = `
  const { readFileSync } = require("node:fs");
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(process.argv[1]);
  const statements = JSON.parse(readFileSync(process.argv[2], "utf8"));
  let applied = 0;
  try {
    database.exec("BEGIN IMMEDIATE");
    for (const statement of statements) { database.exec(statement); applied += 1; }
    database.exec("COMMIT");
    process.stdout.write(JSON.stringify({ applied }));
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    process.stderr.write(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally { database.close(); }
`;

function clone<T>(value: T): T { return structuredClone(value); }
function isInside(root: string, candidate: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function throwIfCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new StorageBudgetError("CANCELLED", "The storage operation was cancelled safely.");
}
function yieldToEventLoop() { return new Promise<void>((resolve) => setImmediate(resolve)); }
function safeIdentifier(value: string) {
  if (!/^[a-z][a-z0-9_]*$/i.test(value)) throw new StorageBudgetError("VALIDATION_FAILED", "An internal storage identifier was invalid.");
  return `"${value}"`;
}

function isMissing(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

async function fileSize(filePath: string) {
  try { return (await fs.stat(filePath)).size; } catch (error) { if (isMissing(error)) return 0; throw error; }
}

async function listFiles(root: string, signal?: AbortSignal, maximumFiles = 25_000, maximumMs = 5_000): Promise<FileRecord[]> {
  const records: FileRecord[] = [];
  const pending = [root];
  const startedAt = Date.now();
  while (pending.length) {
    throwIfCancelled(signal);
    if (Date.now() - startedAt > maximumMs) throw new StorageBudgetError("VALIDATION_FAILED", "Storage measurement stopped at the five-second directory safety limit.");
    const current = pending.pop()!;
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch (error) { if (isMissing(error)) continue; throw error; }
    for (const entry of entries) {
      throwIfCancelled(signal);
      if (Date.now() - startedAt > maximumMs) throw new StorageBudgetError("VALIDATION_FAILED", "Storage measurement stopped at the five-second directory safety limit.");
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolutePath);
      else if (entry.isFile()) {
        const stat = await fs.stat(absolutePath);
        records.push({ absolutePath, relativePath: path.relative(root, absolutePath), size: stat.size, modifiedMs: stat.mtimeMs });
        if (records.length > maximumFiles) throw new StorageBudgetError("VALIDATION_FAILED", `Storage measurement stopped at the ${maximumFiles.toLocaleString()} file safety limit.`);
      }
    }
  }
  return records;
}

function tableExists(database: DatabaseSync, table: string) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function measureTable(database: DatabaseSync, table: string): TableMeasurement {
  if (!tableExists(database, table)) return { bytes: 0, rows: 0 };
  const identifier = safeIdentifier(table);
  const columns = database.prepare(`PRAGMA table_info(${identifier})`).all() as Array<{ name: string }>;
  const byteExpression = columns.length
    ? columns.map(({ name }) => `COALESCE(length(${safeIdentifier(name)}), 0)`).join(" + ")
    : "0";
  const result = database.prepare(`SELECT COUNT(*) AS rows, COALESCE(SUM(${byteExpression}), 0) AS bytes FROM ${identifier}`).get() as { rows: number; bytes: number };
  return { rows: Number(result.rows) || 0, bytes: Number(result.bytes) || 0 };
}

function measureColumn(database: DatabaseSync, table: string, column: string): TableMeasurement {
  if (!tableExists(database, table)) return { bytes: 0, rows: 0 };
  const tableIdentifier = safeIdentifier(table); const columnIdentifier = safeIdentifier(column);
  const columnExists = (database.prepare(`PRAGMA table_info(${tableIdentifier})`).all() as Array<{ name: string }>).some(({ name }) => name === column);
  if (!columnExists) return { bytes: 0, rows: 0 };
  const result = database.prepare(`SELECT COUNT(${columnIdentifier}) AS rows, COALESCE(SUM(length(${columnIdentifier})), 0) AS bytes FROM ${tableIdentifier}`).get() as { rows: number; bytes: number };
  return { rows: Number(result.rows) || 0, bytes: Number(result.bytes) || 0 };
}

function validateDatabase(databasePath: string) {
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const result = database.prepare("PRAGMA quick_check(1)").get() as Record<string, unknown> | undefined;
    return String(Object.values(result ?? {})[0] ?? "unknown").toLowerCase() === "ok";
  } catch { return false; }
  finally { database?.close(); }
}

export class VoidCatStorageBudgetManager {
  private readonly dataRoot: string;
  private readonly databasePath: string;
  private readonly mode: "production" | "synthetic";
  private readonly activitySnapshot: () => StorageWriteActivitySnapshot;
  private readonly now: () => number;
  private readonly freeDiskBytes: (targetPath: string) => Promise<number>;
  private readonly minimumMigrationReserveBytes: number;
  private readonly maxOperationMs: number;
  private readonly batchSize: number;
  private configs = clone(DEFAULT_BUDGETS);
  private samples = new Map<StorageBudgetId, Array<{ at: number; bytes: number }>>();
  private listeners = new Set<(event: StorageManagerEvent) => void>();
  private sequence = 0;

  constructor(options: ManagerOptions = {}) {
    this.dataRoot = path.resolve(options.dataRoot ?? path.join(process.cwd(), ".voidcat", "data"));
    this.databasePath = path.resolve(options.databasePath ?? path.join(this.dataRoot, "voidcat.db"));
    this.mode = options.mode ?? "production";
    this.activitySnapshot = options.activitySnapshot ?? (() => ({ hunterWrites: 0, ragWrites: 0 }));
    this.now = options.now ?? Date.now;
    this.freeDiskBytes = options.freeDiskBytes ?? (async (targetPath) => {
      const stats = await fs.statfs(targetPath);
      return Number(stats.bavail) * Number(stats.bsize);
    });
    this.minimumMigrationReserveBytes = options.minimumMigrationReserveBytes ?? 512 * MIB;
    this.maxOperationMs = Math.max(100, options.maxOperationMs ?? 10_000);
    this.batchSize = Math.max(1, Math.min(1_000, options.batchSize ?? 100));
    if (this.mode === "synthetic") {
      const tempRoot = realpathSync(os.tmpdir()); const realDataRoot = realpathSync(this.dataRoot);
      if (lstatSync(this.dataRoot).isSymbolicLink() || !isInside(tempRoot, realDataRoot) || !path.basename(realDataRoot).startsWith("voidcat-storage-test-")
        || path.dirname(this.databasePath) !== this.dataRoot || path.basename(this.databasePath) !== "voidcat.db") {
        throw new StorageBudgetError("UNSAFE_PATH", "Synthetic storage operations are restricted to a disposable voidcat-storage-test-* directory.");
      }
    }
    for (const [id, config] of Object.entries(options.initialConfigs ?? {}) as Array<[StorageBudgetId, Partial<StorageBudgetConfig>]>) this.configure(id, config);
  }

  listBudgets() { return clone(Object.values(this.configs)); }

  configure(id: StorageBudgetId, patch: Partial<Pick<StorageBudgetConfig, "limitBytes" | "highWatermark" | "lowWatermark">>) {
    const current = this.configs[id];
    if (!current) throw new StorageBudgetError("INVALID_CONFIG", "Unknown storage budget.");
    const next = {
      ...current,
      limitBytes: patch.limitBytes ?? current.limitBytes,
      highWatermark: patch.highWatermark ?? current.highWatermark,
      lowWatermark: patch.lowWatermark ?? current.lowWatermark,
      automaticCleanup: false,
    };
    if (!Number.isFinite(next.limitBytes) || next.limitBytes < MIB || !Number.isFinite(next.lowWatermark) || !Number.isFinite(next.highWatermark)
      || next.lowWatermark <= 0 || next.lowWatermark >= next.highWatermark || next.highWatermark > 1) {
      throw new StorageBudgetError("INVALID_CONFIG", "A budget needs a positive limit and 0 < low watermark < high watermark <= 1.");
    }
    this.configs[id] = next;
    this.emit({ type: "configured", budgetId: id });
    return clone(next);
  }

  subscribe(listener: (event: StorageManagerEvent) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  notifyActivityChanged() { this.emit({ type: "activity" }); }

  private emit(input: Omit<StorageManagerEvent, "sequence" | "at">) {
    const event: StorageManagerEvent = { ...input, sequence: ++this.sequence, at: new Date(this.now()).toISOString() };
    for (const listener of this.listeners) { try { listener(clone(event)); } catch { /* listeners cannot stop safety operations */ } }
  }

  private paths() {
    return {
      historyDatabase: path.join(this.dataRoot, "hunter", "history.db"),
      blobs: path.join(this.dataRoot, "hunter", "blobs"),
      replay: path.join(this.dataRoot, "hunter", "replay"),
      imagery: path.join(this.dataRoot, "imagery"),
      osintDatabase: path.join(this.dataRoot, "osint", "osint.db"),
      osintBackups: path.join(this.dataRoot, "osint", "backups"),
    };
  }

  private recordProjection(id: StorageBudgetId, bytes: number, at: number, limitBytes: number) {
    const samples = this.samples.get(id) ?? [];
    if (!samples.length || samples.at(-1)?.bytes !== bytes || at - (samples.at(-1)?.at ?? 0) >= 1_000) samples.push({ at, bytes });
    while (samples.length > 32) samples.shift();
    this.samples.set(id, samples);
    if (samples.length < 2) return { ms: null, at: null };
    const first = samples[0]; const last = samples.at(-1)!;
    const growthPerMs = (last.bytes - first.bytes) / Math.max(1, last.at - first.at);
    if (growthPerMs <= 0 || last.bytes >= limitBytes) return { ms: last.bytes >= limitBytes ? 0 : null, at: last.bytes >= limitBytes ? new Date(at).toISOString() : null };
    const ms = Math.ceil((limitBytes - last.bytes) / growthPerMs);
    return { ms, at: new Date(at + ms).toISOString() };
  }

  async measure(signal?: AbortSignal): Promise<StorageMeasurementReport> {
    throwIfCancelled(signal);
    const paths = this.paths();
    const [databaseBytes, walBytes, historyDatabaseBytes, historyWalBytes, osintDatabaseBytes, osintWalBytes, osintBackupFiles, blobFiles, replayFiles, imageryFiles] = await Promise.all([
      fileSize(this.databasePath), fileSize(`${this.databasePath}-wal`), fileSize(paths.historyDatabase), fileSize(`${paths.historyDatabase}-wal`),
      fileSize(paths.osintDatabase), fileSize(`${paths.osintDatabase}-wal`), listFiles(paths.osintBackups, signal), listFiles(paths.blobs, signal), listFiles(paths.replay, signal), listFiles(paths.imagery, signal),
    ]);
    throwIfCancelled(signal);
    let hunterRows = { bytes: 0, rows: 0 }; let hunterVectors = { bytes: 0, rows: 0 };
    let chatBytes = 0; let vectorBytes = 0; let vectorRows = 0; let historyVectorBytes = 0; let historyVectorRows = 0;
    if (databaseBytes) {
      const database = new DatabaseSync(this.databasePath, { readOnly: true });
      try {
        hunterRows = measureTable(database, TABLES.hunterObservations);
        hunterVectors = measureTable(database, TABLES.hunterVectors);
        for (const table of TABLES.chat) chatBytes += measureTable(database, table).bytes;
        for (const table of TABLES.ragVectors) { const measured = measureTable(database, table); vectorBytes += measured.bytes; vectorRows += measured.rows; }
        const embeddings = measureColumn(database, TABLES.ragEmbeddingTable, TABLES.ragEmbeddingColumn);
        vectorBytes += embeddings.bytes; vectorRows += embeddings.rows;
        vectorBytes += hunterVectors.bytes; vectorRows += hunterVectors.rows;
      } finally { database.close(); }
    }
    if (historyDatabaseBytes) {
      const historyDatabase = new DatabaseSync(paths.historyDatabase, { readOnly: true });
      try {
        for (const table of ["history_rag_vectors_v1", "history_rag_buckets_v1"]) {
          const measured = measureTable(historyDatabase, table); historyVectorBytes += measured.bytes; historyVectorRows += measured.rows;
        }
      } finally { historyDatabase.close(); }
    }
    const sum = (files: FileRecord[]) => files.reduce((total, file) => total + file.size, 0);
    const blobBytes = sum(blobFiles); const replayBytes = sum(replayFiles); const imageryBytes = sum(imageryFiles); const osintBackupBytes = sum(osintBackupFiles);
    const components: StorageMeasurementReport["components"] = {
      database: { id: "database", bytes: databaseBytes, files: databaseBytes ? 1 : 0, path: this.databasePath, measurement: "physical", detail: "Shared SQLite database; never attributed wholesale to a cleanup budget.", ownership: { hunterObservationBytes: hunterRows.bytes, hunterObservationRecords: hunterRows.rows, chatBytes } },
      wal: { id: "wal", bytes: walBytes, files: walBytes ? 1 : 0, path: `${this.databasePath}-wal`, measurement: "physical", detail: "SQLite write-ahead log measured independently." },
      "history-database": { id: "history-database", bytes: historyDatabaseBytes, files: historyDatabaseBytes ? 1 : 0, path: paths.historyDatabase, measurement: "physical", detail: "Isolated Hunter history SQLite database. Its complete physical size is assigned to the Hunter budget." },
      "history-wal": { id: "history-wal", bytes: historyWalBytes, files: historyWalBytes ? 1 : 0, path: `${paths.historyDatabase}-wal`, measurement: "physical", detail: "Hunter history write-ahead log measured and budgeted independently." },
      vectors: { id: "vectors", bytes: vectorBytes + historyVectorBytes, files: vectorRows + historyVectorRows, path: this.dataRoot, measurement: "logical", detail: "RAG and Hunter vector row payloads by ownership. History vectors are already physically counted inside history.db and are not double-counted.", ownership: { ragBytes: Math.max(0, vectorBytes - hunterVectors.bytes), hunterBytes: hunterVectors.bytes + historyVectorBytes, historyBytes: historyVectorBytes, ragRecords: Math.max(0, vectorRows - hunterVectors.rows), hunterRecords: hunterVectors.rows + historyVectorRows, historyRecords: historyVectorRows } },
      blobs: { id: "blobs", bytes: blobBytes, files: blobFiles.length, path: paths.blobs, measurement: "physical", detail: "Hunter blob files only." },
      replay: { id: "replay", bytes: replayBytes, files: replayFiles.length, path: paths.replay, measurement: "physical", detail: "Hunter replay files only." },
      imagery: { id: "imagery", bytes: imageryBytes, files: imageryFiles.length, path: paths.imagery, measurement: "physical", detail: "Imagery cache files only." },
      "osint-database": { id: "osint-database", bytes: osintDatabaseBytes, files: osintDatabaseBytes ? 1 : 0, path: paths.osintDatabase, measurement: "physical", detail: "Isolated OSINT evidence database; never shared with chat, memory, RAG, or Hunter history." },
      "osint-wal": { id: "osint-wal", bytes: osintWalBytes, files: osintWalBytes ? 1 : 0, path: `${paths.osintDatabase}-wal`, measurement: "physical", detail: "Isolated OSINT write-ahead log measured independently." },
      "osint-backups": { id: "osint-backups", bytes: osintBackupBytes, files: osintBackupFiles.length, path: paths.osintBackups, measurement: "physical", detail: "Validated pre-migration OSINT recovery backups; never mixed with operator exports." },
    };
    const now = this.now();
    const used: Record<StorageBudgetId, number> = {
      "hunter-observations": hunterRows.bytes + hunterVectors.bytes + historyDatabaseBytes + historyWalBytes + blobBytes + replayBytes,
      "chat-memory": chatBytes,
      "imagery-cache": imageryBytes,
      "osint-investigations": osintDatabaseBytes + osintWalBytes + osintBackupBytes,
    };
    const budgets = {} as StorageMeasurementReport["budgets"];
    for (const id of Object.keys(this.configs) as StorageBudgetId[]) {
      const config = this.configs[id]; const utilization = used[id] / config.limitBytes;
      const projected = this.recordProjection(id, used[id], now, config.limitBytes);
      budgets[id] = { ...clone(config), usedBytes: used[id], utilization, state: utilization >= 1 ? "full" : utilization >= config.highWatermark ? "high" : "normal", projectedTimeToFullMs: projected.ms, projectedFullAt: projected.at };
    }
    const report: StorageMeasurementReport = { measuredAt: new Date(now).toISOString(), components, budgets, activity: this.activitySnapshot(), note: "Physical DB/WAL totals and logical ownership are deliberately separate; shared chat data is never assigned to Hunter or OSINT cleanup." };
    this.emit({ type: "measured" });
    return report;
  }

  /** Rejects any prospective managed write before it crosses the selected safe high watermark. */
  async ensureWriteAllowed(id: StorageBudgetId, estimatedBytes: number, signal?: AbortSignal) {
    if (!Number.isFinite(estimatedBytes) || estimatedBytes < 0) throw new StorageBudgetError("INVALID_CONFIG", "Prospective storage bytes must be a non-negative number.");
    const report = await this.measure(signal); const budget = report.budgets[id];
    const highBytes = Math.floor(budget.limitBytes * budget.highWatermark);
    if (budget.usedBytes + estimatedBytes > highBytes) {
      throw new StorageBudgetError("BUDGET_EXCEEDED", `${budget.label} is at its safe write ceiling. Run the dry-run report or increase the budget before recording more data.`);
    }
    return { allowed: true, currentBytes: budget.usedBytes, projectedBytes: budget.usedBytes + estimatedBytes, highBytes };
  }

  async dryRun(id: StorageBudgetId, signal?: AbortSignal): Promise<StorageDryRunReport> {
    const report = await this.measure(signal); const budget = report.budgets[id];
    if (!budget) throw new StorageBudgetError("INVALID_CONFIG", "Unknown storage budget.");
    const highBytes = Math.floor(budget.limitBytes * budget.highWatermark);
    const targetBytes = Math.floor(budget.limitBytes * budget.lowWatermark);
    const bytesToRecover = budget.usedBytes >= highBytes ? Math.max(0, budget.usedBytes - targetBytes) : 0;
    const actions: StorageCleanupAction[] = [];
    if (bytesToRecover && id === "hunter-observations") {
      let remaining = bytesToRecover;
      const candidates: Array<[StorageClearScope, StorageComponentMeasurement, string]> = [
        ["hunter-replay", report.components.replay, "Oldest replay files first"],
        ["hunter-blobs", report.components.blobs, "Oldest Hunter blobs first"],
        ["hunter-vectors", { ...report.components.vectors, bytes: report.components.vectors.ownership?.hunterBytes ?? 0, files: report.components.vectors.ownership?.hunterRecords ?? 0 }, "Hunter vector rows only; RAG vectors excluded"],
        ["hunter-observation-rows", { ...report.components.database, bytes: report.components.database.ownership?.hunterObservationBytes ?? 0, files: report.components.database.ownership?.hunterObservationRecords ?? 0 }, "Oldest Hunter observations with dependent Hunter rows"],
      ];
      for (const [scope, component, reason] of candidates) {
        const estimatedBytes = Math.min(remaining, component.bytes);
        if (estimatedBytes > 0) actions.push({ scope, estimatedBytes, estimatedRecords: component.files, reason });
        remaining -= estimatedBytes;
        if (remaining <= 0) break;
      }
    } else if (bytesToRecover && id === "imagery-cache") {
      actions.push({ scope: "imagery-cache", estimatedBytes: bytesToRecover, estimatedRecords: report.components.imagery.files, reason: "Oldest cache files first" });
    }
    const result: StorageDryRunReport = {
      id: randomUUID(), createdAt: new Date(this.now()).toISOString(), budgetId: id, currentBytes: budget.usedBytes,
      highBytes, targetBytes, bytesToRecover, actions, protectedScopes: id === "hunter-observations" ? ["chat-memory"] : [], realEvictionEnabled: false,
      note: id === "chat-memory" ? "Chat memory is manual-only and cannot be selected by Hunter cleanup." : "This report performs no writes. Production eviction remains approval-gated.",
    };
    this.emit({ type: "dry-run", budgetId: id });
    return result;
  }

  private requireSyntheticMutation() {
    if (this.mode !== "synthetic") throw new StorageBudgetError("APPROVAL_REQUIRED", "Real eviction is disabled until the Stage 4 dry-run and synthetic stress reports are approved.");
  }

  private requireIdle() {
    const activity = this.activitySnapshot();
    if (activity.hunterWrites || activity.ragWrites) throw new StorageBudgetError("ACTIVE_WRITES", "Storage mutation is blocked while Hunter-Seeker or RAG writes are active.");
  }

  private async requireDiskHeadroom(targetPath = this.dataRoot, additionalBytes = 0) {
    await fs.mkdir(targetPath, { recursive: true });
    const databaseSetBytes = await fileSize(this.databasePath) + await fileSize(`${this.databasePath}-wal`) + await fileSize(`${this.databasePath}-shm`);
    const required = Math.max(this.minimumMigrationReserveBytes, databaseSetBytes * 2 + 64 * MIB, additionalBytes + 64 * MIB);
    if (await this.freeDiskBytes(targetPath) < required) throw new StorageBudgetError("INSUFFICIENT_DISK", `The operation needs at least ${required.toLocaleString()} bytes of free disk space for a validated backup and rollback margin.`);
  }

  private scopeFiles(scope: StorageClearScope) {
    const paths = this.paths();
    if (scope === "hunter-blobs") return paths.blobs;
    if (scope === "hunter-replay") return paths.replay;
    if (scope === "imagery-cache") return paths.imagery;
    return null;
  }

  private async exportBeforeClear(scope: StorageClearScope, exportRoot: string, signal?: AbortSignal): Promise<StorageExportReport> {
    throwIfCancelled(signal); this.requireIdle();
    const resolvedExportRoot = path.resolve(exportRoot);
    if (isInside(this.dataRoot, resolvedExportRoot)) throw new StorageBudgetError("UNSAFE_PATH", "Exports must be outside VoidCat's managed data directory.");
    await fs.mkdir(resolvedExportRoot, { recursive: true });
    const fileRoot = this.scopeFiles(scope); const scopedFiles = fileRoot ? await listFiles(fileRoot, signal) : [];
    const scopedBytes = scopedFiles.reduce((total, file) => total + file.size, 0);
    await this.requireDiskHeadroom(this.dataRoot);
    await this.requireDiskHeadroom(resolvedExportRoot, scopedBytes);
    const directory = path.join(resolvedExportRoot, `voidcat-${scope}-${new Date(this.now()).toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`);
    await fs.mkdir(directory, { recursive: true });
    let files = 0; let bytes = 0; let databaseValidated = false;
    const databaseRelevant = ["hunter-observation-rows", "hunter-vectors", "chat-memory"].includes(scope);
    if (databaseRelevant && await fileSize(this.databasePath)) {
      for (const suffix of ["", "-wal", "-shm"]) {
        throwIfCancelled(signal);
        const source = `${this.databasePath}${suffix}`;
        const size = await fileSize(source);
        if (!size) continue;
        await fs.copyFile(source, path.join(directory, `voidcat.db${suffix}`)); files += 1; bytes += size;
      }
      databaseValidated = validateDatabase(path.join(directory, "voidcat.db"));
      if (!databaseValidated) throw new StorageBudgetError("VALIDATION_FAILED", "The database export did not pass SQLite quick_check; no data was cleared.");
    }
    if (fileRoot) {
      for (const file of scopedFiles) {
        if (!isInside(fileRoot, file.absolutePath)) throw new StorageBudgetError("UNSAFE_PATH", "A scoped export path escaped its managed directory.");
        const target = path.join(directory, "files", file.relativePath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(file.absolutePath, target); files += 1; bytes += file.size;
      }
    }
    const report: StorageExportReport = { id: randomUUID(), scope, exportedAt: new Date(this.now()).toISOString(), directory, files, bytes, databaseValidated };
    await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify(report, null, 2), "utf8");
    this.emit({ type: "exported", scope });
    return report;
  }

  async backup(exportRoot: string, signal?: AbortSignal) {
    return this.exportBeforeClear("chat-memory", exportRoot, signal);
  }

  private ensureDeadline(startedMs: number, signal?: AbortSignal) {
    throwIfCancelled(signal);
    if (this.now() - startedMs > this.maxOperationMs) throw new StorageBudgetError("CANCELLED", "The bounded storage operation reached its wall-clock limit and stopped safely.");
  }

  private async clearTableBatches(database: DatabaseSync, table: string, startedMs: number, signal?: AbortSignal) {
    if (!tableExists(database, table)) return 0;
    const identifier = safeIdentifier(table); let deleted = 0;
    while (true) {
      this.ensureDeadline(startedMs, signal);
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = database.prepare(`DELETE FROM ${identifier} WHERE rowid IN (SELECT rowid FROM ${identifier} LIMIT ?)`)
          .run(this.batchSize);
        database.exec("COMMIT");
        const changes = Number(result.changes); deleted += changes;
        if (changes < this.batchSize) return deleted;
      } catch (error) { database.exec("ROLLBACK"); throw error; }
      await yieldToEventLoop();
    }
  }

  private async clearObservations(database: DatabaseSync, startedMs: number, signal?: AbortSignal) {
    if (!tableExists(database, TABLES.hunterObservations)) return 0;
    let deleted = 0;
    while (true) {
      this.ensureDeadline(startedMs, signal);
      const ids = database.prepare(`SELECT id FROM ${safeIdentifier(TABLES.hunterObservations)} ORDER BY rowid LIMIT ?`).all(this.batchSize) as Array<{ id: string }>;
      if (!ids.length) return deleted;
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const { id } of ids) {
          if (tableExists(database, TABLES.hunterVectors)) database.prepare(`DELETE FROM ${safeIdentifier(TABLES.hunterVectors)} WHERE observation_id = ?`).run(id);
          if (tableExists(database, TABLES.hunterSources)) database.prepare(`DELETE FROM ${safeIdentifier(TABLES.hunterSources)} WHERE observation_id = ?`).run(id);
          database.prepare(`DELETE FROM ${safeIdentifier(TABLES.hunterObservations)} WHERE id = ?`).run(id);
        }
        database.exec("COMMIT"); deleted += ids.length;
      } catch (error) { database.exec("ROLLBACK"); throw error; }
      const consistency = this.verifyConsistencyWith(database);
      if (!consistency.valid) throw new StorageBudgetError("VALIDATION_FAILED", "Synthetic eviction created an orphaned Hunter vector or source row.");
      await yieldToEventLoop();
    }
  }

  private verifyConsistencyWith(database: DatabaseSync): StorageConsistencyReport {
    const orphanCount = (table: string) => {
      if (!tableExists(database, table)) return 0;
      if (!tableExists(database, TABLES.hunterObservations)) return Number((database.prepare(`SELECT COUNT(*) AS count FROM ${safeIdentifier(table)}`).get() as { count: number }).count) || 0;
      const row = database.prepare(`SELECT COUNT(*) AS count FROM ${safeIdentifier(table)} child LEFT JOIN ${safeIdentifier(TABLES.hunterObservations)} parent ON parent.id = child.observation_id WHERE parent.id IS NULL`).get() as { count: number };
      return Number(row.count) || 0;
    };
    const orphanVectors = orphanCount(TABLES.hunterVectors); const orphanSources = orphanCount(TABLES.hunterSources);
    return { checkedAt: new Date(this.now()).toISOString(), orphanVectors, orphanSources, valid: orphanVectors === 0 && orphanSources === 0 };
  }

  verifyConsistency(): StorageConsistencyReport {
    if (!validateDatabase(this.databasePath)) throw new StorageBudgetError("VALIDATION_FAILED", "SQLite quick_check failed.");
    const database = new DatabaseSync(this.databasePath, { readOnly: true });
    try { return this.verifyConsistencyWith(database); } finally { database.close(); }
  }

  async clear(scope: StorageClearScope, options: { exportDirectory: string; confirmation?: string; signal?: AbortSignal }): Promise<StorageClearReport> {
    this.requireSyntheticMutation(); this.requireIdle(); throwIfCancelled(options.signal);
    if (scope === "chat-memory" && options.confirmation !== "CLEAR_CHAT_MEMORY") throw new StorageBudgetError("UNSUPPORTED_SCOPE", "Chat memory requires the dedicated CLEAR_CHAT_MEMORY confirmation and is never part of Hunter cleanup.");
    const startedMs = this.now(); const startedAt = new Date(startedMs).toISOString();
    const before = await this.measure(options.signal); const exported = await this.exportBeforeClear(scope, options.exportDirectory, options.signal);
    let recordsDeleted = 0; let filesDeleted = 0;
    const fileRoot = this.scopeFiles(scope);
    if (fileRoot) {
      const files = (await listFiles(fileRoot, options.signal)).sort((left, right) => left.modifiedMs - right.modifiedMs);
      for (const file of files) {
        this.ensureDeadline(startedMs, options.signal);
        if (!isInside(fileRoot, file.absolutePath)) throw new StorageBudgetError("UNSAFE_PATH", "A scoped clear path escaped its managed directory.");
        await fs.rm(file.absolutePath, { force: true }); filesDeleted += 1;
      }
    } else {
      const database = new DatabaseSync(this.databasePath);
      try {
        database.exec("PRAGMA foreign_keys = ON");
        if (scope === "hunter-observation-rows") recordsDeleted = await this.clearObservations(database, startedMs, options.signal);
        else if (scope === "hunter-vectors") recordsDeleted = await this.clearTableBatches(database, TABLES.hunterVectors, startedMs, options.signal);
        else if (scope === "chat-memory") {
          for (const table of ["messages", "conversations", "memories"]) recordsDeleted += await this.clearTableBatches(database, table, startedMs, options.signal);
        } else throw new StorageBudgetError("UNSUPPORTED_SCOPE", "The clear scope is not supported.");
      } finally { database.close(); }
    }
    const after = await this.measure(options.signal); const consistency = this.verifyConsistency();
    const budgetId: StorageBudgetId = scope === "chat-memory" ? "chat-memory" : scope === "imagery-cache" ? "imagery-cache" : "hunter-observations";
    const result: StorageClearReport = { scope, startedAt, completedAt: new Date(this.now()).toISOString(), recordsDeleted, filesDeleted,
      bytesRecoveredEstimate: Math.max(0, before.budgets[budgetId].usedBytes - after.budgets[budgetId].usedBytes), export: exported, consistency };
    this.emit({ type: "cleared", scope, budgetId });
    return result;
  }

  async migrate(input: { name: string; statements: string[]; backupDirectory: string; signal?: AbortSignal }): Promise<StorageMigrationReport> {
    this.requireSyntheticMutation(); this.requireIdle(); throwIfCancelled(input.signal);
    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(input.name) || !input.statements.length || input.statements.length > 32
      || input.statements.some((statement) => statement.length > 16_384) || input.statements.reduce((total, statement) => total + statement.length, 0) > 131_072) {
      throw new StorageBudgetError("VALIDATION_FAILED", "A migration needs a safe name and 1-32 bounded statements within the 128 KiB plan limit.");
    }
    const allowed = /^\s*(CREATE\s+(TABLE|INDEX)|ALTER\s+TABLE)\b/i;
    if (input.statements.some((statement) => !allowed.test(statement) || /\b(VACUUM|ATTACH|DETACH|PRAGMA|DROP|DELETE|UPDATE|INSERT|REPLACE)\b/i.test(statement))) {
      throw new StorageBudgetError("VALIDATION_FAILED", "Only bounded CREATE TABLE, CREATE INDEX, and ALTER TABLE migration statements are allowed.");
    }
    await this.requireDiskHeadroom();
    if (!validateDatabase(this.databasePath)) throw new StorageBudgetError("VALIDATION_FAILED", "The source database failed quick_check; migration was not started.");
    const startedMs = this.now(); const startedAt = new Date(startedMs).toISOString();
    const backup = await this.exportBeforeClear("hunter-observation-rows", input.backupDirectory, input.signal);
    const planPath = path.join(this.dataRoot, `.migration-${randomUUID()}.json`);
    await fs.writeFile(planPath, JSON.stringify(input.statements), { encoding: "utf8", flag: "wx" });
    let applied = 0;
    try {
      const result = await new Promise<{ applied: number }>((resolve, reject) => {
        const child = spawn(process.execPath, ["-e", MIGRATION_WORKER, this.databasePath, planPath], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = ""; let stderr = ""; let settled = false; let cancellationError: StorageBudgetError | null = null;
        const finish = (error?: Error) => {
          if (settled) return; settled = true; clearTimeout(timeout); input.signal?.removeEventListener("abort", cancel);
          if (error) reject(error);
          else {
            try { resolve(JSON.parse(stdout) as { applied: number }); }
            catch { reject(new StorageBudgetError("VALIDATION_FAILED", "The bounded migration worker returned an invalid result.")); }
          }
        };
        const cancel = () => {
          if (settled || cancellationError) return;
          cancellationError = new StorageBudgetError("CANCELLED", "The bounded migration worker was cancelled and its transaction was rolled back.");
          child.kill();
        };
        const timeout = setTimeout(cancel, this.maxOperationMs);
        child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => { stdout += chunk; }); child.stderr.on("data", (chunk: string) => { stderr += chunk; });
        child.once("error", (error) => finish(error));
        child.once("exit", (code) => finish(cancellationError ?? (code === 0 ? undefined : new StorageBudgetError("VALIDATION_FAILED", stderr || `Migration worker exited with code ${code}.`))));
        input.signal?.addEventListener("abort", cancel, { once: true });
        if (input.signal?.aborted) cancel();
      });
      applied = result.applied;
    } catch (error) {
      if (!validateDatabase(this.databasePath)) throw new StorageBudgetError("VALIDATION_FAILED", "The interrupted database failed quick_check. The validated pre-migration backup was preserved.");
      throw error;
    } finally { await fs.rm(planPath, { force: true }); }
    const databaseValidated = validateDatabase(this.databasePath);
    if (!databaseValidated) throw new StorageBudgetError("VALIDATION_FAILED", "The migrated database failed quick_check. The validated pre-migration backup was preserved.");
    const result = { name: input.name, startedAt, completedAt: new Date(this.now()).toISOString(), statementsApplied: applied, backup, databaseValidated };
    this.emit({ type: "migrated" });
    return result;
  }
}

export const storageWriteActivity = new StorageWriteActivityTracker();
