/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import type { HunterSourceQueryProvider } from "../source-query.ts";
import { HOUR, createQueryObservation, number, pointFromGeometry, sourceReferenceUrl, stableId, text, timestamp } from "../query-provider-helpers.ts";

export const envirofactsProvider: HunterSourceQueryProvider = {
  sourceId: "epa.envirofacts", capability: "historical", requires: ["resource"], minimumIntervalMs: 10_000, cacheTtlMs: HOUR, credentialBroker: false,
  async query(input, context) {
    if (!/^[A-Z]{2}$/i.test(input.resource!)) throw new Error("Envirofacts requires an exact two-letter U.S. state or territory code.");
    const state = input.resource!.toUpperCase();
    const url = `https://data.epa.gov/dmapservice/frs.frs_facility_site/state_code/equals/${state}/1:${Math.min(input.limit ?? 100, 200)}/json`;
    const records = await context.fetchJson<Array<Record<string, unknown>>>(url, { maximumBytes: 5_000_000 });
    const observations = records.flatMap((record) => {
      const latitude = number(record.latitude83 ?? record.latitude ?? record.latitude_measure); const longitude = number(record.longitude83 ?? record.longitude ?? record.longitude_measure); if (latitude === null || longitude === null) return [];
      const id = text(record.registry_id ?? record.facility_site_id) ?? stableId(JSON.stringify(record));
      return [createQueryObservation({ sourceId: "epa.envirofacts", sourceEventId: id, entityType: "environmental-facility.epa-frs", latitude, longitude, observedAt: timestamp(record.last_reported_date ?? record.update_date, context.requestedAt), context, title: text(record.primary_name ?? record.facility_name) ?? `EPA facility ${id}`, confidence: 0.86, sourceUrl: `https://enviro.epa.gov/envirofacts/frs/facilities/FRS-${encodeURIComponent(id)}`, license: "U.S. EPA public data", attributes: { state, city: record.city_name ?? record.city, programs: record.program_system_acrnm, facilityType: record.site_type_name, record, coverageLimitation: "Regulatory facility location; not evidence of a current release, violation, or hazard." } })];
    });
    return { observations, coverageLimitation: "EPA Facility Registry records for one explicitly selected state; facilities are not live incidents." };
  },
};

export const epaEchoProvider: HunterSourceQueryProvider = {
  sourceId: "epa.echo", capability: "historical", requires: ["point"], minimumIntervalMs: 10_000, cacheTtlMs: HOUR, credentialBroker: false,
  async query(input, context) {
    const point = input.point!; const radius = Math.min(100, Math.max(1, point.radiusKm ?? 50));
    const url = new URL("https://echodata.epa.gov/echo/cwa_rest_services.get_facilities"); url.searchParams.set("output", "JSON"); url.searchParams.set("p_lat", String(point.latitude)); url.searchParams.set("p_long", String(point.longitude)); url.searchParams.set("p_radius", String(radius)); url.searchParams.set("responseset", String(Math.min(input.limit ?? 100, 200)));
    const payload = await context.fetchJson<Record<string, unknown>>(url.toString(), { maximumBytes: 5_000_000 });
    const results = ((payload.Results ?? payload.results) as Record<string, unknown> | undefined)?.Facilities ?? payload.Facilities ?? [];
    const observations = (Array.isArray(results) ? results : []).flatMap((record: Record<string, unknown>) => {
      const latitude = number(record.FacLat ?? record.Latitude ?? record.latitude); const longitude = number(record.FacLong ?? record.Longitude ?? record.longitude); if (latitude === null || longitude === null) return [];
      const id = text(record.RegistryID ?? record.SourceID ?? record.FacilityId) ?? stableId(JSON.stringify(record));
      return [createQueryObservation({ sourceId: "epa.echo", sourceEventId: id, entityType: "environmental-compliance.facility", latitude, longitude, observedAt: context.requestedAt, context, title: text(record.FacName ?? record.FacilityName) ?? `ECHO facility ${id}`, confidence: 0.88, sourceUrl: `https://echo.epa.gov/detailed-facility-report?fid=${encodeURIComponent(id)}`, license: "U.S. EPA public data", attributes: { registryId: id, complianceStatus: record.CurrSvFlag ?? record.CurrVioStatus, inspections: record.InspCount, formalActions: record.FormalActionCount, penalties: record.PenaltyAmt, record, coverageLimitation: "Compliance data may lag and must be interpreted by program, reporting period, and enforcement status." } })];
    });
    return { observations, coverageLimitation: "Bounded ECHO facility search; records are regulatory history, not live hazards." };
  },
};

export const epaRadNetProvider: HunterSourceQueryProvider = {
  sourceId: "epa.radnet", capability: "live", requires: ["bbox"], minimumIntervalMs: 30 * 60_000, cacheTtlMs: HOUR, credentialBroker: false,
  async query(input, context) {
    const url = new URL("https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/EPA_Radiation_Air_Monitors/FeatureServer/0/query"); url.searchParams.set("f", "geojson"); url.searchParams.set("where", "1=1"); url.searchParams.set("outFields", "*"); url.searchParams.set("geometry", `${input.bbox!.west},${input.bbox!.south},${input.bbox!.east},${input.bbox!.north}`); url.searchParams.set("geometryType", "esriGeometryEnvelope"); url.searchParams.set("inSR", "4326"); url.searchParams.set("spatialRel", "esriSpatialRelIntersects"); url.searchParams.set("resultRecordCount", String(input.limit));
    const payload = await context.fetchJson<{ features?: Array<{ id?: unknown; geometry?: unknown; properties?: Record<string, unknown> }> }>(url.toString(), { maximumBytes: 3_000_000 });
    const observations = (payload.features ?? []).flatMap((feature) => {
      const point = pointFromGeometry(feature.geometry); if (!point) return []; const properties = feature.properties ?? {}; const id = text(properties.STATION_ID ?? properties.LOCATION_ID ?? properties.OBJECTID ?? feature.id) ?? stableId(JSON.stringify(feature)); const city = text(properties.CITY ?? properties.LOCATION) ?? `RadNet monitor ${id}`; const state = text(properties.STATE_ABBR ?? properties.STATE) ?? "";
      return [createQueryObservation({ sourceId: "epa.radnet", sourceEventId: `monitor:${id}`, entityType: "radiation-monitor.radnet", latitude: point.latitude, longitude: point.longitude, observedAt: context.requestedAt, context, title: `${city}${state ? `, ${state}` : ""}`, confidence: 0.98, sourceUrl: "https://www.epa.gov/radnet/radnet-csv-file-downloads", license: "U.S. EPA public data", attributes: { ...properties, referenceOnly: true, coverageLimitation: "Monitor location. Near-real-time values remain subject to EPA quality checks and are retrieved per station, not by bulk polling." } })];
    });
    return { observations, coverageLimitation: "Official RadNet monitor locations; values are not synthesized from station presence." };
  },
};

export const safecastProvider: HunterSourceQueryProvider = {
  sourceId: "safecast.measurements", capability: "viewport", requires: ["point"], minimumIntervalMs: 30_000, cacheTtlMs: HOUR, credentialBroker: false,
  async query(input, context) {
    const point = input.point!; const radius = Math.min(100, Math.max(1, point.radiusKm ?? 25)); const url = new URL("https://api.safecast.org/measurements.json"); url.searchParams.set("latitude", String(point.latitude)); url.searchParams.set("longitude", String(point.longitude)); url.searchParams.set("distance", String(radius)); url.searchParams.set("order", "captured_at desc"); url.searchParams.set("per_page", String(Math.min(input.limit ?? 100, 100)));
    const records = await context.fetchJson<Array<Record<string, unknown>>>(url.toString(), { maximumBytes: 3_000_000 });
    const observations = records.flatMap((record) => {
      const latitude = number(record.latitude); const longitude = number(record.longitude); if (latitude === null || longitude === null) return [];
      const id = text(record.id) ?? stableId(JSON.stringify(record)); const unit = text(record.unit) ?? "unknown"; const value = number(record.value);
      return [createQueryObservation({ sourceId: "safecast.measurements", sourceEventId: id, entityType: "environmental-measurement.crowdsourced", latitude, longitude, observedAt: timestamp(record.captured_at, context.requestedAt), context, title: `Safecast ${value ?? "—"} ${unit}`, confidence: 0.55, sourceUrl: sourceReferenceUrl(record.original_id) ?? "https://safecast.org/", license: "Safecast dataset license (verify record metadata)", attributes: { value, unit, deviceId: record.device_id, userId: record.user_id, md5sum: record.md5sum, measurementType: record.measurement_type, coverageLimitation: "Crowdsourced sensor measurement; calibration, placement, duplication, and sampling density vary." } })];
    });
    return { observations, coverageLimitation: "Crowdsourced measurements near one selected point; do not infer regional absence from sparse coverage." };
  },
};

export const ENVIRONMENT_QUERY_PROVIDERS = [envirofactsProvider, epaEchoProvider, epaRadNetProvider, safecastProvider] as const;
