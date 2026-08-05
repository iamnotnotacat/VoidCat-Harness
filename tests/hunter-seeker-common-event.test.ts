/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0.
 * See LICENSE and NOTICE for attribution requirements. Original Code: VoidCat Harness.
 * Initial Developer: iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { toCommonEvent, validateCommonEvent, type CommonEvent } from "../build/hunter-seeker/common-event.ts";
import type { NormalizedObservation } from "../build/hunter-seeker/source-adapter.ts";

function observation(overrides: Partial<NormalizedObservation> = {}): NormalizedObservation {
  return {
    observationId: "nasa.firms:20260805-123456", entityId: "thermal:20260805-123456", entityType: "wildfire.detection",
    position: { latitude: 35.4676, longitude: -97.5164 }, timestamp: "2026-08-05T13:42:00Z",
    provenance: { sourceFeedId: "nasa.firms", fetchedAt: "2026-08-05T13:50:00Z", receivedAt: "2026-08-05T13:50:00Z", upstreamTimestamp: "2026-08-05T13:48:00Z", stalenessMs: 480_000 },
    confidence: 0.89, basis: "measured", retentionClass: "bulk",
    attributes: { sourceEventId: "20260805-123456", eventType: "wildfire_detection", publishedAt: "2026-08-05T13:48:00Z", severityScore: 0.72, sourceUrl: "https://firms.modaps.eosdis.nasa.gov/", license: "NASA Earth Science Data and Information Policy" },
    ...overrides,
  };
}

test("projects normalized observations into the common Hunter-Seeker event contract", () => {
  const event = toCommonEvent(observation());
  assert.equal(event.source, "nasa.firms");
  assert.equal(event.sourceEventId, "20260805-123456");
  assert.equal(event.eventType, "wildfire_detection");
  assert.deepEqual(event.geometry, { type: "Point", coordinates: [-97.5164, 35.4676] });
  assert.equal(event.severity, 0.72);
  assert.equal(event.confidence, 0.89);
  assert.equal(event.entities[0]?.id, "thermal:20260805-123456");
});

test("preserves provider geometry and entities while rejecting unsafe source URLs", () => {
  const event = toCommonEvent(observation({ attributes: { geometry: { type: "Polygon", coordinates: [[[-98, 35], [-97, 35], [-97, 36], [-98, 35]]] }, severity: "severe", sourceUrl: "file:///secret", license: "CC-BY-4.0", entities: [{ id: "area:okc", type: "geographic-area", name: "Oklahoma City" }] } }));
  assert.equal(event.geometry.type, "Polygon");
  assert.equal(event.severity, 0.75);
  assert.equal(event.sourceUrl, null);
  assert.deepEqual(event.entities, [{ id: "area:okc", type: "geographic-area", name: "Oklahoma City" }]);
});

test("common event validation rejects invalid confidence and geometry", () => {
  const invalid = { ...toCommonEvent(observation()), confidence: 2, geometry: { type: "Point", coordinates: [500, 95] } } as unknown as CommonEvent;
  assert.throws(() => validateCommonEvent(invalid), /Common event failed validation/);
});
