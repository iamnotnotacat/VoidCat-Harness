import assert from "node:assert/strict";
import test from "node:test";
import { GdeltGeoAdapter } from "../build/hunter-seeker/adapters/gdelt-geo-adapter.ts";
import { toCommonEvent } from "../build/hunter-seeker/common-event.ts";
import { validateNormalizedObservation } from "../build/hunter-seeker/source-adapter.ts";
const payload = { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [2.3522, 48.8566] }, properties: { name: "<b>Paris</b> &amp; surrounding area", count: 18, url: "https://example.org/news" } }] };
test("GDELT geography query is bounded to one hour on the working official GeoJSON route", async () => { const adapter = new GdeltGeoAdapter({ fetchImplementation: async (url) => { const parsed = new URL(String(url)); assert.equal(parsed.hostname, "api.gdeltproject.org"); assert.equal(parsed.pathname, "/api/v1/gkg_geojson"); assert.equal(parsed.searchParams.get("TIMESPAN"), "60"); assert.match(parsed.searchParams.get("OUTPUTFIELDS") ?? "", /url/); return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/geo+json" } }); } }); const result = await adapter.fetch({ requestedAt: "2026-08-05T15:00:00Z", signal: new AbortController().signal }); assert.equal(result.features?.length, 1); });
test("GDELT GEO emits low-confidence mentions and strips provider HTML", () => { const adapter = new GdeltGeoAdapter(); const [observation] = adapter.normalize(payload, { fetchedAt: "2026-08-05T15:00:00Z", receivedAt: "2026-08-05T15:00:01Z" }); validateNormalizedObservation(observation, adapter.descriptor.id); const event = toCommonEvent(observation); assert.equal(observation.confidence, 0.45); assert.equal(event.eventType, "news_location_mention"); assert.equal(event.properties.title, "Paris & surrounding area"); assert.match(String(event.properties.coverageLimitation), /not a verified event location/); });
/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0.
 * See LICENSE and NOTICE for attribution requirements. Original Code: VoidCat Harness.
 * Initial Developer: iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved.
 */
