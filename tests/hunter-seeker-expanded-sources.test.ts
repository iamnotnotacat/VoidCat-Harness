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
import { NASA_EONET_CLASSES, NASA_EONET_SOURCE_ID, NasaEonetAdapter } from "../build/hunter-seeker/adapters/nasa-eonet-adapter.ts";
import { validateNormalizedObservation, validateSourceDescriptor } from "../build/hunter-seeker/source-adapter.ts";
import { HunterSeekerService } from "../build/hunter-seeker/hunter-seeker-service.ts";

const fixture = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", id: "EONET_1001", geometry: { type: "Point", coordinates: [-119.5, 36.7] }, properties: { title: "Fixture Fire", date: "2026-07-28T10:00:00Z", categories: [{ id: "wildfires" }], sources: [{ id: "InciWeb", url: "https://example.test/fire" }] } },
    { type: "Feature", id: "EONET_2002", geometry: { type: "Point", coordinates: [140.1, 35.8] }, properties: { title: "Fixture Storm", date: "2026-07-28T09:00:00Z", categories: [{ id: "severeStorms" }] } },
  ],
};

test("NASA EONET is one bundled source alongside five CelesTrak expansion layers", () => {
  assert.equal(NASA_EONET_CLASSES.length, 13);
  assert.equal(CELESTRAK_ADDITIONAL_GROUPS.length, 5);
  const adapters = [new NasaEonetAdapter(), ...CELESTRAK_ADDITIONAL_GROUPS.map((group) => new CelestrakStationsAdapter(group))];
  assert.equal(new Set(adapters.map((adapter) => adapter.descriptor.id)).size, 6);
  adapters.forEach((adapter) => assert.doesNotThrow(() => validateSourceDescriptor(adapter.descriptor)));
});

test("one bounded NASA EONET request normalizes every represented event class", async () => {
  let requests = 0;
  const fetchImplementation = async () => { requests += 1; return new Response(JSON.stringify(fixture), { status: 200, headers: { "Content-Type": "application/geo+json" } }); };
  const adapter = new NasaEonetAdapter({ fetchImplementation });
  const context = { signal: new AbortController().signal, requestedAt: "2026-07-28T10:05:00Z" };
  const payload = await adapter.fetch(context);
  assert.equal(requests, 1);
  const normalizeContext = { fetchedAt: "2026-07-28T10:05:00Z", receivedAt: "2026-07-28T10:05:01Z" };
  const records = adapter.normalize(payload, normalizeContext);
  assert.deepEqual(records.map((record) => record.entityType), ["natural-event.wildfire", "natural-event.storm"]);
  assert.ok(records.every((record) => record.provenance.sourceFeedId === NASA_EONET_SOURCE_ID));
  records.forEach((record) => assert.doesNotThrow(() => validateNormalizedObservation(record, adapter.descriptor.id)));
  assert.match(String(records[0].attributes.coverageLimitation), /absence is not proof/i);
});

test("NASA category layers accept the official endpoint's mislabeled bounded GeoJSON response", async () => {
  const adapter = new NasaEonetAdapter({ fetchImplementation: async () => new Response(JSON.stringify(fixture), { status: 200, headers: { "Content-Type": "application/rss+xml; charset=utf-8" } }) });
  const payload = await adapter.fetch({ signal: new AbortController().signal, requestedAt: "2026-07-28T10:05:00Z" });
  assert.equal(adapter.normalize(payload, { fetchedAt: "2026-07-28T10:05:00Z", receivedAt: "2026-07-28T10:05:01Z" }).length, 2);
});

test("enabling an optional layer returns its first published observations immediately", async () => {
  const adapter = new NasaEonetAdapter({ fetchImplementation: async () => new Response(JSON.stringify(fixture), { status: 200, headers: { "Content-Type": "application/geo+json" } }) });
  const service = new HunterSeekerService([adapter]);
  try {
    await service.configureSource(adapter.descriptor.id, { enabled: false });
    await service.start();
    const enabled = await service.configureSource(adapter.descriptor.id, { enabled: true });
    assert.equal(enabled.refreshResults?.[0]?.status, "published");
    assert.equal(enabled.observations.length, 2);
    assert.equal(enabled.observations[0].provenance.sourceFeedId, adapter.descriptor.id);
  } finally { await service.stop(); }
});

test("additional CelesTrak groups point to their selected provider group", async () => {
  let requested = "";
  const adapter = new CelestrakStationsAdapter({ ...CELESTRAK_ADDITIONAL_GROUPS[0], fetchImplementation: async (input) => { requested = String(input); return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }); } });
  await adapter.fetch({ signal: new AbortController().signal, requestedAt: "2026-07-28T10:05:00Z" });
  assert.match(requested, /GROUP=WEATHER/);
  assert.match(requested, /FORMAT=JSON/);
});

test("the default matrix registers one EONET layer and five CelesTrak layers without enabling them", async () => {
  const snapshot = await new HunterSeekerService().snapshot();
  const optionalIds = new Set([NASA_EONET_SOURCE_ID, ...CELESTRAK_ADDITIONAL_GROUPS.map((group) => group.sourceId)]);
  assert.equal(snapshot.sources.filter((source) => optionalIds.has(source.descriptor.id as never)).length, 6);
  assert.equal(snapshot.sources.filter((source) => optionalIds.has(source.descriptor.id as never) && source.health.enabled).length, 0);
});

test("all thirteen EONET classes and five CelesTrak classes register identifying map icons", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "app", "HunterSeekerMap.tsx"), "utf8");
  const iconNames = ["storm", "wildfire", "volcano", "flood", "landslide", "drought", "dust-haze", "ice", "snow", "temperature", "eonet-earthquake", "manmade", "water-color", "weather-satellite", "navigation-satellite", "science-satellite", "recent-launch", "visual-satellite"];
  for (const name of iconNames) assert.match(source, new RegExp(`addImage\\(\"hunter-${name}-icon\"`));
  assert.equal(new Set(iconNames).size, 18);
});

test("legacy per-category EONET settings migrate to the bundled layer", async () => {
  const service = new HunterSeekerService();
  const snapshot = await service.applySourceSettings({ "nasa.eonet.drought": { enabled: true, pollCadenceMs: 15 * 60_000, requestBudgetPercent: 70 } });
  const source = snapshot.sources.find((entry) => entry.descriptor.id === NASA_EONET_SOURCE_ID);
  assert.equal(source?.health.enabled, true);
  assert.equal(source?.health.pollCadenceMs, 15 * 60_000);
  assert.equal(source?.health.requestBudgetPercent, 70);
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
