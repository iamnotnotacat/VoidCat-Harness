import assert from "node:assert/strict";
import test from "node:test";
import { SourceAdapterHttpError, validateNormalizedObservation } from "../build/hunter-seeker/source-adapter.ts";
import {
  ADSB_LOL_MILITARY_SOURCE_ID,
  ADSB_LOL_MILITARY_URL,
  AdsbLolMilitaryAdapter,
} from "../build/hunter-seeker/adapters/adsb-lol-military-adapter.ts";

const providerNow = Date.parse("2026-07-27T12:00:00.000Z");
const fixture = {
  ac: [{
    hex: "ae6bb2",
    type: "adsb_icao",
    flight: "RUDY30  ",
    r: "169465",
    t: "V22",
    alt_baro: 350,
    alt_geom: 250,
    gs: 218.7,
    track: 85.28,
    baro_rate: -192,
    squawk: "7700",
    emergency: "general",
    category: "A7",
    lat: 32.631582,
    lon: -117.466829,
    seen_pos: 0.25,
    messages: 6142,
    mlat: [],
    tisb: [],
    seen: 0,
    rssi: -18.9,
  }, {
    hex: "ae144a",
    type: "mode_s",
    flight: "RCH709  ",
    r: "05-5140",
    t: "C17",
    alt_baro: 34_000,
    lastPosition: { lat: 42.566553, lon: 23.530028, nic: 0, rc: 0, seen_pos: 69.1 },
    messages: 33_721,
    mlat: [],
    tisb: [],
    seen: 0.9,
    rssi: -18.2,
  }, {
    hex: "ae222c",
    type: "mode_s",
    r: "167951",
    t: "P8",
    alt_baro: 900,
    lastPosition: { lat: 35.09096, lon: -119.199962, nic: 0, rc: 0, seen_pos: 901 },
    messages: 30_211,
    mlat: [],
    tisb: [],
    seen: 1.5,
    rssi: -16.1,
  }, {
    hex: "adf7e2",
    type: "mode_s",
    alt_baro: "ground",
    messages: 4,
    mlat: [],
    tisb: [],
    seen: 58.6,
    rssi: -25.5,
  }],
  msg: "No error",
  now: providerNow,
  total: 4,
  ctime: providerNow,
  ptime: 0,
};

test("adsb.lol adapter fetches the fixed military endpoint and normalizes positioned aircraft", async () => {
  let requestedUrl = "";
  let requestInit: RequestInit | undefined;
  const adapter = new AdsbLolMilitaryAdapter({
    fetchImplementation: async (input, init) => {
      requestedUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { "Content-Type": "application/json", "ETag": "adsb-lol-v1" },
      });
    },
  });
  const payload = await adapter.fetch({ signal: new AbortController().signal, requestedAt: "2026-07-27T12:00:00.000Z" });
  const observations = adapter.normalize(payload, { fetchedAt: "2026-07-27T12:00:00.000Z", receivedAt: "2026-07-27T12:00:01.000Z" });

  assert.equal(adapter.descriptor.pollCadenceMs, 2 * 60_000);
  assert.equal(requestedUrl, ADSB_LOL_MILITARY_URL);
  assert.equal(new Headers(requestInit?.headers).get("Accept"), "application/json");
  assert.equal(requestInit?.credentials, "omit");
  assert.equal(requestInit?.redirect, "error");
  assert.equal(observations.length, 2);

  const direct = observations[0];
  assert.equal(direct.observationId, "adsb-lol-military:ae6bb2");
  assert.equal(direct.entityId, "aircraft:ae6bb2");
  assert.equal(direct.position.latitude, 32.631582);
  assert.equal(direct.position.longitude, -117.466829);
  assert.equal(direct.position.altitudeMeters, 76.2);
  assert.equal(direct.attributes.callsign, "RUDY30");
  assert.equal(direct.attributes.aircraftType, "V22");
  assert.equal(direct.attributes.squawk, "7700");
  assert.equal(direct.attributes.positionSource, "current-broadcast");
  assert.equal(direct.confidence, 0.9);
  assert.equal(direct.provenance.sourceFeedId, ADSB_LOL_MILITARY_SOURCE_ID);
  assert.doesNotThrow(() => validateNormalizedObservation(direct, ADSB_LOL_MILITARY_SOURCE_ID));

  const fallback = observations[1];
  assert.equal(fallback.attributes.positionSource, "last-position");
  assert.equal(fallback.confidence, 0.55);
  assert.ok(fallback.provenance.stalenessMs >= 69_000);
  assert.match(adapter.health().message ?? "", /without a recent position/i);
});

test("adsb.lol adapter reuses a conditional 304 payload", async () => {
  const requests: Headers[] = [];
  const adapter = new AdsbLolMilitaryAdapter({
    fetchImplementation: async (_input, init) => {
      requests.push(new Headers(init?.headers));
      if (requests.length === 1) return new Response(JSON.stringify(fixture), { status: 200, headers: { "Content-Type": "application/json", "ETag": "adsb-lol-v1" } });
      return new Response(null, { status: 304 });
    },
  });
  const context = { signal: new AbortController().signal, requestedAt: "2026-07-27T12:00:00.000Z" };
  const first = await adapter.fetch(context);
  const second = await adapter.fetch(context);
  assert.equal(second, first);
  assert.equal(requests[1].get("If-None-Match"), "adsb-lol-v1");
});

test("adsb.lol HTTP failures preserve status and retry guidance", async () => {
  const adapter = new AdsbLolMilitaryAdapter({
    fetchImplementation: async () => new Response("busy", { status: 503, headers: { "Retry-After": "5" } }),
  });
  await assert.rejects(
    adapter.fetch({ signal: new AbortController().signal, requestedAt: "2026-07-27T12:00:00.000Z" }),
    (error: unknown) => error instanceof SourceAdapterHttpError && error.statusCode === 503 && error.retryAfterMs === 5_000,
  );
  assert.equal(adapter.health().status, "down");
});
