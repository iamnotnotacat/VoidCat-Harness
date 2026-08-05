/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import { AviationWeatherAdapter } from "../build/hunter-seeker/adapters/aviation-weather-adapter.ts";
import { GdacsEventsAdapter } from "../build/hunter-seeker/adapters/gdacs-events-adapter.ts";
import { GdeltGeoAdapter } from "../build/hunter-seeker/adapters/gdelt-geo-adapter.ts";
import { NoaaNhcAdapter } from "../build/hunter-seeker/adapters/noaa-nhc-adapter.ts";
import { validateNormalizedObservation } from "../build/hunter-seeker/source-adapter.ts";
import { toCommonEvent } from "../build/hunter-seeker/common-event.ts";

const adapters = [new GdacsEventsAdapter(), new NoaaNhcAdapter(), new AviationWeatherAdapter(), new GdeltGeoAdapter()];
const requestedAt = new Date().toISOString();
const results = [];
function providerRecordCount(payload) {
  if (Array.isArray(payload?.features)) return payload.features.length;
  if (Array.isArray(payload?.activeStorms)) return payload.activeStorms.length;
  return null;
}
function providerShape(payload) {
  const feature = Array.isArray(payload?.features) ? payload.features[0] : null;
  if (!feature || typeof feature !== "object") return null;
  const properties = feature.properties && typeof feature.properties === "object" ? feature.properties : {};
  return { featureKeys: Object.keys(feature).sort(), propertyKeys: Object.keys(properties).sort(), geometryType: feature.geometry?.type ?? null };
}
for (const adapter of adapters) {
  try {
    const payload = await adapter.fetch({ requestedAt, signal: AbortSignal.timeout(30_000) });
    const receivedAt = new Date().toISOString();
    const observations = await adapter.normalize(payload, { fetchedAt: receivedAt, receivedAt });
    for (const observation of observations) {
      validateNormalizedObservation(observation, adapter.descriptor.id);
      toCommonEvent(observation);
    }
    const providerRecords = providerRecordCount(payload);
    results.push({ sourceId: adapter.descriptor.id, status: providerRecords !== null && providerRecords > 0 && observations.length === 0 ? "failed" : "ok", providerRecords, observations: observations.length, ...(providerRecords !== null && providerRecords > 0 && observations.length === 0 ? { error: "Provider returned records but none passed normalization.", providerShape: providerShape(payload) } : {}), health: await adapter.health() });
  } catch (error) {
    results.push({ sourceId: adapter.descriptor.id, status: "failed", error: error instanceof Error ? error.message : String(error), health: await adapter.health() });
  }
}
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2));
if (results.some((result) => result.status === "failed")) process.exitCode = 1;
