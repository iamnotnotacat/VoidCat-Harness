import assert from "node:assert/strict";
import test from "node:test";
import {
  CELESTRAK_STATIONS_URL,
  CelestrakStationsAdapter,
} from "../build/hunter-seeker/adapters/celestrak-stations-adapter.ts";

const station = {
  OBJECT_NAME: "ISS (ZARYA)",
  OBJECT_ID: "1998-067A",
  EPOCH: "2026-07-27T12:00:00.000000",
  MEAN_MOTION: 15.48327371,
  ECCENTRICITY: 0.0006816,
  INCLINATION: 51.6337,
  RA_OF_ASC_NODE: 67.8808,
  ARG_OF_PERICENTER: 93.4419,
  MEAN_ANOMALY: 26.7041,
  EPHEMERIS_TYPE: 0,
  CLASSIFICATION_TYPE: "U",
  NORAD_CAT_ID: 25544,
  ELEMENT_SET_NO: 999,
  REV_AT_EPOCH: 52163,
  BSTAR: 0.0001027,
  MEAN_MOTION_DOT: 0.0001624,
  MEAN_MOTION_DDOT: 0,
  OBJECT_TYPE: "PAYLOAD",
  COUNTRY_CODE: "ISS",
};

function fetchContext(requestedAt = "2026-07-27T12:02:00.000Z") {
  return { signal: new AbortController().signal, requestedAt };
}

test("CelesTrak station adapter fetches bounded OMM JSON and propagates an estimated position", async () => {
  let requests = 0;
  const adapter = new CelestrakStationsAdapter({
    fetchImplementation: async (input, init) => {
      requests += 1;
      assert.equal(String(input), CELESTRAK_STATIONS_URL);
      assert.equal(init?.redirect, "error");
      return new Response(JSON.stringify([station]), { status: 200, headers: { "Content-Type": "application/json", ETag: "station-set-1" } });
    },
  });

  const payload = await adapter.fetch(fetchContext());
  const observations = adapter.normalize(payload, {
    fetchedAt: "2026-07-27T12:02:00.000Z",
    receivedAt: "2026-07-27T12:02:01.000Z",
  });

  assert.equal(requests, 1);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].observationId, "celestrak-station:25544");
  assert.equal(observations[0].entityId, "satellite:25544");
  assert.equal(observations[0].entityType, "space-station");
  assert.equal(observations[0].basis, "estimated");
  assert.equal(observations[0].attributes.propagationModel, "SGP4");
  assert.equal(observations[0].attributes.noradCatalogId, "25544");
  assert.ok(observations[0].position.latitude >= -90 && observations[0].position.latitude <= 90);
  assert.ok(observations[0].position.longitude >= -180 && observations[0].position.longitude <= 180);
  assert.ok((observations[0].position.altitudeMeters ?? 0) > 100_000);
  assert.ok(Number(observations[0].attributes.velocityKilometersPerSecond) > 1);
  assert.equal(observations[0].provenance.stalenessMs, 121_000);
});

test("CelesTrak station adapter reuses cached elements for local propagation inside the two-hour provider floor", async () => {
  let requests = 0;
  const adapter = new CelestrakStationsAdapter({
    fetchImplementation: async () => {
      requests += 1;
      return new Response(JSON.stringify([station]), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  const first = await adapter.fetch(fetchContext("2026-07-27T12:02:00.000Z"));
  const cached = await adapter.fetch(fetchContext("2026-07-27T12:04:00.000Z"));
  assert.equal(requests, 1);
  assert.equal(cached, first);
  assert.match((await adapter.health()).message ?? "", /cached CelesTrak element set/i);
});

test("CelesTrak station adapter rejects oversized or malformed provider payloads", async () => {
  const oversized = new CelestrakStationsAdapter({
    fetchImplementation: async () => new Response("[]", { status: 200, headers: { "Content-Type": "application/json", "Content-Length": "2000001" } }),
  });
  await assert.rejects(() => oversized.fetch(fetchContext()), /byte safety limit/i);

  const malformed = new CelestrakStationsAdapter({
    fetchImplementation: async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
  });
  await assert.rejects(() => malformed.fetch(fetchContext()), /OMM JSON array/i);
});
