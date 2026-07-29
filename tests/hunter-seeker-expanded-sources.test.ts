/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CELESTRAK_ADDITIONAL_GROUPS, CelestrakStationsAdapter } from "../build/hunter-seeker/adapters/celestrak-stations-adapter.ts";
import { NASA_EONET_LAYERS, NasaEonetAdapter } from "../build/hunter-seeker/adapters/nasa-eonet-adapter.ts";
import { validateNormalizedObservation, validateSourceDescriptor } from "../build/hunter-seeker/source-adapter.ts";
import { HunterSeekerService } from "../build/hunter-seeker/hunter-seeker-service.ts";

const fixture = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", id: "EONET_1001", geometry: { type: "Point", coordinates: [-119.5, 36.7] }, properties: { title: "Fixture Fire", date: "2026-07-28T10:00:00Z", categories: [{ id: "wildfires" }], sources: [{ id: "InciWeb", url: "https://example.test/fire" }] } },
    { type: "Feature", id: "EONET_2002", geometry: { type: "Point", coordinates: [140.1, 35.8] }, properties: { title: "Fixture Storm", date: "2026-07-28T09:00:00Z", categories: [{ id: "severeStorms" }] } },
  ],
};

test("the fifteen expansion layers have unique valid descriptors", () => {
  assert.equal(NASA_EONET_LAYERS.length, 10);
  assert.equal(CELESTRAK_ADDITIONAL_GROUPS.length, 5);
  const adapters = [...NASA_EONET_LAYERS.map((layer) => new NasaEonetAdapter(layer)), ...CELESTRAK_ADDITIONAL_GROUPS.map((group) => new CelestrakStationsAdapter(group))];
  assert.equal(new Set(adapters.map((adapter) => adapter.descriptor.id)).size, 15);
  adapters.forEach((adapter) => assert.doesNotThrow(() => validateSourceDescriptor(adapter.descriptor)));
});

test("NASA category layers share one bounded provider request and normalize only their category", async () => {
  let requests = 0;
  const fetchImplementation = async () => { requests += 1; return new Response(JSON.stringify(fixture), { status: 200, headers: { "Content-Type": "application/geo+json" } }); };
  const wildfires = new NasaEonetAdapter({ ...NASA_EONET_LAYERS[1], fetchImplementation });
  const storms = new NasaEonetAdapter({ ...NASA_EONET_LAYERS[0], fetchImplementation });
  const context = { signal: new AbortController().signal, requestedAt: "2026-07-28T10:05:00Z" };
  const [wildfirePayload, stormPayload] = await Promise.all([wildfires.fetch(context), storms.fetch(context)]);
  assert.equal(requests, 1);
  const normalizeContext = { fetchedAt: "2026-07-28T10:05:00Z", receivedAt: "2026-07-28T10:05:01Z" };
  const fireRecords = wildfires.normalize(wildfirePayload, normalizeContext);
  const stormRecords = storms.normalize(stormPayload, normalizeContext);
  assert.equal(fireRecords.length, 1);
  assert.equal(stormRecords.length, 1);
  assert.equal(fireRecords[0].entityType, "natural-event.wildfire");
  assert.equal(stormRecords[0].entityType, "natural-event.storm");
  assert.doesNotThrow(() => validateNormalizedObservation(fireRecords[0], wildfires.descriptor.id));
  assert.match(String(fireRecords[0].attributes.coverageLimitation), /absence is not proof/i);
});

test("additional CelesTrak groups point to their selected provider group", async () => {
  let requested = "";
  const adapter = new CelestrakStationsAdapter({ ...CELESTRAK_ADDITIONAL_GROUPS[0], fetchImplementation: async (input) => { requested = String(input); return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }); } });
  await adapter.fetch({ signal: new AbortController().signal, requestedAt: "2026-07-28T10:05:00Z" });
  assert.match(requested, /GROUP=WEATHER/);
  assert.match(requested, /FORMAT=JSON/);
});

test("the default matrix registers all fifteen optional layers without enabling them", async () => {
  const snapshot = await new HunterSeekerService().snapshot();
  const optionalIds = new Set([...NASA_EONET_LAYERS.map((layer) => layer.sourceId), ...CELESTRAK_ADDITIONAL_GROUPS.map((group) => group.sourceId)]);
  assert.equal(snapshot.sources.filter((source) => optionalIds.has(source.descriptor.id as never)).length, 15);
  assert.equal(snapshot.sources.filter((source) => optionalIds.has(source.descriptor.id as never) && source.health.enabled).length, 0);
});

test("operator guide, header action, and compact no-scroll rail are packaged", () => {
  const root = join(import.meta.dirname, "..");
  const guide = readFileSync(join(root, "public", "HOW_TO_USE_VOIDCAT.txt"), "utf8");
  const consoleSource = readFileSync(join(root, "app", "VoidCatConsole.tsx"), "utf8");
  const styles = readFileSync(join(root, "app", "globals.css"), "utf8");
  const desktop = readFileSync(join(root, "desktop", "main.cjs"), "utf8");
  assert.match(guide, /01 — UNIT BANK/);
  assert.match(guide, /16 — SUPPORT_VC/);
  assert.match(consoleSource, /HOW_TO_USE_VC/);
  assert.match(desktop, /voidcat:docs:open-how-to-use/);
  assert.match(styles, /\.rail-code,.rail-status\{display:none\}/);
  assert.match(styles, /\.rail nav\{grid-template-rows:repeat\(16,minmax\(27px,1fr\)\);gap:2px;height:100%;overflow:hidden\}/);
});
