import assert from "node:assert/strict";
import test from "node:test";
import {
  NWS_ACTIVE_ALERTS_URL,
  NWS_USER_AGENT,
  NwsAlertsAdapter,
} from "../build/hunter-seeker/adapters/nws-alerts-adapter.ts";
import { SourceAdapterHttpError, validateNormalizedObservation } from "../build/hunter-seeker/source-adapter.ts";

const fixture = {
  type: "FeatureCollection",
  title: "Current watches, warnings, and advisories for the United States",
  updated: "2026-07-27T12:02:00+00:00",
  features: [{
    id: "https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.test",
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [[[-91, 34], [-89, 34], [-89, 36], [-91, 36], [-91, 34]]],
    },
    properties: {
      id: "https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.test",
      areaDesc: "Test County",
      sent: "2026-07-27T12:00:00-00:00",
      effective: "2026-07-27T12:00:00-00:00",
      onset: "2026-07-27T12:01:00-00:00",
      expires: "2026-07-27T13:00:00-00:00",
      status: "Actual",
      messageType: "Alert",
      category: "Met",
      severity: "Severe",
      certainty: "Likely",
      urgency: "Immediate",
      event: "Severe Thunderstorm Warning",
      senderName: "NWS Test Office",
      headline: "Severe Thunderstorm Warning issued for Test County",
      description: "A test weather description.",
      instruction: "Move indoors.",
      affectedZones: ["https://api.weather.gov/zones/county/TSC001"],
    },
  }, {
    id: "https://api.weather.gov/alerts/no-provider-geometry",
    type: "Feature",
    geometry: null,
    properties: { event: "Test alert", sent: "2026-07-27T12:00:00Z" },
  }],
} as const;

test("NWS adapter identifies itself, requests GeoJSON, and normalizes georeferenced CAP fields", async () => {
  let requestedUrl = "";
  let requestInit: RequestInit | undefined;
  const adapter = new NwsAlertsAdapter({
    fetchImplementation: async (input, init) => {
      requestedUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { "Content-Type": "application/geo+json", "ETag": "nws-v1" },
      });
    },
  });
  const payload = await adapter.fetch({ signal: new AbortController().signal, requestedAt: "2026-07-27T12:02:00.000Z" });
  const observations = adapter.normalize(payload, { fetchedAt: "2026-07-27T12:02:00.000Z", receivedAt: "2026-07-27T12:02:01.000Z" });

  assert.equal(adapter.descriptor.pollCadenceMs, 2 * 60_000);
  assert.equal(requestedUrl, NWS_ACTIVE_ALERTS_URL);
  const headers = new Headers(requestInit?.headers);
  assert.equal(headers.get("User-Agent"), NWS_USER_AGENT);
  assert.equal(headers.get("Accept"), "application/geo+json");
  assert.equal(requestInit?.credentials, "omit");
  assert.equal(requestInit?.redirect, "error");
  assert.equal(observations.length, 1);
  assert.equal(observations[0].position.latitude, 34.8);
  assert.ok(Math.abs(observations[0].position.longitude - -90.2) < 0.001);
  assert.equal(observations[0].attributes.event, "Severe Thunderstorm Warning");
  assert.equal(observations[0].attributes.severity, "severe");
  assert.equal(observations[0].confidence, 0.85);
  assert.equal(observations[0].basis, "estimated");
  assert.equal((observations[0].attributes.geometry as { type: string }).type, "Polygon");
  validateNormalizedObservation(observations[0], adapter.descriptor.id);
  assert.match((await adapter.health()).message ?? "", /1 alerts without provider geometry/);
});

test("NWS adapter reuses its cached payload after a conditional 304 response", async () => {
  const requests: Headers[] = [];
  const adapter = new NwsAlertsAdapter({
    fetchImplementation: async (_input, init) => {
      requests.push(new Headers(init?.headers));
      if (requests.length === 1) return new Response(JSON.stringify(fixture), { status: 200, headers: { "Content-Type": "application/geo+json", "ETag": "nws-v1" } });
      return new Response(null, { status: 304 });
    },
  });
  const context = { signal: new AbortController().signal, requestedAt: "2026-07-27T12:02:00.000Z" };
  const first = await adapter.fetch(context);
  const second = await adapter.fetch(context);
  assert.equal(second, first);
  assert.equal(requests[1].get("If-None-Match"), "nws-v1");
});

test("NWS HTTP failures preserve status and retry guidance", async () => {
  const adapter = new NwsAlertsAdapter({
    fetchImplementation: async () => new Response("busy", { status: 503, headers: { "Retry-After": "8" } }),
  });
  await assert.rejects(
    adapter.fetch({ signal: new AbortController().signal, requestedAt: "2026-07-27T12:02:00.000Z" }),
    (error: unknown) => error instanceof SourceAdapterHttpError && error.statusCode === 503 && error.retryAfterMs === 8_000,
  );
  assert.equal((await adapter.health()).status, "down");
});
