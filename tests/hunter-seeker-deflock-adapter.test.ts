import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFLOCK_ALPR_SOURCE_ID,
  DEFLOCK_ALPR_DESCRIPTOR,
  DEFLOCK_DAILY_REFRESH_MS,
  DEFLOCK_MINIMUM_ZOOM,
  DeflockAlprAdapter,
  buildDeflockOverpassQuery,
  deflockViewportReady,
  validateDeflockViewport,
  type OverpassAlprPayload,
} from "../build/hunter-seeker/adapters/deflock-alpr-adapter.ts";
import { validateNormalizedObservation } from "../build/hunter-seeker/source-adapter.ts";

const regionalViewport = { south: 29.6, west: -98.8, north: 30.1, east: -98.1, zoom: 9 };

test("DeFlock viewport queries are bounded, passive, and restricted to ALPR nodes", () => {
  assert.deepEqual(validateDeflockViewport(regionalViewport), regionalViewport);
  assert.equal(deflockViewportReady(regionalViewport), true);
  assert.equal(deflockViewportReady({ ...regionalViewport, zoom: DEFLOCK_MINIMUM_ZOOM - 0.1 }), false);
  assert.throws(() => validateDeflockViewport({ ...regionalViewport, south: 40, north: 30 }), /latitude bounds/i);
  const query = buildDeflockOverpassQuery(regionalViewport);
  assert.doesNotMatch(query, /man_made/);
  assert.match(query, /surveillance:type/);
  assert.match(query, /ALPR\|ANPR\|LPR\|license_plate\|license_plate_reader/);
  assert.match(query, /29\.600000,-98\.800000,30\.100000,-98\.100000/);
  assert.doesNotMatch(query, /way|relation/);
});

test("DeFlock fixture normalization preserves provenance and camera limitations", async () => {
  const adapter = new DeflockAlprAdapter();
  adapter.setViewport(regionalViewport);
  const fixture: OverpassAlprPayload = {
    osm3s: { timestamp_osm_base: "2026-07-28T02:00:00Z" },
    elements: [
      { type: "node", id: 1234567, lat: 29.92, lon: -98.52, timestamp: "2026-07-27T22:10:00Z", tags: { man_made: "surveillance", "surveillance:type": "ALPR", manufacturer: "Flock Safety", direction: "92", operator: "Example County" } },
      { type: "node", id: 7654321, lat: 29.94, lon: -98.49, tags: { man_made: "surveillance", "surveillance:type": "camera" } },
      { type: "way", id: 88, lat: 29.9, lon: -98.5, tags: { "surveillance:type": "ALPR" } },
    ],
  };
  const observations = adapter.normalize(fixture, { fetchedAt: "2026-07-28T02:01:00Z", receivedAt: "2026-07-28T02:01:01Z" });
  assert.equal(observations.length, 1);
  const camera = observations[0];
  assert.doesNotThrow(() => validateNormalizedObservation(camera, DEFLOCK_ALPR_SOURCE_ID));
  assert.equal(camera.entityType, "infrastructure.alpr-camera");
  assert.equal(camera.attributes.isFlockSafety, true);
  assert.equal(camera.attributes.eventUrl, "https://www.openstreetmap.org/node/1234567");
  assert.match(String(camera.attributes.coverageLimitation), /absence does not establish/i);
  assert.equal(camera.provenance.upstreamTimestamp, "2026-07-27T22:10:00Z");
});

test("DeFlock loads a lightweight worldwide region index and caches a selected region for a day", async () => {
  const adapter = new DeflockAlprAdapter();
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input); calls.push(url);
    if (url.endsWith("/regions/index.json")) return new Response(JSON.stringify({ regions: ["20/-100", "40/-100"], tile_url: "https://cdn.deflock.me/regions/{lat}/{lon}.json?v=fixture", tile_size_degrees: 20, expiration_utc: 1_900_000_000 }), { status: 200 });
    if (url.includes("20/-100.json")) return new Response(JSON.stringify([{ id: 1, lat: 29.7, lon: -95.4, tags: { manufacturer: "Flock Safety" } }]), { status: 200 });
    if (url.includes("40/-100.json")) return new Response(JSON.stringify([{ id: 2, lat: 41.8, lon: -87.6, tags: { manufacturer: "Flock Safety" } }]), { status: 200 });
    return new Response("not found", { status: 404 });
  };
  try {
    const index = await adapter.fetch({ signal: new AbortController().signal, requestedAt: "2026-07-28T02:00:00Z" });
    assert.equal(index.elements?.length, 0);
    assert.equal(index.voidcat?.regionMarkers?.length, 2);
    assert.equal(calls.length, 1);
    adapter.selectRegion("20/-100");
    const first = await adapter.fetch({ signal: new AbortController().signal, requestedAt: "2026-07-28T02:01:00Z" });
    const second = await adapter.fetch({ signal: new AbortController().signal, requestedAt: "2026-07-28T03:00:00Z" });
    assert.equal(first.elements?.length, 1);
    assert.equal(first.voidcat?.coverage, "worldwide");
    assert.equal(first.voidcat?.tileCount, 2);
    assert.equal(first.voidcat?.activeRegion, "20/-100");
    assert.deepEqual(second.elements, first.elements);
    assert.equal(calls.length, 2);
    assert.equal(DEFLOCK_ALPR_DESCRIPTOR.pollCadenceMs, DEFLOCK_DAILY_REFRESH_MS);
    assert.equal(DEFLOCK_ALPR_DESCRIPTOR.cache.ttlMs, DEFLOCK_DAILY_REFRESH_MS);
  } finally { globalThis.fetch = originalFetch; }
});
