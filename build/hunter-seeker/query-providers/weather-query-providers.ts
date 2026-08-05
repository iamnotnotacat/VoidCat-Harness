/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import type { HunterSourceQueryProvider } from "../source-query.ts";
import { HOUR, MINUTE, bboxString, createQueryObservation, inBoundingBox, number, parseCsv, pointFromGeometry, sourceReferenceUrl, stableId, text, timestamp } from "../query-provider-helpers.ts";

export const nowCoastProvider: HunterSourceQueryProvider = {
  sourceId: "noaa.nowcoast", capability: "viewport", requires: ["bbox"], minimumIntervalMs: 30_000, cacheTtlMs: 10 * MINUTE, credentialBroker: false,
  async query(_input, context) {
    const capabilities = "https://nowcoast.noaa.gov/geoserver/observations/weather_radar/ows?service=WMS&version=1.3.0&request=GetCapabilities";
    return {
      observations: [],
      references: [{ id: "nowcoast-radar", title: "NOAA nowCOAST weather radar", url: capabilities, description: "Official time-enabled weather radar Web Map Service.", publishedAt: context.requestedAt, license: "NOAA/NWS public data" }],
      overlays: [{ id: "noaa-nowcoast-radar", title: "nowCOAST Radar", type: "raster", tiles: ["https://nowcoast.noaa.gov/geoserver/observations/weather_radar/ows?service=WMS&version=1.3.0&request=GetMap&layers=conus_base_reflectivity_mosaic&styles=&format=image/png&transparent=true&width=256&height=256&crs=EPSG:3857&bbox={bbox-epsg-3857}"], tileSize: 256, opacity: 0.72, attribution: "NOAA nowCOAST / NWS", minimumZoom: 2, maximumZoom: 12 }],
      coverageLimitation: "Radar is an official raster context layer, not a set of discrete event observations.",
    };
  },
};

const SPC_REPORTS = [
  { kind: "tornado", url: "https://www.spc.noaa.gov/climo/reports/today_torn.csv", severity: 0.85 },
  { kind: "hail", url: "https://www.spc.noaa.gov/climo/reports/today_hail.csv", severity: 0.6 },
  { kind: "wind", url: "https://www.spc.noaa.gov/climo/reports/today_wind.csv", severity: 0.55 },
] as const;

export const noaaSpcProvider: HunterSourceQueryProvider = {
  sourceId: "noaa.spc", capability: "live", requires: ["bbox"], minimumIntervalMs: 2 * MINUTE, cacheTtlMs: 10 * MINUTE, credentialBroker: false,
  async query(input, context) {
    const observations = [];
    for (const report of SPC_REPORTS) {
      const rows = parseCsv(await context.fetchText(report.url, { maximumBytes: 1_000_000 }));
      const header = rows[0]?.map((value) => value.trim().toLowerCase()) ?? [];
      const latIndex = header.findIndex((value) => ["lat", "latitude"].includes(value)); const lonIndex = header.findIndex((value) => ["lon", "longitude"].includes(value));
      for (const row of rows.slice(1)) {
        const latitude = number(row[latIndex >= 0 ? latIndex : row.length - 2]); const longitude = number(row[lonIndex >= 0 ? lonIndex : row.length - 1]);
        if (latitude === null || longitude === null || !inBoundingBox(latitude, longitude, input.bbox)) continue;
        const time = row[0] || "unknown"; const location = row[2] || row[1] || "Unspecified location"; const state = row[4] || row[3] || ""; const comments = row[header.findIndex((value) => value.includes("comment"))] || row.at(-1) || "";
        const observedAt = context.requestedAt.slice(0, 10) + "T" + (/^\d{4}$/.test(time) ? `${time.slice(0, 2)}:${time.slice(2)}:00Z` : "00:00:00Z");
        const sourceEventId = stableId(`${report.kind}:${time}:${latitude}:${longitude}:${comments}`);
        observations.push(createQueryObservation({ sourceId: "noaa.spc", sourceEventId, entityType: `weather-report.${report.kind}`, latitude, longitude, observedAt, context, title: `${report.kind.toUpperCase()} — ${location}${state ? `, ${state}` : ""}`, confidence: 0.66, basis: "measured", severity: report.severity, sourceUrl: report.url, license: "NOAA/NWS public data", attributes: { reportType: report.kind, preliminary: true, comments, location, state, coverageLimitation: "Preliminary local storm report; duplicate reports and later corrections are possible." } }));
      }
    }
    return { observations, coverageLimitation: "Today-only preliminary tornado, wind, and hail reports from SPC; not a verified damage inventory." };
  },
};

export const noaaCoopsProvider: HunterSourceQueryProvider = {
  sourceId: "noaa.coops", capability: "viewport", requires: ["bbox"], minimumIntervalMs: MINUTE, cacheTtlMs: 6 * MINUTE, credentialBroker: false,
  async query(input, context) {
    if (input.resource) {
      const station = encodeURIComponent(input.resource);
      const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=water_level&date=latest&datum=MLLW&station=${station}&time_zone=gmt&units=metric&format=json&application=VoidCat-Harness`;
      const payload = await context.fetchJson<{ metadata?: Record<string, unknown>; data?: Array<Record<string, unknown>> }>(url, { maximumBytes: 500_000 });
      const metadata = payload.metadata ?? {}; const reading = payload.data?.[0] ?? {}; const latitude = number(metadata.lat); const longitude = number(metadata.lon);
      return { observations: latitude === null || longitude === null ? [] : [createQueryObservation({ sourceId: "noaa.coops", sourceEventId: `${input.resource}:${reading.t ?? context.requestedAt}`, entityType: "coastal-observation.water-level", latitude, longitude, observedAt: timestamp(reading.t, context.requestedAt), context, title: `${metadata.name ?? input.resource} water level`, confidence: text(reading.f)?.includes("1") ? 0.6 : 0.9, sourceUrl: `https://tidesandcurrents.noaa.gov/stationhome.html?id=${station}`, license: "NOAA public data", attributes: { stationId: input.resource, stationName: metadata.name, waterLevelMeters: number(reading.v), sigma: number(reading.s), flags: reading.f, datum: "MLLW", coverageLimitation: "Latest station reading; datum and quality flags must be considered." } })], coverageLimitation: "One explicitly selected CO-OPS station reading." };
    }
    const payload = await context.fetchJson<{ stations?: Array<Record<string, unknown>> }>("https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=waterlevels&units=metric", { maximumBytes: 5_000_000 });
    const observations = (payload.stations ?? []).flatMap((station) => {
      const latitude = number(station.lat); const longitude = number(station.lng ?? station.lon); if (latitude === null || longitude === null || !inBoundingBox(latitude, longitude, input.bbox)) return [];
      const id = text(station.id) ?? stableId(JSON.stringify(station));
      return [createQueryObservation({ sourceId: "noaa.coops", sourceEventId: `station:${id}`, entityType: "coastal-station.water-level", latitude, longitude, observedAt: context.requestedAt, context, title: text(station.name) ?? `CO-OPS ${id}`, confidence: 0.98, sourceUrl: `https://tidesandcurrents.noaa.gov/stationhome.html?id=${encodeURIComponent(id)}`, license: "NOAA public data", attributes: { stationId: id, state: station.state, timezone: station.timezone, referenceOnly: true, coverageLimitation: "Station position; select this station to request its latest water-level observation." } })];
    });
    return { observations, coverageLimitation: "Station index only until an operator selects a station for a current reading." };
  },
};

export const noaaNceiProvider: HunterSourceQueryProvider = {
  sourceId: "noaa.ncei", capability: "historical", requires: ["bbox", "time-window", "resource"], minimumIntervalMs: 10_000, cacheTtlMs: HOUR, credentialBroker: false,
  async query(input, context) {
    const url = new URL("https://www.ncei.noaa.gov/access/services/data/v1");
    const station = input.resource!.trim().toUpperCase(); if (!/^[A-Z0-9_-]{5,24}$/.test(station)) throw new Error("NCEI requires one exact station identifier, such as USW00013967.");
    url.searchParams.set("dataset", "daily-summaries"); url.searchParams.set("stations", station); url.searchParams.set("startDate", input.startAt!.slice(0, 10)); url.searchParams.set("endDate", input.endAt!.slice(0, 10)); url.searchParams.set("format", "json"); url.searchParams.set("units", "metric"); url.searchParams.set("includeAttributes", "true"); url.searchParams.set("includeStationName", "true"); url.searchParams.set("includeStationLocation", "true");
    const records = await context.fetchJson<Array<Record<string, unknown>>>(url.toString(), { maximumBytes: 6_000_000 });
    const observations = records.flatMap((record) => {
      const latitude = number(record.LATITUDE ?? record.latitude); const longitude = number(record.LONGITUDE ?? record.longitude); if (latitude === null || longitude === null) return [];
      if (!inBoundingBox(latitude, longitude, input.bbox)) return [];
      const stationId = text(record.STATION) ?? stableId(JSON.stringify(record)); const observedAt = timestamp(record.DATE, context.requestedAt);
      return [createQueryObservation({ sourceId: "noaa.ncei", sourceEventId: `${stationId}:${observedAt}`, entityType: "climate-observation.daily-summary", latitude, longitude, observedAt, context, title: text(record.NAME) ?? `NCEI ${stationId}`, confidence: 0.9, sourceUrl: "https://www.ncei.noaa.gov/access", license: "NOAA public data", attributes: { stationId, dataset: "daily-summaries", values: record, coverageLimitation: "Historical station summary; missing values and station coverage vary. Results outside the selected viewport are excluded." } })];
    });
    return { observations, coverageLimitation: "NCEI daily summaries for one exact station and bounded time window; station must also fall inside the selected viewport." };
  },
};

export const openMeteoProvider: HunterSourceQueryProvider = {
  sourceId: "openmeteo.weather", capability: "viewport", requires: ["point"], minimumIntervalMs: 5_000, cacheTtlMs: 15 * MINUTE, credentialBroker: false,
  async query(input, context) {
    const point = input.point!; const url = new URL("https://api.open-meteo.com/v1/forecast"); url.searchParams.set("latitude", String(point.latitude)); url.searchParams.set("longitude", String(point.longitude)); url.searchParams.set("current", "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,showers,snowfall,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m"); url.searchParams.set("timezone", "UTC");
    const payload = await context.fetchJson<Record<string, unknown>>(url.toString(), { maximumBytes: 500_000 }); const current = payload.current as Record<string, unknown> | undefined;
    if (!current) return { observations: [], coverageLimitation: "The model returned no current grid-cell estimate." };
    const observedAt = timestamp(current.time, context.requestedAt); const weatherCode = number(current.weather_code);
    return { observations: [createQueryObservation({ sourceId: "openmeteo.weather", sourceEventId: `${point.latitude.toFixed(4)}:${point.longitude.toFixed(4)}:${observedAt}`, entityType: "weather-model.current-conditions", latitude: number(payload.latitude) ?? point.latitude, longitude: number(payload.longitude) ?? point.longitude, observedAt, context, title: `Open-Meteo current conditions`, confidence: 0.7, basis: "estimated", severity: weatherCode !== null && weatherCode >= 95 ? 0.75 : weatherCode !== null && weatherCode >= 61 ? 0.5 : 0.2, sourceUrl: url.toString(), license: "CC BY 4.0; Open-Meteo and upstream model attribution required", attributes: { ...current, units: payload.current_units, modelGridElevation: payload.elevation, timezone: payload.timezone, coverageLimitation: "Modeled grid-cell estimate, not a direct instrument measurement." } })], coverageLimitation: "Current modeled conditions at one explicitly selected point." };
  },
};

export const metNorwayProvider: HunterSourceQueryProvider = {
  sourceId: "metno.locationforecast", capability: "viewport", requires: ["point"], minimumIntervalMs: 10_000, cacheTtlMs: 30 * MINUTE, credentialBroker: false,
  async query(input, context) {
    const point = input.point!; const url = new URL("https://api.met.no/weatherapi/locationforecast/2.0/compact"); url.searchParams.set("lat", point.latitude.toFixed(4)); url.searchParams.set("lon", point.longitude.toFixed(4));
    const payload = await context.fetchJson<{ geometry?: unknown; properties?: { timeseries?: Array<Record<string, unknown>>; meta?: unknown } }>(url.toString(), { maximumBytes: 2_000_000 }); const first = payload.properties?.timeseries?.[0]; const position = pointFromGeometry(payload.geometry) ?? point;
    if (!first) return { observations: [], coverageLimitation: "MET Norway returned no forecast timestep." };
    const data = first.data as Record<string, unknown> | undefined; const instant = (data?.instant as Record<string, unknown> | undefined)?.details as Record<string, unknown> | undefined;
    return { observations: [createQueryObservation({ sourceId: "metno.locationforecast", sourceEventId: `${point.latitude.toFixed(4)}:${point.longitude.toFixed(4)}:${first.time}`, entityType: "weather-model.location-forecast", latitude: position.latitude, longitude: position.longitude, observedAt: timestamp(first.time, context.requestedAt), context, title: "MET Norway location forecast", confidence: 0.72, basis: "estimated", sourceUrl: url.toString(), license: "Norwegian Meteorological Institute data license", attributes: { instant, nextHour: data?.next_1_hours, nextSixHours: data?.next_6_hours, modelMeta: payload.properties?.meta, coverageLimitation: "Modeled forecast at the nearest grid point, not a direct measurement." } })], coverageLimitation: "One identified, cacheable location forecast at the selected point." };
  },
};

export const environmentCanadaProvider: HunterSourceQueryProvider = {
  sourceId: "eccc.geomet", capability: "viewport", requires: ["bbox"], minimumIntervalMs: 30_000, cacheTtlMs: 10 * MINUTE, credentialBroker: false,
  async query(input, context) {
    const url = new URL("https://api.weather.gc.ca/collections/weather-alerts/items"); url.searchParams.set("f", "json"); url.searchParams.set("bbox", bboxString(input.bbox!)); url.searchParams.set("limit", String(input.limit));
    const payload = await context.fetchJson<{ features?: Array<{ id?: unknown; geometry?: unknown; properties?: Record<string, unknown> }> }>(url.toString(), { maximumBytes: 5_000_000 });
    const observations = (payload.features ?? []).flatMap((feature) => {
      const point = pointFromGeometry(feature.geometry); if (!point) return []; const properties = feature.properties ?? {}; const id = text(feature.id) ?? text(properties.id) ?? stableId(JSON.stringify(feature)); const headline = text(properties.headline_en ?? properties.alert_name_en ?? properties.title) ?? "Environment Canada weather alert";
      return [createQueryObservation({ sourceId: "eccc.geomet", sourceEventId: id, entityType: "weather-alert.environment-canada", latitude: point.latitude, longitude: point.longitude, geometry: point.geometry, observedAt: timestamp(properties.sent ?? properties.published ?? properties.datetime, context.requestedAt), context, title: headline, confidence: 0.9, basis: "measured", severity: text(properties.severity)?.toLowerCase() === "extreme" ? 1 : text(properties.severity)?.toLowerCase() === "severe" ? 0.75 : 0.5, sourceUrl: sourceReferenceUrl(properties.url), license: "Open Government Licence - Canada", attributes: { ...properties, coverageLimitation: "Official alert geometry and language may be regional or coarse; consult the issuing authority." } })];
    });
    return { observations, coverageLimitation: "Official Canadian weather-alert collection within the selected map extent." };
  },
};

export const WEATHER_QUERY_PROVIDERS = [nowCoastProvider, noaaSpcProvider, noaaCoopsProvider, noaaNceiProvider, openMeteoProvider, metNorwayProvider, environmentCanadaProvider] as const;
