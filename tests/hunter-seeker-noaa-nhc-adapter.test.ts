import assert from "node:assert/strict";
import test from "node:test";
import { NoaaNhcAdapter } from "../build/hunter-seeker/adapters/noaa-nhc-adapter.ts";
import { toCommonEvent } from "../build/hunter-seeker/common-event.ts";
import { validateNormalizedObservation, validateSourceDescriptor } from "../build/hunter-seeker/source-adapter.ts";

const payload = { activeStorms: [{ id: "AL012026", name: "ALPHA", classification: "Hurricane", latitudeNumeric: 24.5, longitudeNumeric: -72.25, intensity: 105, pressure: 960, movementDir: "NW", movementSpeed: 12, lastUpdate: "2026-08-05T15:00:00Z" }] };

test("NHC adapter uses the fixed official current-storm endpoint", async () => {
  const adapter = new NoaaNhcAdapter({ fetchImplementation: async (url, init) => { assert.equal(String(url), "https://www.nhc.noaa.gov/CurrentStorms.json"); assert.equal(init?.redirect, "error"); return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }); } });
  validateSourceDescriptor(adapter.descriptor); const result = await adapter.fetch({ requestedAt: "2026-08-05T15:01:00Z", signal: new AbortController().signal }); assert.equal(result.activeStorms?.length, 1);
});

test("NHC active systems normalize into storm events with official provenance", () => {
  const adapter = new NoaaNhcAdapter(); const [observation] = adapter.normalize(payload, { fetchedAt: "2026-08-05T15:01:00Z", receivedAt: "2026-08-05T15:01:01Z" });
  validateNormalizedObservation(observation, adapter.descriptor.id); const event = toCommonEvent(observation);
  assert.equal(event.sourceEventId, "AL012026"); assert.equal(event.eventType, "tropical_system_advisory"); assert.equal(event.geometry.type, "Point"); assert.equal(event.license, "NOAA/NWS public data");
});

test("NHC zero-active-storm response is healthy rather than a feed failure", () => {
  const adapter = new NoaaNhcAdapter(); assert.deepEqual(adapter.normalize({ activeStorms: [] }, { fetchedAt: "2026-08-05T15:01:00Z", receivedAt: "2026-08-05T15:01:01Z" }), []); assert.equal(adapter.health().status, "healthy");
});
/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0.
 * See LICENSE and NOTICE for attribution requirements. Original Code: VoidCat Harness.
 * Initial Developer: iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved.
 */
