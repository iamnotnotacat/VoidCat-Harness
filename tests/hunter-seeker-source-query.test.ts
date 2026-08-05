/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0.
 * See LICENSE and NOTICE for attribution requirements. Original Code: VoidCat Harness.
 * Initial Developer: iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { HunterSourceQueryRegistry } from "../build/hunter-seeker/source-query.ts";
import { HUNTER_SOURCE_QUERY_PROVIDERS } from "../build/hunter-seeker/query-providers/index.ts";
import { HUNTER_SEEKER_SOURCE_CATALOG } from "../build/hunter-seeker/source-catalog.ts";
import { acledProvider, gdeltEventProvider } from "../build/hunter-seeker/query-providers/credentialed-query-providers.ts";
import { jrcCatalogProvider } from "../build/hunter-seeker/query-providers/humanitarian-query-providers.ts";
import { noaaNceiProvider, openMeteoProvider } from "../build/hunter-seeker/query-providers/weather-query-providers.ts";
import { osmOverpassProvider } from "../build/hunter-seeker/query-providers/infrastructure-query-providers.ts";

const OPERATIONAL_OR_EXISTING = new Set(["gdelt.geo2", "gdacs.events", "nasa.eonet", "noaa.nhc", "aviationweather.hazards", "adsb.lol", "aisstream.maritime"]);

test("all 34 catalog sources outside the seven scheduled integrations have a unique query adapter", () => {
  const expected = HUNTER_SEEKER_SOURCE_CATALOG.map((source) => source.id).filter((id) => !OPERATIONAL_OR_EXISTING.has(id)).sort();
  const actual = HUNTER_SOURCE_QUERY_PROVIDERS.map((provider) => provider.sourceId).sort();
  assert.equal(actual.length, 34);
  assert.equal(new Set(actual).size, actual.length);
  assert.deepEqual(actual, expected);
  assert.equal(HUNTER_SOURCE_QUERY_PROVIDERS.filter((provider) => provider.credentialBroker).length, 11);
});

test("query registry validates bounds, caches exact queries, and never contacts the network for a cached result", async () => {
  let calls = 0;
  const registry = new HunterSourceQueryRegistry({ providers: [openMeteoProvider], now: () => Date.parse("2026-08-05T12:00:00Z"), fetchImplementation: async () => { calls += 1; return new Response(JSON.stringify({ latitude: 35.46, longitude: -97.51, current: { time: "2026-08-05T12:00:00Z", temperature_2m: 31, wind_speed_10m: 18, weather_code: 3 }, current_units: { temperature_2m: "°C", wind_speed_10m: "km/h" } }), { status: 200, headers: { "content-type": "application/json" } }); } });
  const input = { sourceId: "openmeteo.weather", point: { latitude: 35.46, longitude: -97.51, radiusKm: 20 }, limit: 10 };
  const first = await registry.query(input); const second = await registry.query(input);
  assert.equal(calls, 1); assert.equal(first.cache.status, "live"); assert.equal(second.cache.status, "cached");
  assert.equal(first.observations[0]?.provenance.sourceFeedId, "openmeteo.weather");
  assert.match(String(first.observations[0]?.attributes.license), /CC BY 4\.0/);
  await assert.rejects(() => registry.query({ ...input, point: { latitude: 91, longitude: 0 } }), /valid WGS84/);
});

test("Overpass accepts only approved bounded feature classes", async () => {
  let body = "";
  const options = {
    providers: [osmOverpassProvider],
    fetchImplementation: async (_url: string | URL | Request, init?: RequestInit) => {
      body = String(init?.body ?? "");
      return new Response(JSON.stringify({ elements: [] }), { status: 200 });
    },
  };
  await assert.rejects(() => new HunterSourceQueryRegistry(options).query({ sourceId: "osm.overpass", resource: "[out:json];node(0,0,1,1);out;", bbox: { west: -98, south: 35, east: -97, north: 36 } }), /must be one of/);
  await new HunterSourceQueryRegistry(options).query({ sourceId: "osm.overpass", resource: "hospitals", bbox: { west: -98, south: 35, east: -97, north: 36 } });
  assert.match(body, /amenity/); assert.match(body, /hospital/); assert.doesNotMatch(body, /out:csv/);
});

test("credentialed ACLED adapter receives only a redacted broker envelope and emits normalized observations", async () => {
  let brokerCalls = 0;
  const registry = new HunterSourceQueryRegistry({ providers: [acledProvider], now: () => Date.parse("2026-08-05T12:00:00Z"), brokerQuery: async (input) => { brokerCalls += 1; assert.equal(input.sourceId, "acled.events"); return { ok: true, data: { data: [{ event_id_cnty: "USA123", event_date: "2026-08-04", latitude: 35.46, longitude: -97.51, event_type: "Protests", sub_event_type: "Peaceful protest", location: "Oklahoma City", fatalities: 0, notes: "Reported demonstration" }] }, cache: { status: "live" } }; } });
  const result = await registry.query({ sourceId: "acled.events", bbox: { west: -98, south: 35, east: -97, north: 36 }, startAt: "2026-08-01T00:00:00Z", endAt: "2026-08-05T00:00:00Z" });
  assert.equal(brokerCalls, 1); assert.equal(result.observations.length, 1); assert.equal(result.observations[0]?.observationId, "acled.events:USA123"); assert.equal(JSON.stringify(result).includes("Authorization"), false);
});

test("GDELT BigQuery rows normalize into cited common-map observations without exposing broker configuration", async () => {
  const registry = new HunterSourceQueryRegistry({ providers: [gdeltEventProvider], now: () => Date.parse("2026-08-05T12:00:00Z"), brokerQuery: async () => ({ data: {
    schema: { fields: ["event_id", "location_name", "country_code", "latitude", "longitude", "event_date", "event_code", "base_event_code", "root_event_code", "quad_class", "goldstein_scale", "mentions", "sources", "articles", "average_tone", "source_url"].map((name) => ({ name })) },
    rows: [{ f: ["123", "Oklahoma City", "US", "35.4676", "-97.5164", "20260805", "141", "14", "14", "3", "-6.5", "8", "3", "5", "-2.1", "https://example.test/report"].map((v) => ({ v })) }],
  }, cache: { status: "live" } }) });
  const result = await registry.query({ sourceId: "gdelt.events", bbox: { west: -98, south: 35, east: -97, north: 36 }, startAt: "2026-08-05T00:00:00Z", endAt: "2026-08-05T23:59:59Z", limit: 10 });
  assert.equal(result.observations[0]?.observationId, "gdelt.events:123");
  assert.equal(result.observations[0]?.position.latitude, 35.4676);
  assert.match(String(result.observations[0]?.attributes.coverageLimitation), /machine-coded/i);
});

test("JRC uses the official EU search API and keeps only JRC catalogue results", async () => {
  let requested = "";
  const registry = new HunterSourceQueryRegistry({ providers: [jrcCatalogProvider], fetchImplementation: async (url) => {
    requested = String(url);
    return new Response(JSON.stringify({ result: { results: [
      { identifier: ["http://data.europa.eu/89h/jrc-fixture"], catalog: { id: "jrc" }, title: { en: "JRC Disaster Dataset" }, description: { en: "Fixture metadata" }, modified: "2026-08-01T00:00:00Z", landing_page: [{ resource: "https://data.jrc.ec.europa.eu/dataset/jrc-fixture" }] },
      { identifier: ["other"], catalog: { id: "other" }, title: { en: "Not JRC" } },
    ] } }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const result = await registry.query({ sourceId: "jrc.catalog", query: "disaster", limit: 5 });
  assert.match(requested, /data\.europa\.eu\/api\/hub\/search\/search/);
  assert.match(decodeURIComponent(requested), /"catalog":\["jrc"\]/);
  assert.deepEqual(result.references?.map((reference) => reference.id), ["jrc-fixture"]);
});

test("NCEI sends an exact station ID and excludes station data outside the selected viewport", async () => {
  let requested = "";
  const registry = new HunterSourceQueryRegistry({ providers: [noaaNceiProvider], fetchImplementation: async (url) => {
    requested = String(url);
    return new Response(JSON.stringify([{ STATION: "USW00013967", NAME: "OKLAHOMA CITY WILL ROGERS WORLD AIRPORT, OK US", DATE: "2026-06-01", LATITUDE: "35.38843", LONGITUDE: "-97.60035", TMAX: "35.6" }]), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const invalidRegistry = new HunterSourceQueryRegistry({ providers: [noaaNceiProvider], fetchImplementation: async () => { throw new Error("network must not be reached"); } });
  await assert.rejects(() => invalidRegistry.query({ sourceId: "noaa.ncei", resource: "bad station!", bbox: { west: -98, south: 35, east: -97, north: 36 }, startAt: "2026-06-01T00:00:00Z", endAt: "2026-06-02T00:00:00Z", limit: 10 }), /exact station identifier/);
  const result = await registry.query({ sourceId: "noaa.ncei", resource: "USW00013967", bbox: { west: -98, south: 35, east: -97, north: 36 }, startAt: "2026-06-01T00:00:00Z", endAt: "2026-06-02T00:00:00Z", limit: 10 });
  assert.match(requested, /stations=USW00013967/);
  assert.match(requested, /dataset=daily-summaries/);
  assert.equal(result.observations.length, 1);
});
