/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import { SourceAdapterHttpError, type AdapterFetchContext, type AdapterNormalizeContext, type AdapterReportedHealth, type NormalizedObservation, type SourceAdapter, type SourceDescriptor } from "../source-adapter.ts";

export const GDACS_EVENTS_SOURCE_ID = "gdacs.events";
const ENDPOINT = "https://www.gdacs.org/gdacsapi/api/Events/geteventlist/SEARCH";
const MAX_RESPONSE_BYTES = 8_000_000;
const MAX_EVENTS = 2_000;
type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type JsonRecord = Record<string, unknown>;
type GdacsPayload = { features?: unknown[] };

function record(value: unknown): JsonRecord { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}; }
function text(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function number(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }

async function boundedJson(response: Response): Promise<GdacsPayload> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("GDACS response exceeded the 8 MB limit.");
  if (!response.body) throw new Error("GDACS returned an empty response.");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("GDACS response exceeded the 8 MB limit."); } chunks.push(value); } } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as GdacsPayload; } catch { throw new Error("GDACS returned malformed GeoJSON."); }
}

function pointFromGeometry(geometry: JsonRecord) {
  const positions: Array<[number, number]> = [];
  const collect = (value: unknown) => { if (!Array.isArray(value)) return; if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number" && Number.isFinite(value[0]) && Number.isFinite(value[1])) { positions.push([value[0], value[1]]); return; } value.forEach(collect); };
  collect(geometry.coordinates); if (!positions.length) return null;
  const longitude = positions.reduce((sum, position) => sum + position[0], 0) / positions.length;
  const latitude = positions.reduce((sum, position) => sum + position[1], 0) / positions.length;
  return longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90 ? { longitude, latitude } : null;
}

const EVENT_TYPES: Record<string, { entityType: string; eventType: string }> = {
  EQ: { entityType: "natural-event.earthquake", eventType: "earthquake_alert" }, TC: { entityType: "natural-event.storm", eventType: "tropical_cyclone_alert" },
  FL: { entityType: "natural-event.flood", eventType: "flood_alert" }, VO: { entityType: "natural-event.volcano", eventType: "volcano_alert" },
  DR: { entityType: "natural-event.drought", eventType: "drought_alert" }, WF: { entityType: "natural-event.wildfire", eventType: "wildfire_alert" },
};
const ALERT_SEVERITY: Record<string, number> = { Green: 0.25, Orange: 0.65, Red: 0.9 };

export class GdacsEventsAdapter implements SourceAdapter<GdacsPayload> {
  readonly descriptor: SourceDescriptor = {
    id: GDACS_EVENTS_SOURCE_ID, displayName: "GDACS Global Disaster Alerts", category: "environment", authTier: "tier-1", credentialType: "none",
    pollCadenceMs: 15 * 60_000, rateLimit: { requestsPerWindow: 1, windowMs: 5 * 60_000, hardHourlyBudget: 4 },
    providerDocsUrl: "https://www.gdacs.org/Documents/2025/GDACS_API_quickstart_v1.pdf",
    cache: { ttlMs: 30 * 60_000, maxObservations: MAX_EVENTS, replaceOnWrite: true }, healthPolicy: { expectedMinimumObservations: 0, consecutiveBelowExpectedLimit: 3 },
    retentionPolicy: { mode: "live-only" }, estimatedBytesPerDay: 2_000_000,
  };
  private readonly fetchImplementation: FetchImplementation;
  private healthState: AdapterReportedHealth = { status: "degraded", message: "Awaiting the first GDACS refresh." };
  constructor(options: { fetchImplementation?: FetchImplementation } = {}) { this.fetchImplementation = options.fetchImplementation ?? fetch; }

  async fetch(context: AdapterFetchContext) {
    try {
      const response = await this.fetchImplementation(ENDPOINT, { method: "GET", headers: { Accept: "application/geo+json, application/json", "User-Agent": "VoidCat-Harness/1.0 passive-disaster-alerts" }, credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: AbortSignal.any([context.signal, AbortSignal.timeout(20_000)]) });
      if (!response.ok) throw new SourceAdapterHttpError(`GDACS returned HTTP ${response.status}.`, response.status);
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("json") && !contentType.includes("geo+json")) throw new Error(`GDACS returned an unexpected content type: ${contentType || "unknown"}.`);
      const payload = await boundedJson(response); if (!Array.isArray(payload.features)) throw new Error("GDACS GeoJSON did not contain a feature list.");
      this.healthState = { status: "healthy", message: "GDACS disaster alerts are current." }; return payload;
    } catch (error) { this.healthState = { status: error instanceof SourceAdapterHttpError && error.statusCode >= 500 ? "down" : "degraded", message: error instanceof Error ? error.message : "GDACS request failed." }; throw error; }
  }

  normalize(payload: GdacsPayload, context: AdapterNormalizeContext): NormalizedObservation[] {
    const observations = (Array.isArray(payload.features) ? payload.features : []).slice(0, MAX_EVENTS).flatMap((candidate): NormalizedObservation[] => {
      const feature = record(candidate); const properties = record(feature.properties); const geometry = record(feature.geometry); const point = pointFromGeometry(geometry);
      const rawType = text(properties.eventtype ?? properties.eventType)?.toUpperCase(); const mapped = rawType ? EVENT_TYPES[rawType] : undefined;
      const eventIdValue = properties.eventid ?? properties.eventId ?? feature.id;
      const eventId = text(eventIdValue) ?? (number(eventIdValue) === undefined ? undefined : String(number(eventIdValue)));
      if (!point || !mapped || !eventId || !rawType) return [];
      const rawObservedAt = text(properties.fromdate ?? properties.fromDate ?? properties.datemodified ?? properties.dateModified);
      const observedAt = rawObservedAt && Number.isFinite(Date.parse(rawObservedAt)) ? new Date(rawObservedAt).toISOString() : context.fetchedAt;
      const rawPublishedAt = text(properties.datemodified ?? properties.dateModified); const publishedAt = rawPublishedAt && Number.isFinite(Date.parse(rawPublishedAt)) ? new Date(rawPublishedAt).toISOString() : undefined;
      const alertLevel = text(properties.alertlevel ?? properties.alertLevel) ?? "Green"; const alertScore = number(properties.alertscore ?? properties.alertScore);
      const severityScore = alertScore !== undefined ? Math.max(0, Math.min(1, alertScore / 3)) : ALERT_SEVERITY[alertLevel] ?? 0.25;
      const sourceUrl = text(record(properties.url).report ?? properties.url) ?? `https://www.gdacs.org/report.aspx?eventtype=${encodeURIComponent(rawType)}&eventid=${encodeURIComponent(eventId)}`;
      return [{ observationId: `${GDACS_EVENTS_SOURCE_ID}:${rawType}:${eventId}`, entityId: `gdacs-event:${rawType}:${eventId}`, entityType: mapped.entityType,
        position: { latitude: point.latitude, longitude: point.longitude }, timestamp: observedAt,
        provenance: { sourceFeedId: GDACS_EVENTS_SOURCE_ID, fetchedAt: context.fetchedAt, receivedAt: context.receivedAt, ...(rawObservedAt ? { upstreamTimestamp: observedAt } : {}), stalenessMs: Math.max(0, Date.parse(context.receivedAt) - Date.parse(observedAt)) },
        confidence: 0.84, basis: "derived", retentionClass: "bulk",
        attributes: { sourceEventId: eventId, eventType: mapped.eventType, ...(publishedAt ? { publishedAt } : {}), title: text(properties.name ?? properties.eventname ?? properties.eventName) ?? `${rawType} ${eventId}`, severity: alertLevel.toLowerCase(), severityScore, country: text(properties.country), sourceUrl, license: "GDACS data-use and attribution terms", geometry: ["Polygon", "MultiPolygon"].includes(String(geometry.type)) ? geometry : undefined, sourceName: "Global Disaster Alert and Coordination System", coverageLimitation: "GDACS severity is a decision-support estimate. Confirm alerts with responsible national and local authorities." }, rawPayload: feature }];
    });
    this.healthState = { status: "healthy", message: `${observations.length} active GDACS disaster alert${observations.length === 1 ? "" : "s"}.` }; return observations;
  }
  health() { return this.healthState; }
}
