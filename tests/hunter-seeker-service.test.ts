/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { NormalizedObservation, SourceAdapter } from "../build/hunter-seeker/source-adapter.ts";
import { HunterSeekerService } from "../build/hunter-seeker/hunter-seeker-service.ts";

const observation: NormalizedObservation = {
  observationId: "test:one",
  entityId: "test:one",
  entityType: "seismic-event",
  position: { latitude: 35, longitude: -90, altitudeMeters: -5_000 },
  timestamp: "2026-07-27T12:00:00.000Z",
  provenance: {
    sourceFeedId: "test.seismic",
    fetchedAt: "2026-07-27T12:00:01.000Z",
    receivedAt: "2026-07-27T12:00:01.000Z",
    upstreamTimestamp: "2026-07-27T12:00:00.000Z",
    stalenessMs: 1_000,
  },
  confidence: 0.9,
  basis: "measured",
  retentionClass: "bulk",
  attributes: { magnitude: 3.2, place: "Test event" },
  rawPayload: { shouldNotReachTheInterface: true },
};

const adapter: SourceAdapter<{ events: NormalizedObservation[] }> = {
  descriptor: {
    id: "test.seismic",
    displayName: "Test Seismic Feed",
    category: "seismic",
    authTier: "tier-1",
    credentialType: "none",
    pollCadenceMs: 60_000,
    rateLimit: { requestsPerWindow: 1, windowMs: 55_000, hardHourlyBudget: 60 },
    providerDocsUrl: "https://example.test/docs",
    cache: { ttlMs: 300_000, maxObservations: 100 },
    retentionPolicy: { mode: "live-only" },
    estimatedBytesPerDay: 1_000,
  },
  async fetch() { return { events: [observation] }; },
  normalize(payload) { return payload.events; },
  health() { return { status: "healthy" }; },
};

test("Hunter-Seeker service exposes live observations without raw payload persistence", async () => {
  const service = new HunterSeekerService([adapter]);
  try {
    const started = await service.start();
    assert.equal(started.running, true);
    assert.equal(started.retention, "memory-only");
    assert.equal(started.observationCount, 1);
    assert.equal(started.observations.length, 1);
    assert.equal("rawPayload" in started.observations[0], false);
    assert.equal(started.sources[0].health.cachedObservations, 1);

    const manuallyRefreshed = await service.refresh();
    assert.equal(manuallyRefreshed.refreshResults?.[0].status, "skipped");
    assert.equal(manuallyRefreshed.refreshResults?.[0].reason, "rate-limited");
    assert.equal(manuallyRefreshed.observations.length, 1);

    const rateChanged = await service.configureSource("test.seismic", { pollCadenceMs: 2 * 60_000 });
    assert.equal(rateChanged.sources[0].health.pollCadenceMs, 2 * 60_000);

    const disabled = await service.configureSource("test.seismic", { enabled: false });
    assert.equal(disabled.sources[0].health.enabled, false);
    assert.equal(disabled.observations.length, 0);
    assert.equal(disabled.sources[0].health.cachedObservations, 1);
    const disabledRefresh = await service.refreshSource("test.seismic");
    assert.equal(disabledRefresh.refreshResults?.[0].reason, "disabled");
    await assert.rejects(() => service.refreshSource("missing.source"), /Unknown Hunter-Seeker source/);

    const enabled = await service.configureSource("test.seismic", { enabled: true });
    assert.equal(enabled.sources[0].health.enabled, true);
    assert.equal(enabled.observations.length, 1);

    const stopped = await service.stop();
    assert.equal(stopped.running, false);
    assert.equal(stopped.observations.length, 0);
  } finally {
    await service.stop();
  }
});

test("Hunter-Seeker suppresses OpenSky blue contacts when the military layer identifies the same ICAO", async () => {
  const aircraftObservation = (sourceFeedId: string, hex: string, entityType: string): NormalizedObservation => ({
    ...observation,
    observationId: `${sourceFeedId}:${hex}`,
    entityId: `aircraft:${hex}`,
    entityType,
    provenance: { ...observation.provenance, sourceFeedId },
    attributes: { title: hex.toUpperCase(), transponderHex: hex.toUpperCase() },
  });
  const aircraftAdapter = (sourceId: string, events: NormalizedObservation[]): SourceAdapter<{ events: NormalizedObservation[] }> => ({
    descriptor: {
      ...adapter.descriptor,
      id: sourceId,
      displayName: sourceId,
      category: "aviation",
    },
    async fetch() { return { events }; },
    normalize(payload) { return payload.events; },
    health() { return { status: "healthy" }; },
  });
  const service = new HunterSeekerService([
    aircraftAdapter("adsb.lol.military", [aircraftObservation("adsb.lol.military", "abc123", "military-aircraft")]),
    aircraftAdapter("opensky.civil-airspace", [
      aircraftObservation("opensky.civil-airspace", "abc123", "civilian-aircraft"),
      aircraftObservation("opensky.civil-airspace", "def456", "civilian-aircraft"),
    ]),
  ]);
  try {
    const snapshot = await service.start();
    assert.equal(snapshot.observationCount, 2);
    assert.deepEqual(snapshot.observations.map((item) => item.observationId).sort(), ["adsb.lol.military:abc123", "opensky.civil-airspace:def456"]);
  } finally {
    await service.stop();
  }
});

test("the built-in OpenSky layer is registered but disabled until a permitted operator enables it", async () => {
  const service = new HunterSeekerService();
  try {
    const snapshot = await service.snapshot();
    const openSky = snapshot.sources.find((source) => source.descriptor.id === "opensky.civil-airspace");
    assert.ok(openSky);
    assert.equal(openSky.health.enabled, false);
    assert.equal(openSky.health.status, "disabled");
  } finally {
    await service.stop();
  }
});

test("persisted source settings can be reapplied on a fresh service instance", async () => {
  const saved = { "test.seismic": { enabled: false, pollCadenceMs: 12 * 60_000, requestBudgetPercent: 40 } };
  const first = new HunterSeekerService([adapter]);
  const second = new HunterSeekerService([adapter]);
  try {
    await first.applySourceSettings(saved);
    await second.applySourceSettings(saved);
    for (const service of [first, second]) {
      const source = (await service.snapshot()).sources[0];
      assert.equal(source.health.enabled, false);
      assert.equal(source.health.pollCadenceMs, 12 * 60_000);
      assert.equal(source.health.requestBudgetPercent, 40);
    }
  } finally {
    await first.stop();
    await second.stop();
  }
});
