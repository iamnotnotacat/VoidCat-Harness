import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  StorageBudgetError,
  StorageWriteActivityTracker,
  VoidCatStorageBudgetManager,
  type StorageManagerEvent,
} from "../build/voidcat-storage-budget-manager.ts";

async function disposableRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "voidcat-storage-test-"));
}

async function exportRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "voidcat-export-test-"));
}

function seedDatabase(databasePath: string, count = 20) {
  const database = new DatabaseSync(databasePath);
  database.exec(`PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, content TEXT);
    CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT);
    CREATE TABLE document_chunks (id TEXT PRIMARY KEY, embedding TEXT, content TEXT);
    CREATE TABLE rag_vector_index_v1 (chunk_id TEXT PRIMARY KEY, signature TEXT);
    CREATE TABLE rag_vector_buckets_v1 (chunk_id TEXT, bucket_key TEXT);
    CREATE TABLE hunter_observations_v1 (id TEXT PRIMARY KEY, observed_at TEXT, payload TEXT);
    CREATE TABLE hunter_observation_vectors_v1 (observation_id TEXT PRIMARY KEY, vector TEXT);
    CREATE TABLE hunter_observation_sources_v1 (observation_id TEXT PRIMARY KEY, source TEXT);`);
  database.exec("BEGIN");
  try {
    const conversation = database.prepare("INSERT INTO conversations VALUES (?, ?)");
    const message = database.prepare("INSERT INTO messages VALUES (?, ?, ?)");
    const memory = database.prepare("INSERT INTO memories VALUES (?, ?)");
    const ragVector = database.prepare("INSERT INTO rag_vector_index_v1 VALUES (?, ?)");
    const ragBucket = database.prepare("INSERT INTO rag_vector_buckets_v1 VALUES (?, ?)");
    const embedding = database.prepare("INSERT INTO document_chunks VALUES (?, ?, ?)");
    const observation = database.prepare("INSERT INTO hunter_observations_v1 VALUES (?, ?, ?)");
    const vector = database.prepare("INSERT INTO hunter_observation_vectors_v1 VALUES (?, ?)");
    const source = database.prepare("INSERT INTO hunter_observation_sources_v1 VALUES (?, ?)");
    for (let index = 0; index < count; index += 1) {
      const id = `obs-${index}`;
      observation.run(id, new Date(1_700_000_000_000 + index).toISOString(), `payload-${index}-${"x".repeat(128)}`);
      vector.run(id, `vector-${"v".repeat(96)}`);
      source.run(id, `source-${index}`);
      ragVector.run(`chunk-${index}`, `rag-${"r".repeat(80)}`);
      ragBucket.run(`chunk-${index}`, `bucket-${index % 8}`);
      embedding.run(`chunk-${index}`, `[${"0.125,".repeat(32)}0.5]`, `passage-${index}`);
    }
    conversation.run("conversation-1", "Protected chat");
    message.run("message-1", "conversation-1", "This must survive Hunter cleanup.");
    memory.run("memory-1", "Protected persistent memory");
    database.exec("COMMIT");
  } catch (error) { database.exec("ROLLBACK"); throw error; }
  database.close();
}

async function createFiles(root: string) {
  const blobRoot = path.join(root, "hunter", "blobs");
  const replayRoot = path.join(root, "hunter", "replay");
  const imageryRoot = path.join(root, "imagery");
  await Promise.all([fs.mkdir(blobRoot, { recursive: true }), fs.mkdir(replayRoot, { recursive: true }), fs.mkdir(imageryRoot, { recursive: true })]);
  await Promise.all([
    fs.writeFile(path.join(blobRoot, "blob-a.bin"), Buffer.alloc(620_000, 1)),
    fs.writeFile(path.join(replayRoot, "replay-a.json"), Buffer.alloc(180_000, 2)),
    fs.writeFile(path.join(imageryRoot, "tile-a.bin"), Buffer.alloc(320_000, 3)),
  ]);
}

async function cleanup(...roots: string[]) {
  for (const root of roots) {
    const resolved = path.resolve(root);
    assert.ok(path.basename(resolved).startsWith("voidcat-storage-test-") || path.basename(resolved).startsWith("voidcat-export-test-"));
    await fs.rm(resolved, { recursive: true, force: true });
  }
}

test("registers the four isolated budgets and measures DB, WAL, vectors, blobs, replay, imagery, and OSINT separately", async () => {
  const root = await disposableRoot();
  let walDatabase: DatabaseSync | null = null;
  try {
    const databasePath = path.join(root, "voidcat.db");
    seedDatabase(databasePath, 25); await createFiles(root);
    walDatabase = new DatabaseSync(databasePath);
    walDatabase.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE wal_measurement_probe (id TEXT); INSERT INTO wal_measurement_probe VALUES ('active-wal');");
    const manager = new VoidCatStorageBudgetManager({ dataRoot: root, databasePath });
    const report = await manager.measure();
    assert.deepEqual(manager.listBudgets().map(({ id }) => id), ["hunter-observations", "chat-memory", "imagery-cache", "osint-investigations"]);
    assert.deepEqual(Object.keys(report.components), ["database", "wal", "history-database", "history-wal", "vectors", "blobs", "replay", "imagery", "osint-database", "osint-wal", "osint-backups"]);
    assert.equal(report.components["history-database"].measurement, "physical");
    assert.equal(report.components["history-wal"].measurement, "physical");
    assert.ok(report.components.database.bytes > 0);
    assert.ok(report.components.wal.bytes > 0);
    assert.ok(report.components.vectors.bytes > 0);
    assert.ok((report.components.vectors.ownership?.ragBytes ?? 0) > 0);
    assert.ok((report.components.vectors.ownership?.hunterBytes ?? 0) > 0);
    assert.equal(report.components.blobs.bytes, 620_000);
    assert.equal(report.components.replay.bytes, 180_000);
    assert.equal(report.components.imagery.bytes, 320_000);
    assert.ok(report.budgets["chat-memory"].usedBytes > 0);
    assert.match(report.note, /chat data is never assigned/i);
  } finally { walDatabase?.close(); await cleanup(root); }
});

test("validates configurable watermarks and projects time-to-full from bounded samples", async () => {
  const root = await disposableRoot();
  try {
    const databasePath = path.join(root, "voidcat.db"); seedDatabase(databasePath, 2); await createFiles(root);
    let currentTime = 1_800_000_000_000;
    const manager = new VoidCatStorageBudgetManager({ dataRoot: root, databasePath, now: () => currentTime });
    const configured = manager.configure("imagery-cache", { limitBytes: 1024 ** 2, highWatermark: 0.8, lowWatermark: 0.6 });
    assert.equal(configured.automaticCleanup, false);
    await manager.measure();
    currentTime += 60_000;
    await fs.appendFile(path.join(root, "imagery", "tile-a.bin"), Buffer.alloc(100_000, 4));
    const second = await manager.measure();
    assert.ok((second.budgets["imagery-cache"].projectedTimeToFullMs ?? 0) > 0);
    assert.ok(second.budgets["imagery-cache"].projectedFullAt);
    assert.throws(() => manager.configure("imagery-cache", { lowWatermark: 0.9, highWatermark: 0.8 }), (error: unknown) => error instanceof StorageBudgetError && error.code === "INVALID_CONFIG");
  } finally { await cleanup(root); }
});

test("pre-write guard rejects Hunter writes that would cross the configured high watermark", async () => {
  const root = await disposableRoot();
  try {
    const databasePath = path.join(root, "voidcat.db"); seedDatabase(databasePath, 2); await createFiles(root);
    const manager = new VoidCatStorageBudgetManager({ dataRoot: root, databasePath });
    manager.configure("hunter-observations", { limitBytes: 2 * 1024 ** 2, highWatermark: 0.9, lowWatermark: 0.7 });
    await manager.ensureWriteAllowed("hunter-observations", 1);
    await assert.rejects(manager.ensureWriteAllowed("hunter-observations", 2 * 1024 ** 2), (error: unknown) => error instanceof StorageBudgetError && error.code === "BUDGET_EXCEEDED");
  } finally { await cleanup(root); }
});

test("dry-run is non-mutating, targets the low watermark, and cannot select chat memory for Hunter cleanup", async () => {
  const root = await disposableRoot();
  try {
    const databasePath = path.join(root, "voidcat.db"); seedDatabase(databasePath, 12); await createFiles(root);
    const manager = new VoidCatStorageBudgetManager({ dataRoot: root, databasePath });
    manager.configure("hunter-observations", { limitBytes: 1024 ** 2, highWatermark: 0.7, lowWatermark: 0.4 });
    const before = await manager.measure();
    const report = await manager.dryRun("hunter-observations");
    const after = await manager.measure();
    assert.ok(report.bytesToRecover > 0);
    assert.equal(report.targetBytes, Math.floor(1024 ** 2 * 0.4));
    assert.ok(report.actions.length > 0);
    assert.ok(report.actions.every(({ scope }) => scope !== "chat-memory"));
    assert.deepEqual(report.protectedScopes, ["chat-memory"]);
    assert.equal(report.realEvictionEnabled, false);
    assert.equal(after.budgets["hunter-observations"].usedBytes, before.budgets["hunter-observations"].usedBytes);
    assert.equal((await fs.stat(path.join(root, "hunter", "blobs", "blob-a.bin"))).size, 620_000);
    manager.configure("imagery-cache", { limitBytes: 1024 ** 2, highWatermark: 0.2, lowWatermark: 0.1 });
    const imagery = await manager.dryRun("imagery-cache");
    assert.deepEqual(imagery.actions.map(({ scope }) => scope), ["imagery-cache"]);
    manager.configure("chat-memory", { limitBytes: 1024 ** 2, highWatermark: 0.0005, lowWatermark: 0.0001 });
    const chat = await manager.dryRun("chat-memory");
    assert.deepEqual(chat.actions, []);
    assert.match(chat.note, /manual-only/i);
  } finally { await cleanup(root); }
});

test("publishes isolated state changes", async () => {
  const root = await disposableRoot();
  try {
    const databasePath = path.join(root, "voidcat.db"); seedDatabase(databasePath, 1);
    const manager = new VoidCatStorageBudgetManager({ dataRoot: root, databasePath });
    const received: StorageManagerEvent[] = [];
    manager.subscribe((event) => { (event as { type: string }).type = "corrupted"; throw new Error("listener failure"); });
    const unsubscribe = manager.subscribe((event) => { received.push(event); });
    manager.configure("chat-memory", { highWatermark: 0.92, lowWatermark: 0.8 });
    await manager.measure(); unsubscribe(); await manager.dryRun("chat-memory");
    assert.deepEqual(received.map(({ type }) => type), ["configured", "measured"]);
    assert.deepEqual(received.map(({ sequence }) => sequence), [1, 2]);
  } finally { await cleanup(root); }
});

test("activity tracker publishes begin/end state changes without double counting", () => {
  const tracker = new StorageWriteActivityTracker(); const snapshots: Array<{ hunterWrites: number; ragWrites: number }> = [];
  const unsubscribe = tracker.subscribe((snapshot) => snapshots.push(snapshot));
  const finishRag = tracker.begin("rag"); const finishHunter = tracker.begin("hunter");
  finishRag(); finishRag(); finishHunter(); unsubscribe(); tracker.begin("rag")();
  assert.deepEqual(snapshots, [
    { hunterWrites: 0, ragWrites: 1 }, { hunterWrites: 1, ragWrites: 1 },
    { hunterWrites: 1, ragWrites: 0 }, { hunterWrites: 0, ragWrites: 0 },
  ]);
});

test("synthetic mode cannot point outside its exact disposable data root", async () => {
  const root = await disposableRoot(); const other = await disposableRoot();
  try {
    assert.throws(() => new VoidCatStorageBudgetManager({ dataRoot: root, databasePath: path.join(other, "voidcat.db"), mode: "synthetic" }),
      (error: unknown) => error instanceof StorageBudgetError && error.code === "UNSAFE_PATH");
    assert.throws(() => new VoidCatStorageBudgetManager({ dataRoot: root, databasePath: path.join(root, "nested", "voidcat.db"), mode: "synthetic" }),
      (error: unknown) => error instanceof StorageBudgetError && error.code === "UNSAFE_PATH");
  } finally { await cleanup(root, other); }
});

test("production mode rejects every real clear and migration before touching data", async () => {
  const root = await disposableRoot(); const exports = await exportRoot();
  try {
    const databasePath = path.join(root, "voidcat.db"); seedDatabase(databasePath, 3); await createFiles(root);
    const manager = new VoidCatStorageBudgetManager({ dataRoot: root, databasePath, mode: "production" });
    await assert.rejects(manager.clear("hunter-blobs", { exportDirectory: exports }), (error: unknown) => error instanceof StorageBudgetError && error.code === "APPROVAL_REQUIRED");
    await assert.rejects(manager.migrate({ name: "blocked", statements: ["CREATE TABLE blocked (id TEXT)"], backupDirectory: exports }), (error: unknown) => error instanceof StorageBudgetError && error.code === "APPROVAL_REQUIRED");
    assert.equal((await fs.stat(path.join(root, "hunter", "blobs", "blob-a.bin"))).size, 620_000);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM hunter_observations_v1").get() as { count: number }).count, 3);
    database.close();
  } finally { await cleanup(root, exports); }
});

test("synthetic typed clears always export first and protect chat/RAG data", async () => {
  const root = await disposableRoot(); const exports = await exportRoot();
  try {
    const databasePath = path.join(root, "voidcat.db"); seedDatabase(databasePath, 240); await createFiles(root);
    const manager = new VoidCatStorageBudgetManager({ dataRoot: root, databasePath, mode: "synthetic", batchSize: 23, maxOperationMs: 30_000, minimumMigrationReserveBytes: 1 });
    const report = await manager.clear("hunter-observation-rows", { exportDirectory: exports });
    assert.equal(report.recordsDeleted, 240);
    assert.equal(report.export.databaseValidated, true);
    assert.equal(report.consistency.valid, true);
    assert.equal(JSON.parse(await fs.readFile(path.join(report.export.directory, "manifest.json"), "utf8")).scope, "hunter-observation-rows");
    const database = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM hunter_observations_v1").get() as { count: number }).count, 0);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM hunter_observation_vectors_v1").get() as { count: number }).count, 0);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM hunter_observation_sources_v1").get() as { count: number }).count, 0);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM messages").get() as { count: number }).count, 1);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM memories").get() as { count: number }).count, 1);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM rag_vector_index_v1").get() as { count: number }).count, 240);
    database.close();
  } finally { await cleanup(root, exports); }
});

test("database eviction yields between bounded batches so cancellation preserves consistency", async () => {
  const root = await disposableRoot(); const exports = await exportRoot();
  try {
    const databasePath = path.join(root, "voidcat.db"); seedDatabase(databasePath, 300);
    const manager = new VoidCatStorageBudgetManager({ dataRoot: root, databasePath, mode: "synthetic", batchSize: 1, maxOperationMs: 30_000, minimumMigrationReserveBytes: 1 });
    const controller = new AbortController();
    const unsubscribe = manager.subscribe((event) => { if (event.type === "exported") setTimeout(() => controller.abort(), 0); });
    await assert.rejects(manager.clear("hunter-observation-rows", { exportDirectory: exports, signal: controller.signal }),
      (error: unknown) => error instanceof StorageBudgetError && error.code === "CANCELLED");
    unsubscribe();
    const database = new DatabaseSync(databasePath, { readOnly: true });
    const remaining = Number((database.prepare("SELECT COUNT(*) AS count FROM hunter_observations_v1").get() as { count: number }).count);
    assert.ok(remaining > 0 && remaining < 300); database.close();
    assert.equal(manager.verifyConsistency().valid, true);
  } finally { await cleanup(root, exports); }
});

test("file eviction is scoped, exported, cancelable, and does not affect sibling stores", async () => {
  const root = await disposableRoot(); const exports = await exportRoot();
  try {
    const databasePath = path.join(root, "voidcat.db"); seedDatabase(databasePath, 2); await createFiles(root);
    const manager = new VoidCatStorageBudgetManager({ dataRoot: root, databasePath, mode: "synthetic", minimumMigrationReserveBytes: 1 });
    const report = await manager.clear("hunter-replay", { exportDirectory: exports });
    assert.equal(report.filesDeleted, 1);
    await assert.rejects(fs.stat(path.join(root, "hunter", "replay", "replay-a.json")));
    assert.equal((await fs.stat(path.join(root, "hunter", "blobs", "blob-a.bin"))).size, 620_000);
    assert.equal((await fs.stat(path.join(root, "imagery", "tile-a.bin"))).size, 320_000);
    assert.equal((await fs.stat(path.join(report.export.directory, "files", "replay-a.json"))).size, 180_000);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(manager.clear("hunter-blobs", { exportDirectory: exports, signal: controller.signal }), (error: unknown) => error instanceof StorageBudgetError && error.code === "CANCELLED");
  } finally { await cleanup(root, exports); }
});

test("export-space checks include scoped files and run against the export destination", async () => {
  const root = await disposableRoot(); const exports = await exportRoot();
  try {
    const databasePath = path.join(root, "voidcat.db"); seedDatabase(databasePath, 2); await createFiles(root);
    const manager = new VoidCatStorageBudgetManager({
      dataRoot: root, databasePath, mode: "synthetic", minimumMigrationReserveBytes: 1,
      freeDiskBytes: async (target) => path.resolve(target) === path.resolve(exports) ? 700_000 : 10 * 1024 ** 3,
    });
    await assert.rejects(manager.clear("hunter-blobs", { exportDirectory: exports }), (error: unknown) => error instanceof StorageBudgetError && error.code === "INSUFFICIENT_DISK");
    assert.equal((await fs.stat(path.join(root, "hunter", "blobs", "blob-a.bin"))).size, 620_000);
    assert.deepEqual(await fs.readdir(exports), []);
  } finally { await cleanup(root, exports); }
});

test("active Hunter/RAG writes and insufficient disk block mutation and migration", async () => {
  const root = await disposableRoot(); const exports = await exportRoot();
  try {
    const databasePath = path.join(root, "voidcat.db"); seedDatabase(databasePath, 2); await createFiles(root);
    const tracker = new StorageWriteActivityTracker(); const finish = tracker.begin("rag");
    const active = new VoidCatStorageBudgetManager({ dataRoot: root, databasePath, mode: "synthetic", activitySnapshot: () => tracker.snapshot(), minimumMigrationReserveBytes: 1 });
    await assert.rejects(active.clear("hunter-blobs", { exportDirectory: exports }), (error: unknown) => error instanceof StorageBudgetError && error.code === "ACTIVE_WRITES");
    await assert.rejects(active.migrate({ name: "active-write", statements: ["CREATE TABLE safe_a (id TEXT)"], backupDirectory: exports }), (error: unknown) => error instanceof StorageBudgetError && error.code === "ACTIVE_WRITES");
    finish();
    const finishHunter = tracker.begin("hunter");
    await assert.rejects(active.clear("hunter-blobs", { exportDirectory: exports }), (error: unknown) => error instanceof StorageBudgetError && error.code === "ACTIVE_WRITES");
    finishHunter();
    const lowDisk = new VoidCatStorageBudgetManager({ dataRoot: root, databasePath, mode: "synthetic", freeDiskBytes: async () => 0, minimumMigrationReserveBytes: 1024 ** 2 });
    await assert.rejects(lowDisk.migrate({ name: "low-disk", statements: ["CREATE TABLE safe_b (id TEXT)"], backupDirectory: exports }), (error: unknown) => error instanceof StorageBudgetError && error.code === "INSUFFICIENT_DISK");
  } finally { await cleanup(root, exports); }
});

test("synthetic migrations back up and validate before bounded DDL, reject unsafe reclaim, and honor cancellation", async () => {
  const root = await disposableRoot(); const exports = await exportRoot();
  try {
    const databasePath = path.join(root, "voidcat.db"); seedDatabase(databasePath, 10);
    const manager = new VoidCatStorageBudgetManager({ dataRoot: root, databasePath, mode: "synthetic", minimumMigrationReserveBytes: 1 });
    const migrated = await manager.migrate({ name: "add-synthetic-index", statements: ["CREATE TABLE hunter_history_metadata_v1 (id TEXT PRIMARY KEY)", "CREATE INDEX hunter_history_metadata_id_v1 ON hunter_history_metadata_v1(id)"], backupDirectory: exports });
    assert.equal(migrated.databaseValidated, true);
    assert.equal(migrated.backup.databaseValidated, true);
    assert.equal(migrated.statementsApplied, 2);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'hunter_history_metadata_v1'").get()); database.close();
    await assert.rejects(manager.migrate({ name: "unsafe-reclaim", statements: ["VACUUM"], backupDirectory: exports }), (error: unknown) => error instanceof StorageBudgetError && error.code === "VALIDATION_FAILED");
    const controller = new AbortController(); controller.abort();
    await assert.rejects(manager.migrate({ name: "cancelled", statements: ["CREATE TABLE never_created (id TEXT)"], backupDirectory: exports, signal: controller.signal }), (error: unknown) => error instanceof StorageBudgetError && error.code === "CANCELLED");
    const betweenController = new AbortController();
    const unsubscribe = manager.subscribe((event) => { if (event.type === "exported") setTimeout(() => betweenController.abort(), 5); });
    await assert.rejects(manager.migrate({ name: "cancel-after-backup", statements: ["CREATE TABLE never_created_after_backup (id TEXT)"], backupDirectory: exports, signal: betweenController.signal }),
      (error: unknown) => error instanceof StorageBudgetError && error.code === "CANCELLED");
    unsubscribe();
    const afterCancel = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(afterCancel.prepare("SELECT 1 FROM sqlite_master WHERE name = 'never_created_after_backup'").get(), undefined); afterCancel.close();
  } finally { await cleanup(root, exports); }
});

test("a corrupt disposable source database is rejected before migration", async () => {
  const root = await disposableRoot(); const exports = await exportRoot();
  try {
    const databasePath = path.join(root, "voidcat.db"); await fs.writeFile(databasePath, "not a sqlite database", "utf8");
    const manager = new VoidCatStorageBudgetManager({ dataRoot: root, databasePath, mode: "synthetic", minimumMigrationReserveBytes: 1 });
    await assert.rejects(manager.migrate({ name: "corrupt-source", statements: ["CREATE TABLE impossible (id TEXT)"], backupDirectory: exports }),
      (error: unknown) => error instanceof StorageBudgetError && error.code === "VALIDATION_FAILED");
    assert.deepEqual(await fs.readdir(exports), []);
  } finally { await cleanup(root, exports); }
});

test("disposable stress eviction preserves vector/source consistency after every bounded batch", async () => {
  const root = await disposableRoot(); const exports = await exportRoot();
  try {
    const databasePath = path.join(root, "voidcat.db"); seedDatabase(databasePath, 2_000);
    const manager = new VoidCatStorageBudgetManager({ dataRoot: root, databasePath, mode: "synthetic", batchSize: 37, maxOperationMs: 60_000, minimumMigrationReserveBytes: 1 });
    assert.equal(manager.verifyConsistency().valid, true);
    const result = await manager.clear("hunter-observation-rows", { exportDirectory: exports });
    assert.equal(result.recordsDeleted, 2_000);
    assert.deepEqual(result.consistency, { checkedAt: result.consistency.checkedAt, orphanVectors: 0, orphanSources: 0, valid: true });
  } finally { await cleanup(root, exports); }
});

test("consistency verification treats child rows as orphaned when the parent table is missing", async () => {
  const root = await disposableRoot();
  try {
    const databasePath = path.join(root, "voidcat.db"); seedDatabase(databasePath, 3);
    const database = new DatabaseSync(databasePath); database.exec("DROP TABLE hunter_observations_v1"); database.close();
    const manager = new VoidCatStorageBudgetManager({ dataRoot: root, databasePath, mode: "synthetic" });
    const consistency = manager.verifyConsistency();
    assert.deepEqual(consistency, { checkedAt: consistency.checkedAt, orphanVectors: 3, orphanSources: 3, valid: false });
  } finally { await cleanup(root); }
});

test("chat memory has a separate typed confirmation and is never cleared through a Hunter scope", async () => {
  const root = await disposableRoot(); const exports = await exportRoot();
  try {
    const databasePath = path.join(root, "voidcat.db"); seedDatabase(databasePath, 4);
    const manager = new VoidCatStorageBudgetManager({ dataRoot: root, databasePath, mode: "synthetic", minimumMigrationReserveBytes: 1 });
    await assert.rejects(manager.clear("chat-memory", { exportDirectory: exports }), (error: unknown) => error instanceof StorageBudgetError && error.code === "UNSUPPORTED_SCOPE");
    const database = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM messages").get() as { count: number }).count, 1); database.close();
    const cleared = await manager.clear("chat-memory", { exportDirectory: exports, confirmation: "CLEAR_CHAT_MEMORY" });
    assert.equal(cleared.export.databaseValidated, true);
    assert.ok(cleared.recordsDeleted >= 3);
  } finally { await cleanup(root, exports); }
});

test("local integration exposes measurement, dry-run, configuration, subscriptions, and a locked production clear route", async () => {
  const source = await fs.readFile(path.resolve("build", "voidcat-local-plugin.ts"), "utf8");
  assert.match(source, /\/api\/storage\/budgets/);
  assert.match(source, /\/api\/storage\/cleanup\/dry-run/);
  assert.match(source, /\/api\/storage\/events/);
  assert.match(source, /storageBudgetManager\.configure/);
  assert.match(source, /storageWriteActivity\.begin\("rag"\)/);
  assert.match(source, /\/api\/storage\/clear[\s\S]{0,300}APPROVAL_REQUIRED/);
});

test("local storage endpoints execute against a disposable application data root", async () => {
  const root = await disposableRoot();
  const repositoryRoot = process.cwd();
  const viteModule = pathToFileURL(path.resolve("node_modules", "vite", "dist", "node", "index.js")).href;
  const script = `
    import { createServer } from ${JSON.stringify(viteModule)};
    const server = await createServer({ root: ${JSON.stringify(repositoryRoot)}, configFile: ${JSON.stringify(path.join(repositoryRoot, "vite.config.ts"))}, logLevel: "silent", server: { host: "127.0.0.1", port: 0, strictPort: false } });
    await server.listen();
    const address = server.httpServer.address();
    const base = "http://127.0.0.1:" + address.port;
    async function call(url, method, body) {
      const response = await fetch(base + url, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    }
    try {
      const measured = await call("/api/storage/budgets", "GET");
      const eventController = new AbortController();
      const eventResponse = await fetch(base + "/api/storage/events", { signal: eventController.signal });
      const eventReader = eventResponse.body.getReader(); const decoder = new TextDecoder();
      const connectedEvent = decoder.decode((await eventReader.read()).value);
      const configured = await call("/api/storage/budgets/hunter-observations", "PATCH", { highWatermark: 0.81, lowWatermark: 0.62 });
      const configuredEvent = decoder.decode((await eventReader.read()).value); eventController.abort();
      const dryRun = await call("/api/storage/cleanup/dry-run", "POST", { budgetId: "hunter-observations" });
      const clear = await call("/api/storage/clear", "POST", {});
      const historyBefore = await call("/api/hunter-seeker/history/settings", "GET");
      const historyEnabled = await call("/api/hunter-seeker/history/settings", "PATCH", { enabled: true, retentionDays: 60, selectedLibraryIds: [], includeUploads: false });
      const historyQuery = await call("/api/hunter-seeker/history/query", "POST", { limit: 5 });
      const historyPaused = await call("/api/hunter-seeker/history/settings", "PATCH", { enabled: false });
      process.stdout.write(JSON.stringify({ measured, configured, dryRun, clear, historyBefore, historyEnabled, historyQuery, historyPaused, connectedEvent, configuredEvent }));
    } finally { await server.close(); }
  `;
  try {
    const serialized = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], { cwd: root, encoding: "utf8", timeout: 15_000 });
    const result = JSON.parse(serialized) as Record<string, { status: number; body: Record<string, unknown> }>;
    assert.equal(result.measured.status, 200);
    assert.deepEqual(Object.keys(result.measured.body.budgets as object), ["hunter-observations", "chat-memory", "imagery-cache", "osint-investigations"]);
    assert.equal(result.configured.status, 200); assert.equal(result.configured.body.highWatermark, 0.81); assert.equal(result.configured.body.lowWatermark, 0.62);
    assert.equal(result.dryRun.status, 200); assert.equal(result.dryRun.body.realEvictionEnabled, false);
    assert.equal(result.clear.status, 409); assert.equal(result.clear.body.errorCode, undefined); assert.match(String(result.clear.body.error), /disabled/i);
    assert.equal(result.historyBefore.status, 200); assert.equal((result.historyBefore.body.settings as { enabled: boolean }).enabled, false);
    assert.equal(result.historyEnabled.status, 200); assert.equal((result.historyEnabled.body.status as { initialized: boolean }).initialized, true);
    assert.equal(result.historyQuery.status, 200); assert.deepEqual(result.historyQuery.body.observations, []);
    assert.equal(result.historyPaused.status, 200); assert.equal((result.historyPaused.body.status as { enabled: boolean }).enabled, false);
    assert.match(String(result.connectedEvent), /"type":"connected"/); assert.match(String(result.configuredEvent), /"type":"configured"/);
  } finally { await cleanup(root); }
});

test("validated budget settings survive a backend restart", async () => {
  const root = await disposableRoot();
  const databaseModule = pathToFileURL(path.resolve("build", "voidcat-database.ts")).href;
  const nodeArguments = ["--experimental-strip-types", "--input-type=module", "--eval"];
  try {
    execFileSync(process.execPath, [...nodeArguments, `import { saveSettings } from ${JSON.stringify(databaseModule)}; saveSettings({ storageBudgetSettings: { "hunter-observations": { limitBytes: 6442450944, highWatermark: 0.82, lowWatermark: 0.61 }, "unknown-budget": { limitBytes: 1, highWatermark: 2, lowWatermark: 3 } } });`], { cwd: root });
    const serialized = execFileSync(process.execPath, [...nodeArguments, `import { getSettings } from ${JSON.stringify(databaseModule)}; process.stdout.write(JSON.stringify(getSettings().storageBudgetSettings));`], { cwd: root, encoding: "utf8" });
    assert.deepEqual(JSON.parse(serialized), { "hunter-observations": { limitBytes: 6_442_450_944, highWatermark: 0.82, lowWatermark: 0.61 } });
  } finally { await cleanup(root); }
});
