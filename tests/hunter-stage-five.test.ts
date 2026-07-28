import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HunterHistoryStore } from "../build/hunter-seeker/hunter-history-store.ts";
import { HunterReplayManager, HunterStageFiveStore } from "../build/hunter-seeker/hunter-stage-five.ts";
import type { HunterSeekerPublicObservation } from "../build/hunter-seeker/hunter-seeker-service.ts";

function observation(input: { id: string; at: number; entityId?: string; entityType?: string; latitude?: number; longitude?: number; sourceId?: string; attributes?: Record<string, unknown> }): HunterSeekerPublicObservation {
  const timestamp = new Date(input.at).toISOString();
  return { observationId: input.id, entityId: input.entityId ?? `aircraft:${input.id}`, entityType: input.entityType ?? "civil-aircraft", position: { latitude: input.latitude ?? 30, longitude: input.longitude ?? -95, altitudeMeters: 1_000 }, timestamp, provenance: { sourceFeedId: input.sourceId ?? "test.live", fetchedAt: timestamp, receivedAt: timestamp, upstreamTimestamp: timestamp, stalenessMs: 0 }, confidence: 0.95, basis: "measured", retentionClass: "bulk", attributes: input.attributes ?? {} };
}

async function disposableStage() {
  const root = await mkdtemp(path.join(os.tmpdir(), "voidcat-stage-five-test-")); const writes: number[] = [];
  let current = Date.parse("2026-07-28T12:00:00.000Z"); const now = () => current;
  const store = new HunterStageFiveStore({ databasePath: path.join(root, "history.db"), now, ensureWriteAllowed: async (bytes) => { writes.push(bytes); } });
  await store.initialize();
  return { root, store, writes, now, advance: (milliseconds: number) => { current += milliseconds; }, cleanup: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("watchlists persist every identifier type and validate exported imports", async () => {
  const fixture = await disposableStage();
  try {
    for (const [kind, value] of [["aircraft-icao", "A1B2C3"], ["aircraft-callsign", "VOID1"], ["aircraft-tail", "N123VC"], ["vessel-mmsi", "123456789"], ["satellite-norad", "25544"]] as const) await fixture.store.saveWatchlist({ kind, label: kind, value });
    await fixture.store.saveWatchlist({ kind: "geofence", label: "Test area", geometry: { type: "bbox", south: 20, west: 170, north: 40, east: -170 } });
    assert.equal(fixture.store.listWatchlists().length, 6);
    const areaMatch = await fixture.store.evaluate([observation({ id: "antimeridian", at: fixture.now(), latitude: 30, longitude: 175 })]);
    assert.ok(areaMatch.events.some(({ triggerType }) => triggerType === "geofence-entry")); assert.ok(areaMatch.protectedObservationIds.includes("antimeridian"));
    const exported = fixture.store.exportWatchlists(); const tampered = structuredClone(exported); tampered.rules[0].label = "tampered";
    await assert.rejects(fixture.store.importWatchlists(tampered), /checksum validation failed/i);
    fixture.store.close();
    const reopened = new HunterStageFiveStore({ databasePath: path.join(fixture.root, "history.db"), now: fixture.now }); await reopened.initialize(); assert.equal(reopened.listWatchlists().length, 6);
    const cleanRoot = await mkdtemp(path.join(os.tmpdir(), "voidcat-stage-five-import-test-")); const imported = new HunterStageFiveStore({ databasePath: path.join(cleanRoot, "history.db") });
    try { await imported.initialize(); assert.equal((await imported.importWatchlists(exported)).imported, 6); } finally { imported.close(); await rm(cleanRoot, { recursive: true, force: true }); }
    reopened.close();
  } finally { await fixture.cleanup(); }
});

test("every identifier type matches and becomes protected in opt-in history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voidcat-stage-five-protection-test-")); const history = new HunterHistoryStore({ dataRoot: root, minimumFreeBytes: 0 });
  try {
    await history.enable(); const stage = new HunterStageFiveStore({ databasePath: history.databasePath }); await stage.initialize();
    try {
      await stage.saveWatchlist({ kind: "aircraft-icao", label: "ICAO", value: "ABC123" });
      await stage.saveWatchlist({ kind: "aircraft-callsign", label: "Callsign", value: "VOID7" });
      await stage.saveWatchlist({ kind: "aircraft-tail", label: "Tail", value: "N700VC" });
      await stage.saveWatchlist({ kind: "vessel-mmsi", label: "MMSI", value: "123456789" });
      await stage.saveWatchlist({ kind: "satellite-norad", label: "NORAD", value: "25544" });
      const at = Date.now(); const observations = [
        observation({ id: "icao", at, entityId: "aircraft:ABC123", attributes: { transponderHex: "abc123" } }),
        observation({ id: "callsign", at, entityId: "aircraft:CALL", attributes: { callsign: "VOID 7" } }),
        observation({ id: "tail", at, entityId: "aircraft:TAIL", attributes: { registration: "N700VC" } }),
        observation({ id: "mmsi", at, entityId: "vessel:123456789", entityType: "maritime-vessel", attributes: { mmsi: "123456789" } }),
        observation({ id: "norad", at, entityId: "space-station:25544", entityType: "space-station", attributes: { noradCatalogId: "25544" } }),
      ];
      await history.ingest(observations); const evaluated = await stage.evaluate(observations);
      assert.equal(evaluated.events.filter(({ triggerType }) => triggerType === "watchlist-match").length, 5);
      assert.deepEqual(new Set(evaluated.protectedObservationIds), new Set(observations.map(({ observationId }) => observationId)));
      for (const observationValue of observations) assert.equal(history.protectObservation(observationValue.observationId, "trigger").updated, 1);
      for (const observationValue of observations) assert.equal(history.query({ entityId: observationValue.entityId })[0].retentionClass, "protected");
    } finally { stage.close(); }
  } finally { history.close(); await rm(root, { recursive: true, force: true }); }
});

test("watchlist, geofence, emergency, loiter, and reappearance triggers deduplicate and protect evidence", async () => {
  const fixture = await disposableStage();
  try {
    await fixture.store.saveWatchlist({ kind: "aircraft-callsign", label: "Priority aircraft", value: "VOID1" });
    await fixture.store.saveWatchlist({ kind: "geofence", label: "Coastal zone", geometry: { type: "circle", latitude: 30, longitude: -95, radiusKm: 25 } });
    const first = observation({ id: "first", at: fixture.now(), entityId: "aircraft:A1B2C3", attributes: { callsign: "VOID1", squawk: "7700" } });
    const initial = await fixture.store.evaluate([first]);
    assert.deepEqual(new Set(initial.events.map(({ triggerType }) => triggerType)), new Set(["watchlist-match", "geofence-entry", "emergency-squawk"])); assert.deepEqual(initial.protectedObservationIds, ["first"]);
    assert.equal((await fixture.store.evaluate([first])).events.length, 0, "identical observations must deduplicate");
    fixture.advance(11 * 60_000);
    const loitered = observation({ id: "loitered", at: fixture.now(), entityId: first.entityId, attributes: { callsign: "VOID1" } }); const loiterResult = await fixture.store.evaluate([loitered]);
    assert.ok(loiterResult.events.some(({ triggerType }) => triggerType === "loiter")); assert.ok(loiterResult.protectedObservationIds.includes("loitered"));
    fixture.advance(1_000);
    const outside = observation({ id: "outside", at: fixture.now(), entityId: first.entityId, latitude: 42, longitude: -70, attributes: { callsign: "VOID1" } }); assert.ok((await fixture.store.evaluate([outside])).events.some(({ triggerType }) => triggerType === "geofence-exit"));
    fixture.advance(31 * 60_000);
    const returned = observation({ id: "returned", at: fixture.now(), entityId: first.entityId, latitude: 43, longitude: -69 }); assert.ok((await fixture.store.evaluate([returned])).events.some(({ triggerType }) => triggerType === "reappearance"));
    assert.ok(fixture.writes.every((bytes) => bytes > 0));
  } finally { await fixture.cleanup(); }
});

test("trigger engine enforces the global hourly notification ceiling", async () => {
  const fixture = await disposableStage();
  try {
    const contacts = Array.from({ length: 45 }, (_, index) => observation({ id: `emergency-${index}`, at: fixture.now(), entityId: `aircraft:${index}`, attributes: { squawk: "7700" } }));
    const result = await fixture.store.evaluate(contacts); assert.equal(result.events.length, 30); assert.equal(fixture.store.listTriggers(100).length, 30);
  } finally { await fixture.cleanup(); }
});

test("geofence management has a hard evaluation ceiling", async () => {
  const fixture = await disposableStage();
  try {
    for (let index = 0; index < 20; index += 1) await fixture.store.saveWatchlist({ kind: "geofence", label: `Area ${index}`, geometry: { type: "circle", latitude: index, longitude: 0, radiusKm: 5 } });
    await assert.rejects(fixture.store.saveWatchlist({ kind: "geofence", label: "Area 21", geometry: { type: "circle", latitude: 30, longitude: 0, radiusKm: 5 } }), /limited to 20/i);
  } finally { await fixture.cleanup(); }
});

test("advanced feed health history persists bounded metrics and AI eligibility", async () => {
  const fixture = await disposableStage();
  try {
    const sample = { sourceId: "test.feed", at: new Date(fixture.now()).toISOString(), status: "degraded", errorRate: 0.75, recordsPerHour: 0, expectedBaseline: 24, silentZero: true, aiContextEligible: false, message: "Silent zero detected." };
    assert.equal((await fixture.store.recordHealth([sample])).recorded, 1); assert.equal((await fixture.store.recordHealth([sample])).recorded, 0);
    const [saved] = fixture.store.healthHistory("test.feed"); assert.equal(saved.errorRate, 0.75); assert.equal(saved.expectedBaseline, 24); assert.equal(saved.silentZero, true); assert.equal(saved.aiContextEligible, false);
    fixture.advance(31 * 24 * 60 * 60_000);
    const currentSample = { ...sample, at: new Date(fixture.now()).toISOString(), status: "healthy", errorRate: 0, recordsPerHour: 30, silentZero: false, aiContextEligible: true };
    assert.equal((await fixture.store.recordHealth([currentSample])).recorded, 1); assert.equal(fixture.store.healthHistory("test.feed").length, 1, "health history must prune samples older than 30 days");
  } finally { await fixture.cleanup(); }
});

test("bounded JSONL replay is checksummed, budget-accounted, deterministic, and consumes no API calls", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voidcat-replay-test-")); const writes: number[] = []; const manager = new HunterReplayManager({ replayRoot: root, ensureWriteAllowed: async (bytes) => { writes.push(bytes); } });
  try {
    const active = await manager.start({ label: "Deterministic window", durationMs: 60_000, sourceIds: ["test.live"] }); const expected = [observation({ id: "replay-1", at: Date.now() }), observation({ id: "replay-2", at: Date.now() + 1 })];
    assert.equal((await manager.capture(expected)).captured, 2); const manifest = await manager.stop(); assert.equal(manifest?.status, "complete"); assert.equal(manifest?.recordCount, 2); assert.match(manifest?.checksum ?? "", /^[0-9a-f]{64}$/);
    const loaded = await manager.load(active.id); assert.equal(loaded.offline, true); assert.equal(loaded.apiCallsConsumed, 0); assert.deepEqual(loaded.observations, expected); assert.deepEqual((await manager.load(active.id)).observations, loaded.observations);
    assert.deepEqual((await readdir(root)).sort(), [`${active.id}.jsonl`, `${active.id}.manifest.json`].sort()); assert.ok(writes.length >= 2 && writes.every((bytes) => bytes > 0));
  } finally { await manager.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("interrupted replay manifests recover as cancelled and cannot be played", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voidcat-replay-recovery-test-")); const manager = new HunterReplayManager({ replayRoot: root });
  const id = "11111111-1111-4111-8111-111111111111"; const now = new Date().toISOString();
  try {
    await writeFile(path.join(root, `${id}.manifest.json`), JSON.stringify({ format: "voidcat-hunter-replay", version: 1, id, label: "Interrupted", createdAt: now, endsAt: now, completedAt: null, sourceIds: [], recordCount: 0, bytes: 0, status: "recording", checksum: null }), "utf8");
    assert.equal((await manager.list())[0].status, "cancelled");
    assert.equal(JSON.parse(await readFile(path.join(root, `${id}.manifest.json`), "utf8")).status, "cancelled");
    await assert.rejects(manager.load(id), /unavailable or incomplete/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
