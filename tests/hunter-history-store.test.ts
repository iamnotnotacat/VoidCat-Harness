/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HunterHistoryStore } from "../build/hunter-seeker/hunter-history-store.ts";
import type { HunterSeekerPublicObservation } from "../build/hunter-seeker/hunter-seeker-service.ts";

const DAY = 86_400_000;

function observation(id: string, at: number, latitude: number, longitude: number, entityId = "entity-1"): HunterSeekerPublicObservation {
  const timestamp = new Date(at).toISOString();
  return {
    observationId: id, entityId, entityType: "civil-aircraft", position: { latitude, longitude, altitudeMeters: 1_000 }, timestamp,
    provenance: { sourceFeedId: "test.air", fetchedAt: timestamp, receivedAt: timestamp, upstreamTimestamp: timestamp, stalenessMs: 0 },
    confidence: 0.95, basis: "measured", retentionClass: "bulk", attributes: { callsign: "TEST1" },
  };
}

async function disposableStore(now = Date.now()) {
  const root = await mkdtemp(path.join(os.tmpdir(), "voidcat-history-test-"));
  const writes: number[] = [];
  const store = new HunterHistoryStore({ dataRoot: root, now: () => now, minimumFreeBytes: 0, ensureWriteAllowed: async (bytes) => { writes.push(bytes); } });
  return { root, store, writes, cleanup: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("history is opt-in and initializes an isolated validated database only when enabled", async () => {
  const fixture = await disposableStore();
  try {
    await assert.rejects(stat(fixture.store.databasePath));
    const before = await fixture.store.ingest([observation("a", Date.now(), 1, 2)]);
    assert.equal(before.persisted, false);
    await fixture.store.enable();
    assert.ok((await stat(fixture.store.databasePath)).size > 0);
    const status = await fixture.store.status();
    assert.equal(status.enabled, true); assert.equal(status.initialized, true);
  } finally { await fixture.cleanup(); }
});

test("paused history reopens readably without resuming writes", async () => {
  const now = Date.now(); const fixture = await disposableStore(now);
  try {
    await fixture.store.enable(); await fixture.store.ingest([observation("saved", now, 1, 2)]); fixture.store.close();
    const reopened = new HunterHistoryStore({ dataRoot: fixture.root, minimumFreeBytes: 0 });
    await reopened.openExisting();
    assert.equal(reopened.isEnabled(), false); assert.equal(reopened.isInitialized(), true);
    assert.equal(reopened.query({ entityId: "entity-1" })[0].observationId, "saved");
    const ignored = await reopened.ingest([observation("not-written", now + 1, 2, 3)]);
    assert.equal(ignored.persisted, false); reopened.close();
  } finally { await fixture.cleanup(); }
});

test("entity, bounding-box, source, and time-window history queries preserve provenance", async () => {
  const now = Date.now(); const fixture = await disposableStore(now);
  try {
    await fixture.store.enable();
    const inserted = await fixture.store.ingest([
      observation("a", now - 20_000, 30, -95), observation("b", now - 10_000, 31, -94), observation("c", now, -10, 120, "entity-2"),
    ]);
    assert.equal(inserted.accepted, 3); assert.ok(fixture.writes[0] > 0);
    const results = fixture.store.query({ entityId: "entity-1", sourceIds: ["test.air"], bbox: { west: -100, south: 20, east: -90, north: 40 }, startAt: new Date(now - 30_000).toISOString(), endAt: new Date(now).toISOString() });
    assert.equal(results.length, 2); assert.equal(results[0].historical, true); assert.equal(results[0].provenance.sourceFeedId, "test.air");
  } finally { await fixture.cleanup(); }
});

test("historical RAG indexes only summary/derived records and transactional deletion leaves no orphans", async () => {
  const now = Date.now(); const fixture = await disposableStore(now);
  try {
    await fixture.store.enable();
    const derived = await fixture.store.createDerivedEvent({ title: "Route changed", content: "The route shifted east.", windowStart: new Date(now - DAY).toISOString(), windowEnd: new Date(now).toISOString(), sourceFeedIds: ["test.air"], sourceObservationIds: ["obs-1"] });
    const pending = fixture.store.listPendingRagRecords();
    assert.deepEqual(pending.map(({ id }) => id), [derived.id]);
    await fixture.store.indexRagRecords([{ id: derived.id, embedding: [1, 0.2, -0.1, 0.4] }]);
    assert.equal(fixture.store.search([1, 0.2, -0.1, 0.4])[0].id, derived.id);
    const deletion = fixture.store.deleteRagRecord(derived.id);
    assert.equal(deletion.deleted, 1); assert.equal(deletion.consistency.valid, true);
  } finally { await fixture.cleanup(); }
});

test("what-changed summaries compare retained observations without embedding raw positions", async () => {
  const now = Date.now(); const fixture = await disposableStore(now);
  try {
    await fixture.store.enable();
    await fixture.store.ingest([observation("change-1", now - 60_000, 10, 20), observation("change-2", now, 11, 22)]);
    const refreshed = await fixture.store.refreshRollingSummaries();
    assert.equal(refreshed.summaries, 1);
    const pending = fixture.store.listPendingRagRecords();
    assert.equal(pending.length, 1); assert.equal(pending[0].recordType, "summary");
    assert.match(pending[0].content, /earliest retained position/i);
    assert.deepEqual(pending[0].sourceObservationIds.sort(), ["change-1", "change-2"]);
  } finally { await fixture.cleanup(); }
});

test("progressive downsampling protects pinned records, creates summaries, validates backup, and never vacuums", async () => {
  const now = Date.now(); const fixture = await disposableStore(now);
  try {
    await fixture.store.enable();
    await fixture.store.ingest([
      observation("old-1", now - 8 * DAY, 30, -95), observation("old-2", now - 8 * DAY + 1_000, 30.1, -94.9), observation("old-3", now - 8 * DAY + 2_000, 30.2, -94.8),
    ]);
    fixture.store.protectObservation("old-1", "pinned");
    const plan = fixture.store.planMaintenance(90);
    assert.equal(plan.mutatesData, false); assert.equal(plan.protectedRecords, 1); assert.ok(plan.estimatedRecordsRemoved >= 2);
    const result = await fixture.store.runMaintenance(90, { maximumGroups: 10 });
    assert.ok(result.deleted >= 1); assert.ok(result.summaries >= 1); assert.equal(result.consistency.valid, true); assert.equal(result.vacuumUsed, false);
    assert.equal(fixture.store.query({ entityId: "entity-1", limit: 20 }).some(({ observationId }) => observationId === "old-1"), true);
    assert.ok(fixture.store.listPendingRagRecords().some(({ recordType }) => recordType === "summary"));
    assert.ok((await stat(result.backupPath)).size > 0);
  } finally { await fixture.cleanup(); }
});

test("maintenance observes hard cancellation before any backup or mutation", async () => {
  const fixture = await disposableStore();
  try {
    await fixture.store.enable(); const controller = new AbortController(); controller.abort();
    await assert.rejects(fixture.store.runMaintenance(90, { signal: controller.signal }), /cancelled safely/i);
  } finally { await fixture.cleanup(); }
});
