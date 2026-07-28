import assert from "node:assert/strict";
import test from "node:test";
import { observationFreshnessState, sourceCacheTtlMs, sourceFreshnessState, type HunterFreshnessSource } from "../app/hunter-seeker-freshness.ts";
import type { HunterSeekerObservation } from "../app/hunter-seeker-map-data.ts";

const NOW = Date.parse("2026-07-27T12:10:00.000Z");

function source(overrides: Partial<HunterFreshnessSource["health"]> = {}): HunterFreshnessSource {
  return {
    descriptor: { id: "test.feed", pollCadenceMs: 60_000, cache: { ttlMs: 5 * 60_000 } },
    health: {
      status: "healthy",
      enabled: true,
      pollCadenceMs: 60_000,
      lastSuccessAt: "2026-07-27T12:09:30.000Z",
      cachedObservations: 1,
      ...overrides,
    },
  };
}

function observation(entityType: string, stalenessMs: number): HunterSeekerObservation {
  return {
    observationId: `test:${entityType}`,
    entityId: `entity:${entityType}`,
    entityType,
    position: { latitude: 35, longitude: -90 },
    timestamp: "2026-07-20T12:00:00.000Z",
    provenance: { sourceFeedId: "test.feed", fetchedAt: "2026-07-27T12:09:30.000Z", receivedAt: "2026-07-27T12:09:30.000Z", stalenessMs },
    confidence: 0.9,
    basis: "measured",
    retentionClass: "bulk",
    attributes: {},
  };
}

test("source freshness distinguishes live, cached, stale, degraded, acquiring, and offline states", () => {
  assert.equal(sourceFreshnessState(source(), NOW), "live");
  assert.equal(sourceFreshnessState(source({ status: "rate-limited" }), NOW), "cached");
  assert.equal(sourceFreshnessState(source({ lastSuccessAt: "2026-07-27T12:08:00.000Z" }), NOW), "cached");
  assert.equal(sourceFreshnessState(source({ lastSuccessAt: "2026-07-27T12:00:00.000Z" }), NOW), "stale");
  assert.equal(sourceFreshnessState(source({ status: "degraded" }), NOW), "degraded");
  assert.equal(sourceFreshnessState(source({ lastSuccessAt: undefined }), NOW), "acquiring");
  assert.equal(sourceFreshnessState(source({ enabled: false }), NOW), "offline");
});

test("selected pull cadence extends the freshness envelope for deliberately slow sources", () => {
  const slow = source({ pollCadenceMs: 12 * 60 * 60_000 });
  slow.descriptor.pollCadenceMs = slow.health.pollCadenceMs;
  assert.equal(sourceCacheTtlMs(slow), 24 * 60 * 60_000);
});

test("observation freshness treats event time separately from moving-contact staleness", () => {
  assert.equal(observationFreshnessState(observation("earthquake", 7 * 24 * 60 * 60_000), source(), NOW), "live");
  assert.equal(observationFreshnessState(observation("civilian-aircraft", 26 * 60_000), source(), NOW), "stale");
  assert.equal(observationFreshnessState(observation("space-station", 24 * 60 * 60_000), source(), NOW), "cached");
  assert.equal(observationFreshnessState(observation("space-station", 8 * 24 * 60 * 60_000), source(), NOW), "stale");
});
