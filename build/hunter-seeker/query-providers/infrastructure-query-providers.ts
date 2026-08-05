/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import type { HunterSourceQueryProvider } from "../source-query.ts";
import { DAY, HOUR, MINUTE, createQueryObservation, inBoundingBox, number, parseCsv, sourceReferenceUrl, stableId, text, timestamp } from "../query-provider-helpers.ts";

function arcGisCatalogProvider(sourceId: "faa.portal" | "noaa.marinecadastre.ais" | "bts.ntad", ownerQuery: string, license: string): HunterSourceQueryProvider {
  return { sourceId, capability: "catalog", requires: ["query"], minimumIntervalMs: 10_000, cacheTtlMs: DAY, credentialBroker: false, async query(input, context) {
    const url = new URL("https://www.arcgis.com/sharing/rest/search"); url.searchParams.set("f", "json"); url.searchParams.set("num", String(Math.min(input.limit ?? 100, 100))); url.searchParams.set("q", `${ownerQuery} ${input.query}`);
    const payload = await context.fetchJson<{ results?: Array<Record<string, unknown>> }>(url.toString(), { maximumBytes: 3_000_000 });
    const references = (payload.results ?? []).map((record) => { const id = text(record.id) ?? stableId(JSON.stringify(record)); return { id, title: text(record.title) ?? `ArcGIS item ${id}`, url: `https://www.arcgis.com/home/item.html?id=${encodeURIComponent(id)}`, description: text(record.description ?? record.snippet) ?? undefined, publishedAt: typeof record.modified === "number" ? new Date(record.modified).toISOString() : undefined, license, properties: { type: record.type, owner: record.owner, tags: record.tags, accessInformation: record.accessInformation, url: sourceReferenceUrl(record.url) } }; });
    return { observations: [], references, coverageLimitation: "Official catalog discovery only. Load a selected dataset explicitly after reviewing its schema, license, and update frequency." };
  } };
}

export const faaCatalogProvider = arcGisCatalogProvider("faa.portal", "tags:FAA", "U.S. government public data; item metadata applies");
export const marineCadastreProvider = arcGisCatalogProvider("noaa.marinecadastre.ais", "tags:AIS", "U.S. government public data");
export const btsNtadProvider = arcGisCatalogProvider("bts.ntad", "tags:NTAD", "U.S. government public data");

export const gbfsRegistryProvider: HunterSourceQueryProvider = {
  sourceId: "gbfs.registry", capability: "catalog", requires: ["query"], minimumIntervalMs: 30_000, cacheTtlMs: DAY, credentialBroker: false,
  async query(input, context) {
    const csv = await context.fetchText("https://raw.githubusercontent.com/MobilityData/gbfs/master/systems.csv", { maximumBytes: 1_000_000 }); const rows = parseCsv(csv); const header = rows[0]?.map((value) => value.trim()) ?? []; const query = input.query!.toLowerCase();
    const index = (name: string) => header.findIndex((value) => value.toLowerCase() === name.toLowerCase()); const countryIndex = index("Country Code"); const nameIndex = index("Name"); const locationIndex = index("Location"); const systemIndex = index("System ID"); const urlIndex = index("URL"); const feedIndex = index("Auto-Discovery URL"); const versionIndex = index("Supported Versions");
    const references = rows.slice(1).filter((row) => `${row[nameIndex]} ${row[locationIndex]} ${row[countryIndex]}`.toLowerCase().includes(query)).slice(0, input.limit).flatMap((row) => {
      const url = sourceReferenceUrl(row[feedIndex]); if (!url) return []; return [{ id: row[systemIndex] || stableId(row.join(",")), title: row[nameIndex] || "GBFS system", url, description: [row[locationIndex], row[countryIndex], row[versionIndex]].filter(Boolean).join(" // "), license: "Feed-specific license", properties: { operatorUrl: sourceReferenceUrl(row[urlIndex]), systemId: row[systemIndex], location: row[locationIndex], country: row[countryIndex], versions: row[versionIndex] } }];
    });
    return { observations: [], references, coverageLimitation: "Registry discovery only; each operator feed has independent terms, health, and authentication requirements." };
  },
};

const OVERPASS_RESOURCES: Record<string, string> = {
  hospitals: '["amenity"="hospital"]', police: '["amenity"="police"]', fire: '["amenity"="fire_station"]', shelters: '["amenity"="shelter"]', substations: '["power"="substation"]', towers: '["man_made"="communications_tower"]', cameras: '["man_made"="surveillance"]', pipelines: '["man_made"="pipeline"]', ports: '["harbour"="yes"]', airports: '["aeroway"="aerodrome"]',
};

export const osmOverpassProvider: HunterSourceQueryProvider = {
  sourceId: "osm.overpass", capability: "viewport", requires: ["bbox", "resource"], minimumIntervalMs: MINUTE, cacheTtlMs: DAY, credentialBroker: false,
  async query(input, context) {
    const selector = OVERPASS_RESOURCES[input.resource!.toLowerCase()]; if (!selector) throw new Error(`Overpass resource must be one of: ${Object.keys(OVERPASS_RESOURCES).join(", ")}.`);
    const box = `${input.bbox!.south},${input.bbox!.west},${input.bbox!.north},${input.bbox!.east}`; const query = `[out:json][timeout:15];(node${selector}(${box});way${selector}(${box});relation${selector}(${box}););out center ${Math.min(input.limit ?? 100, 200)};`;
    const payload = await context.fetchJson<{ elements?: Array<Record<string, unknown>> }>("https://overpass-api.de/api/interpreter", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ data: query }).toString(), maximumBytes: 5_000_000 });
    const observations = (payload.elements ?? []).flatMap((element) => {
      const center = element.center as Record<string, unknown> | undefined; const latitude = number(element.lat ?? center?.lat); const longitude = number(element.lon ?? center?.lon); if (latitude === null || longitude === null) return []; const tags = element.tags as Record<string, unknown> | undefined; const id = `${element.type ?? "feature"}:${element.id}`;
      return [createQueryObservation({ sourceId: "osm.overpass", sourceEventId: id, entityType: `infrastructure.${input.resource}`, latitude, longitude, observedAt: timestamp(element.timestamp, context.requestedAt), context, title: text(tags?.name) ?? `${input.resource} ${element.id}`, confidence: 0.72, sourceUrl: `https://www.openstreetmap.org/${encodeURIComponent(String(element.type ?? "node"))}/${encodeURIComponent(String(element.id ?? ""))}`, license: "Open Database License (ODbL) 1.0", attributes: { osmType: element.type, osmId: element.id, version: element.version, tags, referenceOnly: true, coverageLimitation: "OpenStreetMap feature; mapped presence, tagging, position, and recency can be incomplete or inconsistent." } })];
    });
    return { observations, coverageLimitation: `Bounded, cached Overpass query for the approved ${input.resource} feature class only.` };
  },
};

export const overtureProvider: HunterSourceQueryProvider = {
  sourceId: "overture.maps", capability: "catalog", requires: ["query"], minimumIntervalMs: MINUTE, cacheTtlMs: DAY, credentialBroker: false,
  async query(input, context) {
    const rootUrl = "https://stac.overturemaps.org/catalog.json";
    const root = await context.fetchJson<{ id?: string; description?: string; links?: Array<Record<string, unknown>> }>(rootUrl, { maximumBytes: 1_000_000 }); const query = input.query!.toLowerCase();
    const latestLink = (root.links ?? []).find((link) => String(link.rel) === "child"); const latestUrl = latestLink?.href ? new URL(String(latestLink.href), rootUrl).toString() : rootUrl;
    const payload = latestUrl === rootUrl ? root : await context.fetchJson<{ id?: string; description?: string; links?: Array<Record<string, unknown>> }>(latestUrl, { maximumBytes: 1_000_000 });
    const discoverable = (payload.links ?? []).filter((link) => ["child", "item", "collection", "data", "alternate"].includes(String(link.rel ?? "")));
    const matching = discoverable.filter((link) => `${link.title ?? ""} ${link.rel ?? ""} ${link.href ?? ""}`.toLowerCase().includes(query));
    const references = (matching.length ? matching : discoverable).slice(0, input.limit).flatMap((link) => { const url = link.href ? sourceReferenceUrl(new URL(String(link.href), latestUrl).toString()) : null; return url ? [{ id: stableId(url), title: text(link.title) ?? `${payload.id ?? "Overture"} ${link.rel ?? "resource"}`, url, description: text(payload.description) ?? undefined, license: "Overture dataset-specific open licenses", properties: { rel: link.rel, type: link.type, release: payload.id, queryMatched: matching.length > 0 } }] : []; });
    return { observations: [], references, coverageLimitation: "STAC catalog metadata only. GeoParquet features require an explicit bounded local/cloud spatial query and are never downloaded globally." };
  },
};

export const ripeStatProvider: HunterSourceQueryProvider = {
  sourceId: "ripe.stat", capability: "resource", requires: ["resource"], minimumIntervalMs: 2_000, cacheTtlMs: 15 * 60_000, credentialBroker: false,
  async query(input, context) {
    if (!/^(?:AS\d+|[0-9a-f:.]+(?:\/\d{1,3})?)$/i.test(input.resource!)) throw new Error("RIPEstat requires an exact ASN, IP address, or IP prefix.");
    const resource = input.resource!.toUpperCase(); const endpoints = resource.startsWith("AS") ? ["as-overview", "announced-prefixes", "routing-status", "asn-neighbours"] : ["network-info", "prefix-overview", "routing-status", "geoloc"];
    const references = [];
    for (const endpoint of endpoints) {
      const url = new URL(`https://stat.ripe.net/data/${endpoint}/data.json`); url.searchParams.set("resource", resource); url.searchParams.set("sourceapp", "VoidCat-Harness"); const payload = await context.fetchJson<Record<string, unknown>>(url.toString(), { maximumBytes: 2_000_000 });
      references.push({ id: `${endpoint}:${stableId(resource)}`, title: `RIPEstat ${endpoint} — ${resource}`, url: url.toString(), description: text(payload.message) ?? `Status ${payload.status ?? "unknown"}`, license: "RIPE NCC terms and dataset-specific attribution", properties: { endpoint, status: payload.status, dataCallStatus: payload.data_call_status, data: payload.data } });
    }
    return { observations: [], references, coverageLimitation: "Routing and registry intelligence for one exact resource; IP geolocation is approximate and unrelated to map proximity." };
  },
};

export const peeringDbProvider: HunterSourceQueryProvider = {
  sourceId: "peeringdb.networks", capability: "historical", requires: ["bbox"], minimumIntervalMs: 5_000, cacheTtlMs: HOUR, credentialBroker: false,
  async query(input, context) {
    const url = new URL("https://www.peeringdb.com/api/fac"); url.searchParams.set("limit", String(Math.min(input.limit ?? 100, 250))); url.searchParams.set("depth", "0");
    const payload = await context.fetchJson<{ data?: Array<Record<string, unknown>> }>(url.toString(), { maximumBytes: 5_000_000 });
    const observations = (payload.data ?? []).flatMap((record) => {
      const latitude = number(record.latitude); const longitude = number(record.longitude); if (latitude === null || longitude === null || !inBoundingBox(latitude, longitude, input.bbox)) return []; const id = text(record.id) ?? stableId(JSON.stringify(record));
      return [createQueryObservation({ sourceId: "peeringdb.networks", sourceEventId: `facility:${id}`, entityType: "network-infrastructure.peering-facility", latitude, longitude, observedAt: timestamp(record.updated ?? record.created, context.requestedAt), context, title: text(record.name) ?? `PeeringDB facility ${id}`, confidence: 0.75, sourceUrl: `https://www.peeringdb.com/fac/${encodeURIComponent(id)}`, license: "PeeringDB database license and Acceptable Use Policy", attributes: { city: record.city, country: record.country, address: record.address1, website: record.website, status: record.status, referenceOnly: true, coverageLimitation: "Operator-maintained facility record; not real-time routing state or proof of equipment at a precise point." } })];
    });
    return { observations, coverageLimitation: "PeeringDB facility reference records within the selected extent; operator-maintained and not live network telemetry." };
  },
};

export const INFRASTRUCTURE_QUERY_PROVIDERS = [faaCatalogProvider, marineCadastreProvider, btsNtadProvider, gbfsRegistryProvider, osmOverpassProvider, overtureProvider, ripeStatProvider, peeringDbProvider] as const;
