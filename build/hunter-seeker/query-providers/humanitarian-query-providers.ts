/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import type { HunterSourceQueryProvider } from "../source-query.ts";
import { HOUR, createQueryObservation, inBoundingBox, pointFromWkt, sourceReferenceUrl, stableId, text, timestamp } from "../query-provider-helpers.ts";

const STATE_CENTROIDS: Record<string, [number, number]> = {
  AL: [-86.9023, 32.3182], AK: [-152.4044, 61.3707], AZ: [-111.0937, 34.0489], AR: [-92.3731, 34.9697], CA: [-119.4179, 36.7783], CO: [-105.7821, 39.5501], CT: [-72.7554, 41.6032], DE: [-75.5277, 38.9108], DC: [-77.0369, 38.9072], FL: [-81.5158, 27.6648], GA: [-82.9001, 32.1656], HI: [-155.5828, 19.8968], ID: [-114.7420, 44.0682], IL: [-89.3985, 40.6331], IN: [-86.1349, 40.2672], IA: [-93.0977, 41.8780], KS: [-98.4842, 39.0119], KY: [-84.2700, 37.8393], LA: [-91.9623, 30.9843], ME: [-69.4455, 45.2538], MD: [-76.6413, 39.0458], MA: [-71.3824, 42.4072], MI: [-85.6024, 44.3148], MN: [-94.6859, 46.7296], MS: [-89.3985, 32.3547], MO: [-91.8318, 37.9643], MT: [-110.3626, 46.8797], NE: [-99.9018, 41.4925], NV: [-116.4194, 38.8026], NH: [-71.5724, 43.1939], NJ: [-74.4057, 40.0583], NM: [-105.8701, 34.5199], NY: [-75.4999, 43.0000], NC: [-79.0193, 35.7596], ND: [-101.0020, 47.5515], OH: [-82.9071, 40.4173], OK: [-97.0929, 35.0078], OR: [-120.5542, 43.8041], PA: [-77.1945, 41.2033], PR: [-66.5901, 18.2208], RI: [-71.4774, 41.5801], SC: [-80.8987, 33.8361], SD: [-99.9018, 43.9695], TN: [-86.5804, 35.5175], TX: [-99.9018, 31.9686], UT: [-111.0937, 39.3210], VT: [-72.5778, 44.5588], VA: [-78.6569, 37.4316], WA: [-120.7401, 47.7511], WV: [-80.4549, 38.5976], WI: [-89.6165, 43.7844], WY: [-107.2903, 43.0760], VI: [-64.8963, 18.3358], GU: [144.7937, 13.4443], AS: [-170.1322, -14.2710], MP: [145.6739, 15.0979], FM: [158.2151, 6.8874], MH: [171.1845, 7.1315], PW: [134.5825, 7.5150], UM: [-162.5, 19.3], NA: [-98.5795, 39.8283], ZZ: [-98.5795, 39.8283],
};

function ckanReferenceProvider(sourceId: "hdx.catalog" | "jrc.catalog", endpoint: string, license: string): HunterSourceQueryProvider {
  return { sourceId, capability: "catalog", requires: ["query"], minimumIntervalMs: 5_000, cacheTtlMs: HOUR, credentialBroker: false, async query(input, context) {
    const url = new URL(endpoint); url.searchParams.set("q", input.query!); url.searchParams.set("rows", String(input.limit));
    const payload = await context.fetchJson<{ success?: boolean; result?: { results?: Array<Record<string, unknown>> } }>(url.toString(), { maximumBytes: 3_000_000 });
    const references = (payload.result?.results ?? []).map((record) => ({ id: text(record.id) ?? stableId(JSON.stringify(record)), title: text(record.title) ?? text(record.name) ?? "Untitled dataset", url: sourceReferenceUrl(record.url) ?? `${new URL(endpoint).origin}/dataset/${encodeURIComponent(text(record.name) ?? text(record.id) ?? "")}`, description: text(record.notes) ?? undefined, publishedAt: timestamp(record.metadata_modified, context.requestedAt), license: text(record.license_title) ?? license, properties: { organization: record.organization, tags: record.tags, resources: Array.isArray(record.resources) ? record.resources.length : 0 } }));
    return { observations: [], references, coverageLimitation: "Catalog metadata only. Dataset contents load only after explicit resource selection and license review." };
  } };
}

export const hdxCatalogProvider = ckanReferenceProvider("hdx.catalog", "https://data.humdata.org/api/3/action/package_search", "Dataset-specific HDX licenses");
export const jrcCatalogProvider: HunterSourceQueryProvider = {
  sourceId: "jrc.catalog", capability: "catalog", requires: ["query"], minimumIntervalMs: 5_000, cacheTtlMs: HOUR, credentialBroker: false,
  async query(input, context) {
    const url = new URL("https://data.europa.eu/api/hub/search/search"); url.searchParams.set("q", input.query!); url.searchParams.set("filters", "dataset"); url.searchParams.set("facets", JSON.stringify({ catalog: ["jrc"] })); url.searchParams.set("limit", String(input.limit));
    const payload = await context.fetchJson<{ result?: { results?: Array<Record<string, unknown>> } }>(url.toString(), { maximumBytes: 4_000_000 });
    const localized = (value: unknown) => { if (typeof value === "string") return text(value); if (!value || typeof value !== "object" || Array.isArray(value)) return null; const values = value as Record<string, unknown>; return text(values.en) ?? Object.values(values).map(text).find(Boolean) ?? null; };
    const references = (payload.result?.results ?? []).filter((record) => (record.catalog as Record<string, unknown> | undefined)?.id === "jrc").flatMap((record) => {
      const identifiers = Array.isArray(record.identifier) ? record.identifier : []; const identifier = text(identifiers[0]) ?? text(record.id); if (!identifier) return [];
      const id = identifier.replace(/^.*\//, ""); const landing = Array.isArray(record.landing_page) ? record.landing_page : []; const landingUrl = landing.map((entry) => sourceReferenceUrl(typeof entry === "string" ? entry : (entry as Record<string, unknown>)?.resource ?? (entry as Record<string, unknown>)?.id)).find(Boolean);
      return [{ id, title: localized(record.title) ?? `JRC dataset ${id}`, url: landingUrl ?? `https://data.jrc.ec.europa.eu/dataset/${encodeURIComponent(id)}`, description: localized(record.description) ?? undefined, publishedAt: timestamp(record.modified ?? record.issued, context.requestedAt), license: "Dataset-specific European Commission licenses", properties: { identifier, catalog: "jrc", keywords: record.keywords, distributions: record.distributions } }];
    });
    return { observations: [], references, coverageLimitation: "JRC metadata discovered through the official EU read-only search API. Open a selected dataset to review its data service, schema, and license." };
  },
};

export const openFemaProvider: HunterSourceQueryProvider = {
  sourceId: "openfema.disasters", capability: "historical", requires: ["bbox"], minimumIntervalMs: 10_000, cacheTtlMs: HOUR, credentialBroker: false,
  async query(input, context) {
    const url = new URL("https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries");
    url.searchParams.set("$top", String(input.limit)); url.searchParams.set("$orderby", "declarationDate desc");
    if (input.query) url.searchParams.set("$filter", `contains(declarationTitle, '${input.query.replaceAll("'", "''")}')`);
    const payload = await context.fetchJson<{ DisasterDeclarationsSummaries?: Array<Record<string, unknown>> }>(url.toString(), { maximumBytes: 3_000_000 });
    const observations = (payload.DisasterDeclarationsSummaries ?? []).flatMap((record) => {
      const state = text(record.state)?.toUpperCase(); const centroid = state ? STATE_CENTROIDS[state] : null;
      if (!centroid || !inBoundingBox(centroid[1], centroid[0], input.bbox)) return [];
      const id = text(record.id) ?? `${record.disasterNumber}:${record.fipsStateCode}:${record.fipsCountyCode ?? "state"}`;
      return [createQueryObservation({ sourceId: "openfema.disasters", sourceEventId: id, entityType: "administrative-event.disaster-declaration", latitude: centroid[1], longitude: centroid[0], observedAt: timestamp(record.declarationDate, context.requestedAt), context, title: text(record.declarationTitle) ?? `FEMA declaration ${record.disasterNumber}`, confidence: 0.98, basis: "measured", sourceUrl: `https://www.fema.gov/disaster/${encodeURIComponent(String(record.disasterNumber ?? ""))}`, license: "U.S. government public data", attributes: { disasterNumber: record.disasterNumber, state, declarationType: record.declarationType, incidentType: record.incidentType, incidentBeginDate: record.incidentBeginDate, incidentEndDate: record.incidentEndDate, designatedArea: record.designatedArea, geometryPrecision: "state-centroid", coverageLimitation: "Administrative declaration plotted at the state or territory centroid, not the disaster footprint." } })];
    });
    return { observations, coverageLimitation: "FEMA declarations are administrative records and use coarse state-centroid geometry here." };
  },
};

export const copernicusEmsProvider: HunterSourceQueryProvider = {
  sourceId: "copernicus.ems", capability: "historical", requires: ["bbox"], minimumIntervalMs: 30_000, cacheTtlMs: HOUR, credentialBroker: false,
  async query(input, context) {
    const url = new URL("https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api/public-activations-info/"); url.searchParams.set("limit", String(input.limit)); url.searchParams.set("offset", "0");
    const payload = await context.fetchJson<{ results?: Array<Record<string, unknown>> }>(url.toString(), { maximumBytes: 3_000_000 });
    const observations = (payload.results ?? []).flatMap((record) => {
      const point = pointFromWkt(record.centroid); if (!point || !inBoundingBox(point.latitude, point.longitude, input.bbox)) return [];
      const code = text(record.code) ?? stableId(JSON.stringify(record)); const category = text(record.category) ?? "emergency";
      return [createQueryObservation({ sourceId: "copernicus.ems", sourceEventId: code, entityType: `emergency-mapping.${category.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`, latitude: point.latitude, longitude: point.longitude, observedAt: timestamp(record.eventTime ?? record.activationTime, context.requestedAt), context, title: text(record.name) ?? code, confidence: 0.9, basis: "derived", sourceUrl: `https://mapping.emergency.copernicus.eu/activations/${encodeURIComponent(code)}`, license: "Copernicus Emergency Management Service terms", attributes: { category, countries: record.countries, activationTime: record.activationTime, lastUpdate: record.lastUpdate, closed: record.closed, areasOfInterest: record.n_aois, products: record.n_products, gdacsId: record.gdacsId, coverageLimitation: "Activation centroid represents the mapping task, not the full affected footprint or independent confirmation of damage." } })];
    });
    return { observations, coverageLimitation: "Public Rapid Mapping activations plotted at their official activation centroids." };
  },
};

export const HUMANITARIAN_QUERY_PROVIDERS = [hdxCatalogProvider, jrcCatalogProvider, openFemaProvider, copernicusEmsProvider] as const;
