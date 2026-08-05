import assert from "node:assert/strict";
import test from "node:test";
import { GdacsEventsAdapter } from "../build/hunter-seeker/adapters/gdacs-events-adapter.ts";
import { toCommonEvent } from "../build/hunter-seeker/common-event.ts";
import { validateNormalizedObservation, validateSourceDescriptor } from "../build/hunter-seeker/source-adapter.ts";

const payload = { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [-97.5164, 35.4676] }, properties: { eventid: 1001, eventtype: "WF", name: "Test wildfire", fromdate: "2026-08-05T13:42:00Z", datemodified: "2026-08-05T13:48:00Z", alertlevel: "Orange", alertscore: 2, country: "United States", url: { report: "https://www.gdacs.org/report.aspx?eventid=1001" } } }] };

test("GDACS adapter performs one bounded fixed-origin request", async () => {
  let calls = 0;
  const adapter = new GdacsEventsAdapter({ fetchImplementation: async (url, init) => { calls += 1; assert.equal(String(url), "https://www.gdacs.org/gdacsapi/api/Events/geteventlist/SEARCH"); assert.equal(init?.redirect, "error"); return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/geo+json" } }); } });
  validateSourceDescriptor(adapter.descriptor);
  const result = await adapter.fetch({ requestedAt: "2026-08-05T13:50:00Z", signal: new AbortController().signal });
  assert.equal(calls, 1); assert.equal(result.features?.length, 1);
});

test("GDACS normalizes disaster alerts with provenance, common event metadata, and geometry", () => {
  const adapter = new GdacsEventsAdapter();
  const [observation] = adapter.normalize(payload, { fetchedAt: "2026-08-05T13:50:00Z", receivedAt: "2026-08-05T13:50:01Z" });
  validateNormalizedObservation(observation, adapter.descriptor.id);
  const event = toCommonEvent(observation);
  assert.equal(observation.entityType, "natural-event.wildfire"); assert.equal(event.sourceEventId, "1001"); assert.equal(event.eventType, "wildfire_alert");
  assert.equal(event.severity, 2 / 3); assert.equal(event.sourceUrl, "https://www.gdacs.org/report.aspx?eventid=1001");
});
/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0.
 * See LICENSE and NOTICE for attribution requirements. Original Code: VoidCat Harness.
 * Initial Developer: iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved.
 */
