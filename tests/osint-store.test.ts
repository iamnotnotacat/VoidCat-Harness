/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { VoidCatJobManager } from "../build/voidcat-job-manager.ts";
import { VoidCatStorageBudgetManager } from "../build/voidcat-storage-budget-manager.ts";
import { MockOsintInvestigationRuntime, OsintStore, OsintStoreError, boundAndRedactRawResponse } from "../build/osint/index.ts";

const NOW = Date.parse("2026-07-28T18:00:00.000Z");

async function roots() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voidcat-osint-test-"));
  const exportRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voidcat-osint-export-test-"));
  return { dataRoot, exportRoot };
}

async function cleanup(...rootsToRemove: string[]) {
  for (const root of rootsToRemove) {
    const resolved = path.resolve(root); assert.ok(path.basename(resolved).startsWith("voidcat-osint-test-") || path.basename(resolved).startsWith("voidcat-osint-export-test-"));
    await fs.rm(resolved, { recursive: true, force: true });
  }
}

async function fixture(domain = "example.com") {
  const jobs = new VoidCatJobManager({ maximumConcurrentJobs: 1, maximumQueuedJobs: 2, minimumUpdateIntervalMs: 0, now: () => NOW });
  return new MockOsintInvestigationRuntime({ jobs, now: () => NOW }).start({ kind: "domain", domain, objective: "Persist a bounded deterministic evidence fixture." }).result;
}

async function setup(dataRoot: string, guards: number[]) {
  const sharedDatabase = path.join(dataRoot, "voidcat.db");
  const shared = new DatabaseSync(sharedDatabase); shared.exec("CREATE TABLE conversations(id TEXT PRIMARY KEY, title TEXT); INSERT INTO conversations VALUES('chat-safe','must-survive');"); shared.close();
  const budgets = new VoidCatStorageBudgetManager({ dataRoot, databasePath: sharedDatabase, initialConfigs: { "osint-investigations": { limitBytes: 8 * 1024 * 1024, highWatermark: 0.95, lowWatermark: 0.70 } } });
  const store = new OsintStore({ dataRoot, mode: "synthetic", now: () => NOW, minimumFreeBytes: 0, writeGuard: async (estimated, signal) => { guards.push(estimated); return budgets.ensureWriteAllowed("osint-investigations", estimated, signal); } });
  await store.initialize(); return { store, budgets, sharedDatabase };
}

test("isolated migration registers every Gate 3 table, creates a validated backup, and is independently budgeted", async () => {
  const { dataRoot, exportRoot } = await roots(); const osintRoot = path.join(dataRoot, "osint"); await fs.mkdir(osintRoot);
  const legacy = new DatabaseSync(path.join(osintRoot, "osint.db")); legacy.exec("CREATE TABLE legacy_probe(value TEXT); INSERT INTO legacy_probe VALUES('safe');"); legacy.close();
  const guards: number[] = [];
  try {
    const sharedDatabase = path.join(dataRoot, "voidcat.db"); const shared = new DatabaseSync(sharedDatabase); shared.exec("CREATE TABLE memories(id TEXT PRIMARY KEY, content TEXT); INSERT INTO memories VALUES('memory-safe','untouched');"); shared.close();
    const budgets = new VoidCatStorageBudgetManager({ dataRoot, databasePath: sharedDatabase });
    const store = new OsintStore({ dataRoot, mode: "synthetic", now: () => NOW, minimumFreeBytes: 0, writeGuard: async (size, signal) => { guards.push(size); return budgets.ensureWriteAllowed("osint-investigations", size, signal); } });
    const initialized = await store.initialize(); assert.equal(initialized.schemaVersion, 3); assert.equal(initialized.backupCreated, true); assert.equal(initialized.consistency.valid, true); assert.ok(guards.length >= 1);
    const database = new DatabaseSync(store.databasePath, { readOnly: true });
    const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'osint_%' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => name);
    database.close();
    for (const required of ["osint_investigations_v1", "osint_entities_v1", "osint_entity_aliases_v1", "osint_observations_v1", "osint_claims_v1", "osint_evidence_v1", "osint_relationships_v1", "osint_contradictions_v1", "osint_identity_links_v2", "osint_claim_conclusions_v2", "osint_temporal_changes_v2", "osint_contradiction_details_v2", "osint_candidate_leads_v1", "osint_provider_cache_v1", "osint_rate_limit_state_v1", "osint_invocation_logs_v1", "osint_decision_logs_v1", "osint_project_investigations_v1", "osint_project_unit_memories_v1"]) assert.ok(tables.includes(required), required);
    assert.ok((await fs.readdir(store.backupRoot)).some((name) => name.startsWith("pre-migration-")));
    const measured = await budgets.measure(); assert.ok(measured.components["osint-database"].bytes > 0); assert.ok(measured.components["osint-backups"].bytes > 0); assert.equal(measured.budgets["osint-investigations"].usedBytes, measured.components["osint-database"].bytes + measured.components["osint-wal"].bytes + measured.components["osint-backups"].bytes);
    store.close();
  } finally { await cleanup(dataRoot, exportRoot); }
});

test("reopening the current OSINT schema validates in place without accumulating migration backups", async () => {
  const { dataRoot, exportRoot } = await roots(); const guards: number[] = [];
  let first: OsintStore | null = null; let reopened: OsintStore | null = null;
  try {
    ({ store: first } = await setup(dataRoot, guards));
    first.close(); first = null;
    const budgets = new VoidCatStorageBudgetManager({ dataRoot, databasePath: path.join(dataRoot, "voidcat.db") });
    reopened = new OsintStore({ dataRoot, mode: "synthetic", now: () => NOW + 1_000, minimumFreeBytes: 0, writeGuard: async (size, signal) => budgets.ensureWriteAllowed("osint-investigations", size, signal) });
    const result = await reopened.initialize();
    assert.equal(result.backupCreated, false);
    assert.equal(result.consistency.valid, true);
    assert.deepEqual(await fs.readdir(reopened.backupRoot), []);
  } finally { first?.close(); reopened?.close(); await cleanup(dataRoot, exportRoot); }
});

test("schema v1 upgrades preserve legacy rows and refuse to migrate while another writer is active", async () => {
  const { dataRoot, exportRoot } = await roots(); const osintRoot = path.join(dataRoot, "osint"); await fs.mkdir(osintRoot); const databasePath = path.join(osintRoot, "osint.db");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec("PRAGMA journal_mode=WAL; CREATE TABLE osint_schema_v1(singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL, migrated_at TEXT NOT NULL); INSERT INTO osint_schema_v1 VALUES(1,1,'2026-07-28T00:00:00.000Z'); CREATE TABLE legacy_gate5_sentinel(value TEXT NOT NULL); INSERT INTO legacy_gate5_sentinel VALUES('preserve-me'); BEGIN IMMEDIATE; INSERT INTO legacy_gate5_sentinel VALUES('uncommitted');");
  let store: OsintStore | null = null;
  try {
    store = new OsintStore({ dataRoot, mode: "synthetic", now: () => NOW, minimumFreeBytes: 0, writeGuard: async () => ({}) });
    await assert.rejects(store.initialize(), (error: unknown) => error instanceof OsintStoreError && error.code === "VALIDATION_FAILED" && /active writes/.test(error.message));
    legacy.exec("ROLLBACK"); legacy.close();
    const migrated = await store.initialize(); assert.equal(migrated.schemaVersion, 3); assert.equal(migrated.backupCreated, true); assert.equal(migrated.consistency.valid, true);
    const read = new DatabaseSync(databasePath, { readOnly: true }); try { assert.deepEqual((read.prepare("SELECT value FROM legacy_gate5_sentinel ORDER BY value").all() as Array<{ value: string }>).map(({ value }) => value), ["preserve-me"]); } finally { read.close(); }
    const backupName = (await fs.readdir(store.backupRoot)).find((name) => name.startsWith("pre-migration-")); assert.ok(backupName);
    const backup = new DatabaseSync(path.join(store.backupRoot, backupName), { readOnly: true }); try { assert.equal(Object.values((backup.prepare("PRAGMA quick_check(1)").get() ?? {}) as Record<string, unknown>)[0], "ok"); assert.deepEqual((backup.prepare("SELECT value FROM legacy_gate5_sentinel").all() as Array<{ value: string }>).map(({ value }) => value), ["preserve-me"]); } finally { backup.close(); }
  } finally { try { legacy.close(); } catch { /* already closed */ } store?.close(); await cleanup(dataRoot, exportRoot); }
});

test("a complete investigation graph persists transactionally with bounded, credential-redacted raw evidence", async () => {
  const { dataRoot, exportRoot } = await roots(); const guards: number[] = [];
  try {
    const { store } = await setup(dataRoot, guards); const result = await fixture(); const evidenceId = result.correlation.evidence[0].id;
    const saved = await store.saveInvestigationBundle(result, { rawResponses: [{ evidenceId, headers: { Authorization: "Bearer super-secret", "X-Api-Key": "abc123" }, body: { token: "secret-token", url: "https://provider.test/data?api_key=secret&safe=yes", content: "x".repeat(400_000) } }] });
    assert.equal(saved.investigationId, result.investigation.id); assert.ok(guards.length >= 2);
    const graph = store.getInvestigationGraph(result.investigation.id)!; assert.equal(graph.entities.length, 5); assert.equal(graph.evidence.length, 3); assert.equal(graph.observations.length, 6); assert.equal(graph.claims.length, 12); assert.equal(graph.conclusions.length, graph.claims.length); assert.ok(graph.identityLinks.length >= 1); assert.equal(graph.changes.length, 0); assert.equal(graph.relationships.length, 4); assert.equal(graph.leads.length, 3);
    const rawRow = graph.evidence.find((row) => String((row as Record<string, unknown>).id) === evidenceId) as Record<string, unknown>;
    const rawText = String(rawRow.raw_response_json); assert.equal(rawRow.raw_truncated, 1); assert.ok(Number(rawRow.raw_response_bytes) <= 256 * 1024); assert.match(rawText, /REDACTED/); assert.doesNotMatch(rawText, /super-secret|abc123|secret-token|api_key=secret/);
    assert.equal(store.checkConsistency().valid, true); store.close();
  } finally { await cleanup(dataRoot, exportRoot); }
});

test("provider cache exposes age, expiry, and provenance while every state/log write passes the budget guard", async () => {
  const { dataRoot, exportRoot } = await roots(); const guards: number[] = [];
  let store: OsintStore | null = null;
  try {
    ({ store } = await setup(dataRoot, guards)); const before = guards.length;
    await store.putProviderCache({ cacheKey: "dns:example", providerId: "provider.fixture", queryId: "query-1", storedAt: new Date(NOW - 60_000).toISOString(), expiresAt: new Date(NOW + 60_000).toISOString(), sourceRetrievedAt: new Date(NOW - 65_000).toISOString(), result: { answer: "safe", apiKey: "never-store" }, provenance: { provider: "Fixture", sourceRefs: ["https://provider.test/result?token=never-store"] } });
    await store.putRateLimitState({ providerId: "provider.fixture", windowStartedAt: new Date(NOW - 1_000).toISOString(), used: 1, limit: 5, resetAt: new Date(NOW + 60_000).toISOString(), updatedAt: new Date(NOW).toISOString() });
    await store.appendInvocationLog({ action: "provider.query", status: "completed", startedAt: new Date(NOW).toISOString(), metadata: { Authorization: "Bearer private", nested: { password: "private" } } });
    await store.appendDecisionLog({ decisionType: "policy", decisionId: "decision-1", outcome: "allow", createdAt: new Date(NOW).toISOString(), detail: { access_token: "private" } });
    assert.equal(guards.length - before, 4);
    const cached = store.getProviderCache("dns:example")!; assert.equal(cached.ageMs, 60_000); assert.equal(cached.expired, false); assert.equal(cached.provenance.provider, "Fixture"); assert.equal(cached.result.apiKey, "[REDACTED]"); assert.doesNotMatch(JSON.stringify(cached), /never-store/);
    const invocationExport = await store.exportScope("invocation-logs", exportRoot); const invocationText = await fs.readFile(invocationExport.path, "utf8"); assert.match(invocationText, /REDACTED/); assert.doesNotMatch(invocationText, /Bearer private/);
  } finally { store?.close(); await cleanup(dataRoot, exportRoot); }
});

test("typed cleanup exports first, deletes transactionally, and cannot touch shared chat, memory, RAG, or Hunter data", async () => {
  const { dataRoot, exportRoot } = await roots(); const guards: number[] = [];
  let store: OsintStore | null = null;
  try {
    const setupResult = await setup(dataRoot, guards); store = setupResult.store; const { sharedDatabase } = setupResult; const result = await fixture(); await store.saveInvestigationBundle(result);
    await fs.mkdir(path.join(dataRoot, "hunter"), { recursive: true }); await fs.writeFile(path.join(dataRoot, "hunter", "history-sentinel.txt"), "hunter-safe"); await fs.mkdir(path.join(dataRoot, "rag"), { recursive: true }); await fs.writeFile(path.join(dataRoot, "rag", "vector-sentinel.bin"), "rag-safe");
    await assert.rejects(store.clearScope({ scope: "investigation", investigationId: result.investigation.id, exportDirectory: dataRoot }), (error: unknown) => error instanceof OsintStoreError && error.code === "UNSAFE_PATH");
    const cleared = await store.clearScope({ scope: "investigation", investigationId: result.investigation.id, exportDirectory: exportRoot }); assert.equal(cleared.changes, 1); assert.equal(cleared.consistency.valid, true); assert.equal(store.getInvestigationGraph(result.investigation.id), null); assert.ok((await fs.stat(cleared.exported.path)).size > 0);
    const shared = new DatabaseSync(sharedDatabase, { readOnly: true }); try { const row = shared.prepare("SELECT * FROM conversations").get() as Record<string, unknown>; assert.equal(row.id, "chat-safe"); assert.equal(row.title, "must-survive"); } finally { shared.close(); }
    assert.equal(await fs.readFile(path.join(dataRoot, "hunter", "history-sentinel.txt"), "utf8"), "hunter-safe"); assert.equal(await fs.readFile(path.join(dataRoot, "rag", "vector-sentinel.bin"), "utf8"), "rag-safe");
  } finally { store?.close(); await cleanup(dataRoot, exportRoot); }
});

test("dry-run eviction is inert; bounded eviction exports candidates and leaves a consistent database", async () => {
  const { dataRoot, exportRoot } = await roots(); const guards: number[] = [];
  try {
    const { store } = await setup(dataRoot, guards); const first = await fixture("example.com"); const second = await fixture("example.net"); await store.saveInvestigationBundle(first); await store.saveInvestigationBundle(second);
    const dryRun = store.dryRunEviction(1); assert.equal(dryRun.dryRun, true); assert.equal(dryRun.candidates.length, 1); assert.ok(store.getInvestigationGraph(first.investigation.id)); assert.ok(store.getInvestigationGraph(second.investigation.id));
    const evicted = await store.evict({ targetBytes: 1, exportDirectory: exportRoot }); assert.equal(evicted.completed.length, 1); assert.equal(evicted.consistency.valid, true); const survivors = [first, second].filter((item) => store.getInvestigationGraph(item.investigation.id)); assert.equal(survivors.length, 1);
    assert.ok((await fs.readdir(exportRoot)).some((name) => name.includes("investigation"))); store.close();
  } finally { await cleanup(dataRoot, exportRoot); }
});

test("migration backup recovery rejects corruption and cancellation never partially clears", async () => {
  const { dataRoot, exportRoot } = await roots(); const osintRoot = path.join(dataRoot, "osint"); await fs.mkdir(osintRoot); const legacyPath = path.join(osintRoot, "osint.db");
  const legacy = new DatabaseSync(legacyPath); legacy.exec("CREATE TABLE recovery_seed(value TEXT); INSERT INTO recovery_seed VALUES('valid');"); legacy.close(); const guards: number[] = [];
  let corrupt: OsintStore | null = null;
  try {
    const sharedPath = path.join(dataRoot, "voidcat.db"); const shared = new DatabaseSync(sharedPath); shared.exec("CREATE TABLE messages(id TEXT PRIMARY KEY, content TEXT); INSERT INTO messages VALUES('message-safe','untouched');"); shared.close();
    const budgets = new VoidCatStorageBudgetManager({ dataRoot, databasePath: sharedPath }); const writeGuard = async (size: number, signal?: AbortSignal) => { guards.push(size); return budgets.ensureWriteAllowed("osint-investigations", size, signal); };
    const store = new OsintStore({ dataRoot, mode: "synthetic", now: () => NOW, minimumFreeBytes: 0, writeGuard }); await store.initialize(); const backup = path.join(store.backupRoot, (await fs.readdir(store.backupRoot))[0]); const result = await fixture(); await store.saveInvestigationBundle(result);
    const controller = new AbortController(); controller.abort(); await assert.rejects(store.clearScope({ scope: "investigation", investigationId: result.investigation.id, exportDirectory: exportRoot, signal: controller.signal }), (error: unknown) => error instanceof OsintStoreError && error.code === "CANCELLED"); assert.ok(store.getInvestigationGraph(result.investigation.id));
    store.close(); await fs.writeFile(legacyPath, "not a sqlite database");
    corrupt = new OsintStore({ dataRoot, mode: "synthetic", now: () => NOW, minimumFreeBytes: 0, writeGuard }); await assert.rejects(corrupt.initialize(), (error: unknown) => error instanceof OsintStoreError && error.code === "CORRUPT_DATABASE");
    const recovered = await corrupt.recoverFromBackup(backup); assert.equal(recovered.consistency.valid, true); corrupt.close();
    const finalShared = new DatabaseSync(sharedPath, { readOnly: true }); try { const row = finalShared.prepare("SELECT * FROM messages").get() as Record<string, unknown>; assert.equal(row.id, "message-safe"); assert.equal(row.content, "untouched"); } finally { finalShared.close(); }
  } finally { corrupt?.close(); await cleanup(dataRoot, exportRoot); }
});

test("redaction and raw-response bounds are deterministic and fail closed for unsafe synthetic paths", async () => {
  const first = boundAndRedactRawResponse({ authorization: "secret", nested: { password: "secret" }, body: "z".repeat(400_000) }); const second = boundAndRedactRawResponse({ authorization: "secret", nested: { password: "secret" }, body: "z".repeat(400_000) });
  assert.deepEqual(first, second); assert.equal(first.truncated, true); assert.ok(first.storedBytes <= 256 * 1024); assert.doesNotMatch(JSON.stringify(first), /"secret"/);
  const unsafe = await fs.mkdtemp(path.join(os.tmpdir(), "wrong-osint-prefix-"));
  try { assert.throws(() => new OsintStore({ dataRoot: unsafe, mode: "synthetic", minimumFreeBytes: 0, writeGuard: async () => ({}) }), (error: unknown) => error instanceof OsintStoreError && error.code === "UNSAFE_PATH"); }
  finally { await fs.rm(unsafe, { recursive: true, force: true }); }
});
