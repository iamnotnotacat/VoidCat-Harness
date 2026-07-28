import assert from "node:assert/strict";
import test from "node:test";
import { VoidCatJobManager } from "../build/voidcat-job-manager.ts";
import { VoidCatToolRegistry, ToolRegistryError } from "../build/voidcat-tool-registry.ts";
import { HunterSeekerService } from "../build/hunter-seeker/hunter-seeker-service.ts";
import type { NormalizedObservation, SourceAdapter } from "../build/hunter-seeker/source-adapter.ts";
import { HUNTER_SEEKER_TOOL_NAMES, HunterSeekerToolRuntime } from "../build/hunter-seeker/hunter-seeker-tools.ts";

const now = Date.now();

function observation(overrides: Partial<NormalizedObservation> & Pick<NormalizedObservation, "observationId" | "entityId" | "entityType">): NormalizedObservation {
  return {
    position: { latitude: 35, longitude: -90, altitudeMeters: 1_000 },
    timestamp: new Date(now - 60_000).toISOString(),
    provenance: {
      sourceFeedId: "test.live",
      fetchedAt: new Date(now).toISOString(),
      receivedAt: new Date(now).toISOString(),
      upstreamTimestamp: new Date(now - 60_000).toISOString(),
      stalenessMs: 60_000,
    },
    confidence: 0.9,
    basis: "measured",
    retentionClass: "bulk",
    attributes: {},
    rawPayload: { never: "expose this" },
    ...overrides,
  };
}

const observations: NormalizedObservation[] = [
  observation({ observationId: "air:mil-one", entityId: "aircraft:abc123", entityType: "military-aircraft", attributes: { callsign: "VIPER1", transponderHex: "ABC123" } }),
  observation({ observationId: "air:civ-one", entityId: "aircraft:def456", entityType: "civilian-aircraft", position: { latitude: 12, longitude: 179.5, altitudeMeters: 5_000 }, attributes: { callsign: "BLUE20", registration: "N20VC" } }),
  observation({ observationId: "orbit:iss", entityId: "space-station:25544", entityType: "space-station", position: { latitude: 13, longitude: -179.5, altitudeMeters: 410_000 }, attributes: { title: "ISS", noradCatalogId: "25544", orbitalElements: { OBJECT_NAME: "ISS (ZARYA)", OBJECT_ID: "1998-067A", EPOCH: "2026-07-27T12:00:00.000000", MEAN_MOTION: 15.48327371, ECCENTRICITY: 0.0006816, INCLINATION: 51.6337, RA_OF_ASC_NODE: 67.8808, ARG_OF_PERICENTER: 93.4419, MEAN_ANOMALY: 26.7041, NORAD_CAT_ID: 25544, ELEMENT_SET_NO: 999, REV_AT_EPOCH: 52163, BSTAR: 0.0001027, MEAN_MOTION_DOT: 0.0001624, MEAN_MOTION_DDOT: 0 } }, basis: "estimated" }),
  observation({ observationId: "quake:one", entityId: "seismic:one", entityType: "seismic-event", position: { latitude: 34, longitude: -118, altitudeMeters: -8_000 }, attributes: { magnitude: 4.3, place: "Test Ridge" } }),
];

const vessel = observation({ observationId: "aisstream-vessel:123456789", entityId: "vessel:123456789", entityType: "maritime-vessel", position: { latitude: 25, longitude: -90 }, provenance: { sourceFeedId: "aisstream.maritime", fetchedAt: new Date(now).toISOString(), receivedAt: new Date(now).toISOString(), upstreamTimestamp: new Date(now - 10_000).toISOString(), stalenessMs: 10_000 }, attributes: { title: "TEST VESSEL", mmsi: "123456789" } });

function adapter(): SourceAdapter<{ observations: NormalizedObservation[] }> {
  return {
    descriptor: {
      id: "test.live",
      displayName: "Test Live Feed",
      category: "environment",
      authTier: "tier-1",
      credentialType: "none",
      pollCadenceMs: 120_000,
      rateLimit: { requestsPerWindow: 1, windowMs: 60_000, hardHourlyBudget: 60 },
      providerDocsUrl: "https://example.test/feed",
      cache: { ttlMs: 600_000, maxObservations: 100 },
      retentionPolicy: { mode: "live-only" },
      estimatedBytesPerDay: 1_000,
    },
    async fetch() { return { observations }; },
    normalize(payload) { return payload.observations; },
    health() { return { status: "healthy" }; },
  };
}

async function fixture() {
  const service = new HunterSeekerService([adapter()]);
  await service.start();
  const registry = new VoidCatToolRegistry();
  const jobs = new VoidCatJobManager({ maximumConcurrentJobs: 1, minimumUpdateIntervalMs: 0 });
  const runtime = new HunterSeekerToolRuntime(service, registry, jobs, () => ({
    observations: [vessel],
    coverageLimitations: ["AIS coverage is limited to the selected Gulf of Mexico region.", "An empty result is not evidence of absence."],
    healthSources: [{ id: "aisstream.maritime", name: "aisstream.io Maritime", status: "healthy", enabled: true, lastSuccessAt: new Date(now).toISOString(), nextAllowedAt: null, nextScheduledAt: null, cachedObservations: 1, message: "Protected AIS bridge healthy." }],
  }));
  runtime.register();
  return { service, registry, jobs, runtime };
}

test("Hunter-Seeker discovery exposes only bounded live tools with closed schemas", async () => {
  const { service, runtime } = await fixture();
  try {
    const discovered = runtime.discover();
    assert.deepEqual(discovered.map((tool) => tool.name).sort(), [...HUNTER_SEEKER_TOOL_NAMES].sort());
    assert.equal(discovered.length, 6);
    for (const tool of discovered) {
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.match(tool.description, /Limited to/i);
      assert.match(tool.description, /no .*histor|historical|history/i);
      assert.ok(tool.tags?.includes("passive-osint"));
    }
    assert.equal(discovered.some((tool) => tool.name.includes("vessel")), true);
  } finally { await service.stop(); }
});

test("bbox tools handle antimeridian bounds and preserve exact local citations", async () => {
  const { service, registry } = await fixture();
  try {
    const aircraft = await registry.invoke<{ generatedAt: string; observationIds: string[]; provenance: string; confidence: number; freshness: string; coverageLimitations: string[]; observations: Array<Record<string, unknown>> }>("hunter-seeker.aircraft-in-bbox", {
      south: 10, west: 170, north: 20, east: -170,
    });
    assert.deepEqual(aircraft.observationIds, ["air:civ-one"]);
    assert.match(aircraft.provenance, /volatile source-registry snapshot/i);
    assert.equal(aircraft.confidence, 0.9);
    assert.equal(aircraft.freshness, aircraft.generatedAt);
    assert.ok(aircraft.coverageLimitations.length > 0);
    assert.deepEqual(aircraft.observations.map((item) => item.observationId), ["air:civ-one"]);
    assert.equal(aircraft.observations[0].citation, "[HS:air:civ-one]");
    assert.equal(typeof aircraft.observations[0].freshness, "string");
    assert.deepEqual(aircraft.observations[0].provenance, { sourceFeedId: "test.live", fetchedAt: new Date(now).toISOString(), observationTimestamp: new Date(now - 60_000).toISOString() });
    assert.equal(JSON.stringify(aircraft).includes("never"), false);

    const vessels = await registry.invoke<{ observations: Array<Record<string, unknown>> }>("hunter-seeker.vessels-in-bbox", {
      south: 18, west: -98, north: 31, east: -80,
    });
    assert.deepEqual(vessels.observations.map((item) => item.observationId), ["aisstream-vessel:123456789"]);
    assert.match(String((vessels.observations[0].coverageLimitations as string[])[0]), /Gulf of Mexico/);

    const empty = await registry.invoke<{ generatedAt: string; observationIds: string[]; provenance: string; confidence: number; freshness: string; coverageLimitations: string[]; observations: unknown[] }>("hunter-seeker.aircraft-in-bbox", {
      south: -5, west: -5, north: 5, east: 5,
    });
    assert.deepEqual(empty.observationIds, []);
    assert.deepEqual(empty.observations, []);
    assert.match(empty.provenance, /volatile source-registry snapshot/i);
    assert.equal(empty.confidence, 1);
    assert.equal(empty.freshness, empty.generatedAt);
    assert.ok(empty.coverageLimitations.some((limitation) => /empty result/i.test(limitation)));
  } finally { await service.stop(); }
});

test("callsign or ICAO, seismic, and satellite-pass filtering return supported observations", async () => {
  const { service, registry } = await fixture();
  try {
    const callsign = await registry.invoke<{ observations: Array<Record<string, unknown>> }>("hunter-seeker.aircraft-by-callsign-or-icao", { identifier: "viper1" });
    assert.deepEqual(callsign.observations.map((item) => item.observationId), ["air:mil-one"]);
    const icao = await registry.invoke<{ observations: Array<Record<string, unknown>> }>("hunter-seeker.aircraft-by-callsign-or-icao", { identifier: "abc123" });
    assert.deepEqual(icao.observations.map((item) => item.observationId), ["air:mil-one"]);

    const seismic = await registry.invoke<{ observations: Array<Record<string, unknown>> }>("hunter-seeker.recent-seismic", { minimumMagnitude: 4, maxAgeMinutes: 10 });
    assert.deepEqual(seismic.observations.map((item) => item.observationId), ["quake:one"]);

    const passes = await registry.invoke<{ observations: Array<Record<string, unknown>> }>("hunter-seeker.satellite-passes-over-area", {
      south: -90, west: -180, north: 90, east: 180, hours: 1, stepSeconds: 300,
    });
    assert.equal(passes.observations.length, 1);
    assert.match(String(passes.observations[0].observationId), /^satellite-pass:25544:/);
    assert.equal(passes.observations[0].basis, "estimated");
  } finally { await service.stop(); }
});

test("managed invocation records visible caps, progress, and resource use", async () => {
  const { service, jobs, runtime } = await fixture();
  try {
    const handle = runtime.startInvocation("hunter-seeker.feed-health-status", {}, { kind: "user", id: "local-interface" });
    const result = await handle.result as { retention: string; historicalResolution: string; sources: Array<{ id: string }>; coverageLimitations: string[]; observationIds: string[] };
    const snapshot = jobs.snapshot(handle.id);
    assert.equal(result.retention, "memory-only");
    assert.match(result.historicalResolution, /empty result is not evidence of absence/i);
    assert.ok(result.sources.some((source) => source.id === "aisstream.maritime"));
    assert.ok(result.coverageLimitations.some((limitation) => limitation.includes("Gulf of Mexico")));
    assert.ok(result.observationIds.includes("aisstream-vessel:123456789"));
    assert.equal(snapshot.status, "completed");
    assert.equal(snapshot.caps.maxIterations, 2);
    assert.equal(snapshot.caps.maxExternalCalls, 1);
    assert.equal(snapshot.resources.externalCalls, 1);
    assert.equal(snapshot.resources.iterations, 1);
    assert.equal(snapshot.progress.current, 1);
  } finally { await service.stop(); }
});

test("invalid arguments are rejected before a tool handler can run", async () => {
  const { service, registry } = await fixture();
  try {
    await assert.rejects(
      registry.invoke("hunter-seeker.aircraft-in-bbox", { south: -91, west: 0, north: 10, east: 20 }),
      (error: unknown) => error instanceof ToolRegistryError && error.code === "INVALID_ARGUMENTS",
    );
    assert.equal(registry.invocationRecords({ module: "hunter-seeker" }).at(-1)?.status, "rejected");
  } finally { await service.stop(); }
});
