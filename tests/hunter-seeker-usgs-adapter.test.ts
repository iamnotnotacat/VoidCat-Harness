import assert from "node:assert/strict";
import test from "node:test";
import { SourceAdapterHttpError, validateNormalizedObservation } from "../build/hunter-seeker/source-adapter.ts";
import {
  USGS_EARTHQUAKE_FEED_URL,
  USGS_EARTHQUAKE_SOURCE_ID,
  UsgsEarthquakeAdapter,
} from "../build/hunter-seeker/adapters/usgs-earthquake-adapter.ts";

const fixture = {
  type: "FeatureCollection" as const,
  metadata: { generated: 1_785_181_747_000, count: 1 },
  features: [{
    type: "Feature",
    properties: {
      mag: 4.5,
      place: "Bonin Islands, Japan region",
      time: 1_785_179_018_391,
      updated: 1_785_181_465_040,
      url: "https://earthquake.usgs.gov/earthquakes/eventpage/us6000tg6e",
      detail: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/us6000tg6e.geojson",
      felt: null,
      cdi: null,
      mmi: null,
      alert: null,
      status: "reviewed",
      tsunami: 0,
      sig: 312,
      net: "us",
      code: "6000tg6e",
      magType: "mb",
      type: "earthquake",
      title: "M 4.5 - Bonin Islands, Japan region",
    },
    geometry: { type: "Point", coordinates: [139.8936, 28.1222, 426.772] },
    id: "us6000tg6e",
  }],
};

test("USGS adapter fetches the fixed feed and normalizes documented GeoJSON fields", async () => {
  let requestedUrl = "";
  const adapter = new UsgsEarthquakeAdapter({
    fetchImplementation: async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify(fixture), { status: 200, headers: { "Content-Type": "application/json", "ETag": "fixture-v1" } });
    },
  });
  const controller = new AbortController();
  const payload = await adapter.fetch({ signal: controller.signal, requestedAt: "2026-07-27T12:00:00.000Z" });
  const [event] = adapter.normalize(payload, { fetchedAt: "2026-07-27T12:00:00.000Z", receivedAt: "2026-07-27T12:00:01.000Z" });

  assert.equal(adapter.descriptor.pollCadenceMs, 2 * 60_000);
  assert.equal(requestedUrl, USGS_EARTHQUAKE_FEED_URL);
  assert.equal(event.observationId, "usgs-earthquake:us6000tg6e");
  assert.deepEqual(event.position, { latitude: 28.1222, longitude: 139.8936, altitudeMeters: -426_772 });
  assert.equal(event.attributes.magnitude, 4.5);
  assert.equal(event.attributes.depthKm, 426.772);
  assert.equal(event.confidence, 0.95);
  assert.equal(event.provenance.sourceFeedId, USGS_EARTHQUAKE_SOURCE_ID);
  assert.doesNotThrow(() => validateNormalizedObservation(event, USGS_EARTHQUAKE_SOURCE_ID));
  assert.equal(adapter.health().status, "healthy");
});

test("USGS adapter uses conditional requests and safely reuses a 304 payload", async () => {
  const requests: Headers[] = [];
  let attempt = 0;
  const adapter = new UsgsEarthquakeAdapter({
    fetchImplementation: async (_input, init) => {
      requests.push(new Headers(init?.headers));
      attempt += 1;
      if (attempt === 1) return new Response(JSON.stringify(fixture), { status: 200, headers: { "Content-Type": "application/json", "ETag": "fixture-v1" } });
      return new Response(null, { status: 304 });
    },
  });
  const signal = new AbortController().signal;
  const first = await adapter.fetch({ signal, requestedAt: "2026-07-27T12:00:00.000Z" });
  const second = await adapter.fetch({ signal, requestedAt: "2026-07-27T12:01:00.000Z" });
  assert.equal(requests[1].get("if-none-match"), "fixture-v1");
  assert.equal(second, first);
});

test("USGS HTTP failures preserve status and Retry-After for registry backoff", async () => {
  const adapter = new UsgsEarthquakeAdapter({
    fetchImplementation: async () => new Response("unavailable", { status: 503, headers: { "Retry-After": "2" } }),
  });
  await assert.rejects(
    adapter.fetch({ signal: new AbortController().signal, requestedAt: "2026-07-27T12:00:00.000Z" }),
    (error) => error instanceof SourceAdapterHttpError && error.statusCode === 503 && error.retryAfterMs === 2_000,
  );
  assert.equal(adapter.health().status, "down");
});
