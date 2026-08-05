/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0.
 * See LICENSE and NOTICE for attribution requirements. Original Code: VoidCat Harness.
 * Initial Developer: iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved.
 */
/*
 * Bounded manual smoke checks for public Hunter-Seeker query adapters.
 * No credentials are read and no persistent database is touched.
 */
import { HunterSourceQueryRegistry } from "../build/hunter-seeker/source-query.ts";
import { HUNTER_SOURCE_QUERY_PROVIDERS } from "../build/hunter-seeker/query-providers/index.ts";

const registry = new HunterSourceQueryRegistry({ providers: HUNTER_SOURCE_QUERY_PROVIDERS.filter((provider) => !provider.credentialBroker) });
const bboxUs = { west: -103, south: 30, east: -94, north: 38 };
const bboxWorld = { west: -179, south: -80, east: 179, north: 80 };
const bboxCanada = { west: -141, south: 41, east: -52, north: 84 };
const point = { latitude: 35.4676, longitude: -97.5164, radiusKm: 50 };
const startAt = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
const endAt = new Date(Date.now() - 28 * 24 * 60 * 60_000).toISOString();
const checks = [
  { sourceId: "hdx.catalog", query: "disaster", limit: 5 },
  { sourceId: "jrc.catalog", query: "disaster", limit: 5 },
  { sourceId: "openfema.disasters", bbox: bboxUs, limit: 25 },
  { sourceId: "copernicus.ems", bbox: bboxWorld, limit: 25 },
  { sourceId: "noaa.nowcoast", bbox: bboxUs, limit: 5 },
  { sourceId: "noaa.spc", bbox: bboxUs, limit: 25 },
  { sourceId: "noaa.coops", bbox: bboxUs, limit: 25 },
  { sourceId: "noaa.ncei", bbox: bboxUs, startAt, endAt, resource: "USW00013967", limit: 25 },
  { sourceId: "openmeteo.weather", point, limit: 5 },
  { sourceId: "metno.locationforecast", point, limit: 5 },
  { sourceId: "eccc.geomet", bbox: bboxCanada, limit: 25 },
  { sourceId: "epa.envirofacts", resource: "OK", limit: 10 },
  { sourceId: "epa.echo", point, limit: 10 },
  { sourceId: "epa.radnet", bbox: bboxUs, limit: 25 },
  { sourceId: "safecast.measurements", point, limit: 10 },
  { sourceId: "faa.portal", query: "airports", limit: 5 },
  { sourceId: "noaa.marinecadastre.ais", query: "AIS vessel traffic", limit: 5 },
  { sourceId: "gbfs.registry", query: "US", limit: 5 },
  { sourceId: "bts.ntad", query: "airports", limit: 5 },
  { sourceId: "osm.overpass", bbox: { west: -97.7, south: 35.3, east: -97.3, north: 35.6 }, resource: "hospitals", limit: 10 },
  { sourceId: "overture.maps", query: "places", limit: 5 },
  { sourceId: "ripe.stat", resource: "AS3333", limit: 10 },
  { sourceId: "peeringdb.networks", bbox: bboxUs, limit: 50 },
];

const failures = [];
for (const input of checks) {
  const started = Date.now();
  try {
    const result = await registry.query(input);
    const count = result.observations.length + (result.references?.length ?? 0) + (result.overlays?.length ?? 0);
    process.stdout.write(`${input.sourceId}\tOK\t${count}\t${Date.now() - started}ms\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push({ sourceId: input.sourceId, message });
    process.stdout.write(`${input.sourceId}\tFAIL\t${message}\t${Date.now() - started}ms\n`);
  }
}
process.stdout.write(`SUMMARY\t${checks.length - failures.length}/${checks.length} passed\n`);
if (failures.length) process.exitCode = 1;
