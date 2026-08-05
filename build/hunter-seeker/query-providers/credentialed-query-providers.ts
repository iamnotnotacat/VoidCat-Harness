/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import type { HunterSourceQueryInput, HunterSourceQueryProvider } from "../source-query.ts";
import { DAY, HOUR, MINUTE, createQueryObservation, number, pointFromGeometry, sourceReferenceUrl, stableId, text, timestamp } from "../query-provider-helpers.ts";

type BrokerEnvelope = { data?: unknown; cache?: { status?: unknown; ageMs?: unknown; expiresAt?: unknown } };

async function broker(input: HunterSourceQueryInput, context: Parameters<HunterSourceQueryProvider["query"]>[1]) {
  const envelope = await context.queryCredentialBroker(input, context.signal) as BrokerEnvelope;
  if (!envelope || typeof envelope !== "object" || !("data" in envelope)) throw new Error(`${input.sourceId} returned an invalid protected-provider envelope.`);
  return envelope.data;
}

function records(value: unknown, ...paths: string[]) {
  if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
  let current: unknown = value;
  for (const path of paths) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return [];
    current = (current as Record<string, unknown>)[path];
  }
  return Array.isArray(current) ? current as Array<Record<string, unknown>> : [];
}

function coordinate(record: Record<string, unknown>) {
  const latitude = number(record.latitude ?? record.lat ?? record.Latitude ?? record.LATITUDE ?? record.Y);
  const longitude = number(record.longitude ?? record.lon ?? record.lng ?? record.Longitude ?? record.LONGITUDE ?? record.X);
  return latitude !== null && longitude !== null && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180 ? { latitude, longitude } : null;
}

function bigQueryRecords(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const response = value as { schema?: { fields?: Array<{ name?: unknown }> }; rows?: Array<{ f?: Array<{ v?: unknown }> }> };
  const names = response.schema?.fields?.map((field) => text(field.name) ?? "") ?? [];
  return (response.rows ?? []).map((row) => Object.fromEntries(names.map((name, index) => [name, row.f?.[index]?.v])));
}

export const gdeltEventProvider: HunterSourceQueryProvider = {
  sourceId: "gdelt.events", capability: "historical", requires: ["bbox", "time-window"], minimumIntervalMs: 15 * MINUTE, cacheTtlMs: 15 * MINUTE, credentialBroker: true,
  async query(input, context) {
    const data = await broker(input, context); const items = bigQueryRecords(data);
    const observations = items.flatMap((record) => {
      const point = coordinate(record); if (!point) return [];
      const id = text(record.event_id) ?? stableId(JSON.stringify(record)); const rawDate = text(record.event_date); const observedAt = rawDate && /^\d{8}$/.test(rawDate) ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}T00:00:00.000Z` : context.requestedAt;
      const rootCode = text(record.root_event_code) ?? "unknown"; const location = text(record.location_name) ?? "reported location"; const quadClass = number(record.quad_class);
      return [createQueryObservation({ sourceId: "gdelt.events", sourceEventId: id, entityType: `news-event.gdelt.${rootCode.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, ...point, observedAt, context, title: `GDELT ${text(record.event_code) ?? rootCode} — ${location}`, confidence: 0.5, basis: "derived", severity: quadClass === 4 ? 0.75 : quadClass === 3 ? 0.6 : 0.4, sourceUrl: sourceReferenceUrl(record.source_url), license: "GDELT open-data terms", attributes: { eventCode: record.event_code, baseEventCode: record.base_event_code, rootEventCode: rootCode, quadClass, goldsteinScale: number(record.goldstein_scale), mentions: number(record.mentions), sources: number(record.sources), articles: number(record.articles), averageTone: number(record.average_tone), actionLocation: location, countryCode: record.country_code, coverageLimitation: "Machine-coded news event; classification and geocoding reflect media coverage and require independent corroboration." } })];
    });
    return { observations, coverageLimitation: "Official GDELT BigQuery Event rows for one bounded viewport and time window. Media coverage and machine coding are not ground truth." };
  },
};

export const acledProvider: HunterSourceQueryProvider = {
  sourceId: "acled.events", capability: "historical", requires: ["bbox", "time-window"], minimumIntervalMs: 15 * MINUTE, cacheTtlMs: HOUR, credentialBroker: true,
  async query(input, context) {
    const data = await broker(input, context); const items = records(data, "data");
    const observations = items.flatMap((record) => { const point = coordinate(record); if (!point) return []; const id = text(record.event_id_cnty ?? record.event_id_no_cnty ?? record.event_id) ?? stableId(JSON.stringify(record)); const eventType = text(record.sub_event_type ?? record.event_type) ?? "political event";
      return [createQueryObservation({ sourceId: "acled.events", sourceEventId: id, entityType: `conflict-event.${eventType.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, ...point, observedAt: timestamp(record.event_date ?? record.timestamp, context.requestedAt), context, title: text(record.notes) ?? `${eventType} — ${text(record.location) ?? "reported location"}`, confidence: 0.82, severity: number(record.fatalities), sourceUrl: sourceReferenceUrl(record.source_url) ?? "https://acleddata.com/", license: "ACLED end-user license agreement", attributes: { eventType: record.event_type, subEventType: record.sub_event_type, actors: [record.actor1, record.actor2].filter(Boolean), fatalities: number(record.fatalities), country: record.country, admin1: record.admin1, sourceScale: record.source_scale, coverageLimitation: "ACLED is curated reporting with geographic and publication lag; records are not real-time tactical confirmation." } })]; });
    return { observations, coverageLimitation: "Bounded ACLED date and viewport query; ACLED license and redistribution restrictions apply." };
  },
};

export const ucdpProvider: HunterSourceQueryProvider = {
  sourceId: "ucdp.ged", capability: "historical", requires: ["bbox", "time-window"], minimumIntervalMs: 15 * MINUTE, cacheTtlMs: HOUR, credentialBroker: true,
  async query(input, context) {
    const data = await broker(input, context); const items = records(data, "Result").length ? records(data, "Result") : records(data, "result");
    const observations = items.flatMap((record) => { const point = coordinate(record); if (!point) return []; const id = text(record.id ?? record.event_id) ?? stableId(JSON.stringify(record));
      const deaths = number(record.best) ?? ((number(record.deaths_a) ?? 0) + (number(record.deaths_b) ?? 0) + (number(record.deaths_civilians) ?? 0) + (number(record.deaths_unknown) ?? 0));
      return [createQueryObservation({ sourceId: "ucdp.ged", sourceEventId: id, entityType: "organized-violence.event", ...point, observedAt: timestamp(record.date_start ?? record.date, context.requestedAt), context, title: text(record.where_description ?? record.name) ?? `UCDP event ${id}`, confidence: 0.9, severity: deaths, sourceUrl: "https://ucdp.uu.se/", license: "UCDP terms of use and citation requirements", attributes: { typeOfViolence: record.type_of_violence, sideA: record.side_a, sideB: record.side_b, deathsBest: deaths, country: record.country, sourceArticle: record.source_article, coverageLimitation: "UCDP is curated conflict history and does not represent a real-time tactical feed." } })]; });
    return { observations, coverageLimitation: "UCDP token-scoped, paginated event query over one bounded time window and map area." };
  },
};

export const reliefWebProvider: HunterSourceQueryProvider = {
  sourceId: "reliefweb.reports", capability: "resource", requires: ["query"], minimumIntervalMs: 5 * MINUTE, cacheTtlMs: 30 * MINUTE, credentialBroker: true,
  async query(input, context) {
    const data = await broker(input, context); const items = records(data, "data"); const references = items.map((record) => { const fields = record.fields as Record<string, unknown> | undefined; const id = text(record.id) ?? stableId(JSON.stringify(record)); const url = sourceReferenceUrl(fields?.url_alias ?? fields?.url) ?? `https://reliefweb.int/node/${encodeURIComponent(id)}`; return { id: `reliefweb:${id}`, title: text(fields?.title) ?? `ReliefWeb report ${id}`, url, description: text(fields?.body) ?? undefined, publishedAt: timestamp(fields?.date && typeof fields.date === "object" ? (fields.date as Record<string, unknown>).created : null, context.requestedAt), license: "ReliefWeb API terms and source-specific content rights", properties: { source: fields?.source, country: fields?.country, disaster: fields?.disaster } }; });
    const observations = items.flatMap((record) => { const fields = record.fields as Record<string, unknown> | undefined; const location = Array.isArray(fields?.country) ? fields?.country[0] as Record<string, unknown> : null; const point = location ? coordinate(location) : null; if (!point) return []; const id = text(record.id) ?? stableId(JSON.stringify(record)); return [createQueryObservation({ sourceId: "reliefweb.reports", sourceEventId: id, entityType: "humanitarian.report", ...point, observedAt: timestamp(fields?.date && typeof fields.date === "object" ? (fields.date as Record<string, unknown>).created : null, context.requestedAt), context, title: text(fields?.title) ?? `ReliefWeb report ${id}`, confidence: 0.72, sourceUrl: sourceReferenceUrl(fields?.url_alias ?? fields?.url), license: "ReliefWeb API terms and source-specific content rights", attributes: { source: fields?.source, country: fields?.country, disaster: fields?.disaster, format: fields?.format, coverageLimitation: "Report locations may be country centroids or descriptive rather than incident coordinates." } })]; });
    return { observations, references, coverageLimitation: "Search-selected humanitarian reports; source-specific copyright and location precision apply." };
  },
};

export const noaaCdoProvider: HunterSourceQueryProvider = {
  sourceId: "noaa.cdo", capability: "historical", requires: ["bbox", "time-window", "resource"], minimumIntervalMs: 1_000, cacheTtlMs: DAY, credentialBroker: true,
  async query(input, context) {
    const data = await broker(input, context); const items = records(data, "results");
    const observations = items.flatMap((record) => { const point = coordinate(record); if (!point) return []; const id = `${text(record.station) ?? "station"}:${text(record.date) ?? stableId(JSON.stringify(record))}:${text(record.datatype) ?? "value"}`;
      return [createQueryObservation({ sourceId: "noaa.cdo", sourceEventId: id, entityType: "climate-observation.cdo", ...point, observedAt: timestamp(record.date, context.requestedAt), context, title: `${text(record.datatype) ?? input.resource} ${number(record.value) ?? "—"}`, confidence: 0.9, sourceUrl: "https://www.ncdc.noaa.gov/cdo-web/", license: "NOAA public data", attributes: { datasetId: input.resource, station: record.station, datatype: record.datatype, value: number(record.value), attributes: record.attributes, coverageLimitation: "Historical station observation; quality flags, units, station coverage, and dataset semantics apply." } })]; });
    return { observations, coverageLimitation: "NOAA CDO historical observations for one explicit dataset and bounded time/area query." };
  },
};

export const openAqProvider: HunterSourceQueryProvider = {
  sourceId: "openaq.measurements", capability: "live", requires: ["bbox"], minimumIntervalMs: MINUTE, cacheTtlMs: 30 * MINUTE, credentialBroker: true,
  async query(input, context) {
    const data = await broker(input, context); const items = records(data, "results");
    const observations = items.flatMap((record) => { const coordinates = record.coordinates as Record<string, unknown> | undefined; const point = coordinate(coordinates ?? record); if (!point) return []; const id = text(record.id ?? record.locationId) ?? stableId(JSON.stringify(record)); const latest = record.latest as Record<string, unknown> | undefined;
      return [createQueryObservation({ sourceId: "openaq.measurements", sourceEventId: id, entityType: "air-quality.station", ...point, observedAt: timestamp(latest?.datetime ?? record.datetimeLast, context.requestedAt), context, title: text(record.name) ?? `OpenAQ location ${id}`, confidence: 0.78, sourceUrl: `https://explore.openaq.org/locations/${encodeURIComponent(id)}`, license: "OpenAQ terms and upstream source attribution", attributes: { country: record.country, locality: record.locality, owner: record.owner, sensors: record.sensors, latest, coverageLimitation: "Station density, reporting latency, units, and sensor quality vary by upstream provider." } })]; });
    return { observations, coverageLimitation: "OpenAQ monitoring locations in the selected viewport; absence of records does not imply clean air." };
  },
};

export const airNowProvider: HunterSourceQueryProvider = {
  sourceId: "epa.airnow", capability: "live", requires: ["bbox"], minimumIntervalMs: HOUR, cacheTtlMs: HOUR, credentialBroker: true,
  async query(input, context) {
    const data = await broker(input, context); const observations = records(data).flatMap((record) => { const point = coordinate(record); if (!point) return []; const id = `${text(record.ReportingArea) ?? "area"}:${text(record.ParameterName) ?? "aqi"}:${text(record.DateObserved) ?? context.requestedAt}`;
      return [createQueryObservation({ sourceId: "epa.airnow", sourceEventId: stableId(id), entityType: "air-quality.observation", ...point, observedAt: timestamp(record.DateObserved, context.requestedAt), context, title: `${text(record.ReportingArea) ?? "AirNow"} — ${text(record.ParameterName) ?? "AQI"} ${number(record.AQI) ?? "—"}`, confidence: 0.75, severity: Math.min(1, (number(record.AQI) ?? 0) / 300), sourceUrl: "https://www.airnow.gov/", license: "AirNow data-use guidelines", attributes: { aqi: number(record.AQI), category: record.Category, parameter: record.ParameterName, state: record.StateCode, coverageLimitation: "AirNow observations are preliminary and not fully quality assured." } })]; });
    return { observations, coverageLimitation: "Current AirNow observations for one bounded viewport; preliminary values and monitor gaps apply." };
  },
};

function geoJsonBrokerProvider(sourceId: "gfw.alerts" | "copernicus.dataspace" | "gfw.fishing", entityType: string, license: string, limitation: string): HunterSourceQueryProvider {
  return { sourceId, capability: "historical", requires: ["bbox", "time-window"], minimumIntervalMs: HOUR, cacheTtlMs: HOUR, credentialBroker: true, async query(input, context) {
    const data = await broker(input, context); const items = records(data, "features").length ? records(data, "features") : records(data, "data");
    const observations = items.flatMap((record) => { const properties = (record.properties && typeof record.properties === "object" ? record.properties : record) as Record<string, unknown>; const geometryPoint = pointFromGeometry(record.geometry); const point = geometryPoint ?? coordinate(properties); if (!point) return []; const id = text(record.id ?? properties.id ?? properties.event_id ?? properties.productId) ?? stableId(JSON.stringify(record));
      return [createQueryObservation({ sourceId, sourceEventId: id, entityType, latitude: point.latitude, longitude: point.longitude, ...(geometryPoint?.geometry ? { geometry: geometryPoint.geometry } : {}), observedAt: timestamp(properties.timestamp ?? properties.date ?? properties.start ?? properties.datetime, context.requestedAt), context, title: text(properties.name ?? properties.title ?? properties.event_type ?? properties.productType) ?? `${sourceId} record ${id}`, confidence: sourceId === "gfw.fishing" ? 0.62 : 0.78, sourceUrl: sourceReferenceUrl(properties.url ?? properties.href), license, attributes: { ...properties, coverageLimitation: limitation } })]; });
    return { observations, coverageLimitation: limitation };
  } };
}

export const globalForestWatchProvider = geoJsonBrokerProvider("gfw.alerts", "forest.alert.remote-sensing", "Dataset-specific Global Forest Watch licenses", "Remote-sensing alert, not confirmation of cause; dataset coverage, latency, and license vary.");
export const copernicusDataSpaceProvider = geoJsonBrokerProvider("copernicus.dataspace", "earth-observation.product", "Copernicus Sentinel data legal notice", "Imagery-product metadata only; a product footprint is not itself evidence of a real-world event or change.");
export const globalFishingWatchProvider = geoJsonBrokerProvider("gfw.fishing", "maritime-activity.inferred", "Global Fishing Watch API terms", "Model-inferred maritime activity; it must not be represented as confirmed fishing or illegal behavior.");

export const mobilityDatabaseProvider: HunterSourceQueryProvider = {
  sourceId: "mobility.database", capability: "catalog", requires: ["query"], minimumIntervalMs: 5 * MINUTE, cacheTtlMs: DAY, credentialBroker: true,
  async query(input, context) {
    const data = await broker(input, context); const items = records(data, "feeds").length ? records(data, "feeds") : records(data, "data");
    const references = items.map((record) => { const id = text(record.id ?? record.feed_id) ?? stableId(JSON.stringify(record)); return { id: `mobility:${id}`, title: text(record.name ?? record.provider ?? record.location) ?? `Mobility feed ${id}`, url: sourceReferenceUrl(record.url ?? record.source_url ?? record.feed_url) ?? "https://mobilitydatabase.org/", description: text(record.description) ?? undefined, license: text(record.license) ?? "Feed-specific license", properties: { feedType: record.feed_type, location: record.location, provider: record.provider, status: record.status } }; });
    return { observations: [], references, coverageLimitation: "Feed registry results only. Each operator feed needs separate validation, license review, and bounded polling before use." };
  },
};

export const CREDENTIALED_QUERY_PROVIDERS = [gdeltEventProvider, acledProvider, ucdpProvider, reliefWebProvider, noaaCdoProvider, openAqProvider, airNowProvider, globalForestWatchProvider, copernicusDataSpaceProvider, globalFishingWatchProvider, mobilityDatabaseProvider] as const;
