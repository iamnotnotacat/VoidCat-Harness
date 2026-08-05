import assert from "node:assert/strict";
import test from "node:test";
import { AviationWeatherAdapter } from "../build/hunter-seeker/adapters/aviation-weather-adapter.ts";
import { toCommonEvent } from "../build/hunter-seeker/common-event.ts";
import { validateNormalizedObservation, validateSourceDescriptor } from "../build/hunter-seeker/source-adapter.ts";
const payload = { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Polygon", coordinates: [[[-100, 32], [-96, 32], [-96, 36], [-100, 32]]] }, properties: { id: "SIGMET-42", hazard: "Severe Turbulence", validTimeFrom: "2026-08-05T15:00:00Z", validTimeTo: "2026-08-05T19:00:00Z", severity: "severe", altitudeLow1: 18000, altitudeHi1: 42000 } }] };
test("AviationWeather adapter uses one bounded official GeoJSON request", async () => { const adapter = new AviationWeatherAdapter({ fetchImplementation: async (url, init) => { assert.equal(String(url), "https://aviationweather.gov/api/data/airsigmet?format=geojson"); assert.equal(init?.redirect, "error"); return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/geo+json" } }); } }); validateSourceDescriptor(adapter.descriptor); const result = await adapter.fetch({ requestedAt: "2026-08-05T15:01:00Z", signal: new AbortController().signal }); assert.equal(result.features?.length, 1); });
test("AviationWeather hazards preserve polygon, validity, provenance, and limitations", () => { const adapter = new AviationWeatherAdapter(); const [observation] = adapter.normalize(payload, { fetchedAt: "2026-08-05T15:01:00Z", receivedAt: "2026-08-05T15:01:01Z" }); validateNormalizedObservation(observation, adapter.descriptor.id); const event = toCommonEvent(observation); assert.equal(event.eventType, "aviation_weather_hazard"); assert.equal(event.geometry.type, "Polygon"); assert.equal(event.severity, 0.75); assert.match(String(event.properties.coverageLimitation), /advisory forecast areas/); });
/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0.
 * See LICENSE and NOTICE for attribution requirements. Original Code: VoidCat Harness.
 * Initial Developer: iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved.
 */
