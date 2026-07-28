import assert from "node:assert/strict";
import test from "node:test";
import {
  SourceAdapterHttpError,
  type NormalizedObservation,
  type SourceAdapter,
  type SourceDescriptor,
} from "../build/hunter-seeker/source-adapter.ts";
import { InMemoryObservationStore, SourceRegistry } from "../build/hunter-seeker/source-registry.ts";

function descriptor(id: string, overrides: Partial<SourceDescriptor> = {}): SourceDescriptor {
  return {
    id,
    displayName: id,
    category: "seismic",
    authTier: "tier-1",
    credentialType: "none",
    pollCadenceMs: 60_000,
    rateLimit: { requestsPerWindow: 2, windowMs: 10_000, hardHourlyBudget: 10 },
    providerDocsUrl: "https://example.test/docs",
    cache: { ttlMs: 30_000, maxObservations: 10 },
    retentionPolicy: { mode: "live-only" },
    estimatedBytesPerDay: 100_000,
    ...overrides,
  };
}

function observation(sourceId: string, id: string, overrides: Partial<NormalizedObservation> = {}): NormalizedObservation {
  const timestamp = "2026-07-27T12:00:00.000Z";
  return {
    observationId: id,
    entityId: `entity:${id}`,
    entityType: "test-event",
    position: { latitude: 40, longitude: -90 },
    timestamp,
    provenance: { sourceFeedId: sourceId, fetchedAt: timestamp, receivedAt: timestamp, upstreamTimestamp: timestamp, stalenessMs: 0 },
    confidence: 0.9,
    basis: "measured",
    retentionClass: "bulk",
    attributes: { label: id },
    rawPayload: { id },
    ...overrides,
  };
}

test("adapter lifecycle validates, stores, publishes, expires, and drops raw payloads", async () => {
  let currentTime = Date.parse("2026-07-27T12:00:00.000Z");
  const now = () => currentTime;
  const sourceId = "test.lifecycle";
  const adapter: SourceAdapter<string> = {
    descriptor: descriptor(sourceId),
    async fetch() { return "raw"; },
    normalize() {
      return [observation(sourceId, "valid"), observation(sourceId, "invalid", { position: { latitude: 120, longitude: 0 } })];
    },
    health() { return { status: "healthy" }; },
  };
  const registry = new SourceRegistry({ now, store: new InMemoryObservationStore(now) });
  const published: string[] = [];
  registry.subscribe(() => { throw new Error("subscriber failure"); });
  registry.subscribe((_id, observations) => published.push(...observations.map(({ observationId }) => observationId)));
  registry.register(adapter);

  const result = await registry.refresh(sourceId);
  assert.deepEqual(result, { sourceId, status: "published", observations: 1, rejected: 1 });
  assert.deepEqual(published, ["valid"]);
  assert.equal((await registry.observations(sourceId)).length, 1);
  assert.equal((await registry.health(sourceId)).status, "degraded");
  assert.equal(await registry.dropRawPayloads(sourceId), 1);
  assert.equal((await registry.observations(sourceId))[0].rawPayload, undefined);

  currentTime += 30_001;
  assert.equal((await registry.observations(sourceId)).length, 0);
});

test("rate budgets and retryable failures isolate one source from the others", async () => {
  const currentTime = Date.parse("2026-07-27T12:00:00.000Z");
  const now = () => currentTime;
  const registry = new SourceRegistry({ now, random: () => 0.5, backoffBaseMs: 1_000 });
  const goodId = "test.good";
  const badId = "test.bad";
  registry.register({
    descriptor: descriptor(goodId, { rateLimit: { requestsPerWindow: 1, windowMs: 10_000, hardHourlyBudget: 2 } }),
    async fetch() { return {}; },
    normalize() { return [observation(goodId, "one")]; },
    health() { return { status: "healthy" }; },
  });
  registry.register({
    descriptor: descriptor(badId),
    async fetch() { throw new SourceAdapterHttpError("upstream unavailable", 503); },
    normalize() { return []; },
    health() { return { status: "down" }; },
  });

  const results = await registry.refreshAll();
  assert.equal(results.find(({ sourceId }) => sourceId === goodId)?.status, "published");
  assert.equal(results.find(({ sourceId }) => sourceId === badId)?.status, "failed");
  assert.equal((await registry.observations(goodId)).length, 1);
  assert.equal((await registry.health(badId)).nextAllowedAt, "2026-07-27T12:00:01.000Z");

  const limited = await registry.refresh(goodId);
  assert.equal(limited.status, "skipped");
  assert.equal(limited.reason, "rate-limited");

  const manualOverride = await registry.refresh(goodId, { manual: true });
  assert.equal(manualOverride.status, "published");

  const hardLimited = await registry.refresh(goodId, { manual: true });
  assert.equal(hardLimited.status, "skipped");
  assert.equal(hardLimited.reason, "rate-limited");
});

test("the live-only store refuses to imply persistent retention", () => {
  const registry = new SourceRegistry();
  const adapter: SourceAdapter = {
    descriptor: descriptor("test.persist", { retentionPolicy: { mode: "persistent", maxAgeMs: 60_000 } }),
    async fetch() { return {}; },
    normalize() { return []; },
    health() { return { status: "healthy" }; },
  };
  assert.throws(() => registry.register(adapter), /budget-managed observation store/i);
});

test("source controls enforce enable state and bounded per-source pull rates", async () => {
  const sourceId = "test.controls";
  const registry = new SourceRegistry();
  registry.register({
    descriptor: descriptor(sourceId),
    async fetch() { return {}; },
    normalize() { return [observation(sourceId, "controlled")]; },
    health() { return { status: "healthy" }; },
  });

  assert.equal((await registry.health(sourceId)).pollCadenceMs, 60_000);
  assert.equal(registry.setPollCadence(sourceId, 2 * 60_000), 2 * 60_000);
  assert.equal((await registry.health(sourceId)).pollCadenceMs, 2 * 60_000);
  assert.throws(() => registry.setPollCadence(sourceId, 29_999), /30 seconds and 12 hours/i);
  assert.throws(() => registry.setPollCadence(sourceId, 12 * 60 * 60_000 + 1), /30 seconds and 12 hours/i);

  registry.setEnabled(sourceId, false);
  assert.equal((await registry.health(sourceId)).enabled, false);
  assert.equal((await registry.refresh(sourceId)).reason, "disabled");
  registry.setEnabled(sourceId, true);
  assert.equal((await registry.health(sourceId)).enabled, true);
});

test("disabled sources retain their latest snapshot through the selected pull interval", async () => {
  let currentTime = Date.parse("2026-07-27T12:00:00.000Z");
  const now = () => currentTime;
  const sourceId = "test.toggle-cache";
  const registry = new SourceRegistry({ now, store: new InMemoryObservationStore(now) });
  registry.register({
    descriptor: descriptor(sourceId, { cache: { ttlMs: 30_000, maxObservations: 10 } }),
    async fetch() { return {}; },
    normalize() { return [observation(sourceId, "cached")]; },
    health() { return { status: "healthy" }; },
  });

  registry.setPollCadence(sourceId, 12 * 60 * 60_000);
  await registry.refresh(sourceId);
  registry.setEnabled(sourceId, false);
  currentTime += 11 * 60 * 60_000;
  assert.equal((await registry.observations(sourceId)).length, 1);

  registry.setEnabled(sourceId, true);
  assert.equal((await registry.observations(sourceId)).length, 1);
});
