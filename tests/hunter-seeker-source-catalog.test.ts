import assert from "node:assert/strict";
import test from "node:test";
import { HUNTER_SEEKER_SOURCE_CATALOG, HUNTER_SEEKER_SOURCE_COUNTS, getHunterSeekerCatalogSource, hunterSeekerSourceCatalogStatus, validateHunterSeekerSourceCatalog } from "../build/hunter-seeker/source-catalog.ts";

test("requested Hunter-Seeker source catalog contains 41 unique, valid providers", () => {
  assert.doesNotThrow(() => validateHunterSeekerSourceCatalog());
  assert.equal(HUNTER_SEEKER_SOURCE_COUNTS.total, 41);
  assert.equal(new Set(HUNTER_SEEKER_SOURCE_CATALOG.map((source) => source.id)).size, 41);
});

test("runtime status distinguishes installed adapters from protected credential availability", () => {
  const statuses = hunterSeekerSourceCatalogStatus();
  assert.equal(statuses.filter((source) => source.adapterInstalled).length, HUNTER_SEEKER_SOURCE_COUNTS.integrated);
  assert.equal(statuses.find((source) => source.id === "gdelt.events")?.runtimeStatus, "credential-setup-required");
  assert.equal(statuses.find((source) => source.id === "acled.events")?.runtimeStatus, "credential-setup-required");
  assert.equal(statuses.find((source) => source.id === "acled.events")?.adapterInstalled, true);
  assert.equal(statuses.find((source) => source.id === "hdx.catalog")?.runtimeStatus, "integrated");
  assert.equal(statuses.find((source) => source.id === "hdx.catalog")?.adapterInstalled, true);
});

test("catalog distinguishes operational feeds from query and catalog integrations", () => {
  assert.deepEqual(getHunterSeekerCatalogSource("nasa.eonet")?.existingSourceIds, ["nasa.eonet"]);
  assert.equal(getHunterSeekerCatalogSource("adsb.lol")?.mode, "operational");
  assert.equal(getHunterSeekerCatalogSource("jrc.catalog")?.mode, "catalog-only");
  assert.equal(getHunterSeekerCatalogSource("openmeteo.weather")?.mode, "viewport-query");
  assert.equal(getHunterSeekerCatalogSource("acled.events")?.auth, "oauth2");
});

test("every catalog entry exposes licensing and coverage limitations", () => {
  for (const source of HUNTER_SEEKER_SOURCE_CATALOG) {
    assert.ok(source.license.length > 8, source.id);
    assert.ok(source.limitation.length > 20, source.id);
    assert.match(source.documentationUrl, /^https:\/\//);
  }
});
/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0.
 * See LICENSE and NOTICE for attribution requirements. Original Code: VoidCat Harness.
 * Initial Developer: iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved.
 */
