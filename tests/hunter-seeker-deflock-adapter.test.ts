import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFLOCK_ALPR_SOURCE_ID,
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
  assert.match(query, /man_made/);
  assert.match(query, /surveillance:type/);
  assert.match(query, /ALPR\|ANPR\|license_plate/);
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

test("DeFlock performs no network request until the map supplies a regional zoom", async () => {
  const adapter = new DeflockAlprAdapter();
  const payload = await adapter.fetch({ signal: new AbortController().signal, requestedAt: "2026-07-28T02:00:00Z" });
  assert.deepEqual(payload.elements, []);
  assert.equal(payload.voidcat?.reason, "zoom-required");
});
