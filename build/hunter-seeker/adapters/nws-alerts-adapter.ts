/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import {
  SourceAdapterHttpError,
  type AdapterFetchContext,
  type AdapterNormalizeContext,
  type AdapterReportedHealth,
  type NormalizedObservation,
  type SourceAdapter,
  type SourceDescriptor,
} from "../source-adapter.ts";

export const NWS_ALERTS_SOURCE_ID = "noaa.nws-alerts";
export const NWS_ACTIVE_ALERTS_URL = "https://api.weather.gov/alerts/active";
export const NWS_USER_AGENT = "VoidCat-Harness/0.1 (local desktop application)";
const MAX_RESPONSE_BYTES = 12_000_000;
const REQUEST_TIMEOUT_MS = 20_000;

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type JsonRecord = Record<string, unknown>;
type Position = [number, number];
type SupportedGeometry = {
  type: "Polygon" | "MultiPolygon";
  coordinates: unknown[];
};

export type NwsAlertFeatureCollection = {
  type: "FeatureCollection";
  features: unknown[];
  title?: string;
  updated?: string;
};

export const NWS_ALERTS_DESCRIPTOR: SourceDescriptor = {
  id: NWS_ALERTS_SOURCE_ID,
  displayName: "NOAA/NWS Active Alerts",
  category: "weather",
  authTier: "tier-1",
  credentialType: "none",
  pollCadenceMs: 2 * 60_000,
  // NWS recommends requests no more often than every 30 seconds. VoidCat
  // defaults to two minutes while preserving that provider-side floor.
  rateLimit: { requestsPerWindow: 1, windowMs: 30_000, hardHourlyBudget: 120 },
  providerDocsUrl: "https://www.weather.gov/documentation/services-web-alerts",
  cache: { ttlMs: 10 * 60_000, maxObservations: 10_000 },
  healthPolicy: { expectedMinimumObservations: 1, consecutiveBelowExpectedLimit: 3 },
  retentionPolicy: { mode: "live-only" },
  estimatedBytesPerDay: 10_000_000_000,
};

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function truncatedString(value: unknown, maximumLength = 4_000) {
  const text = optionalString(value);
  return text ? text.slice(0, maximumLength) : undefined;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isoTimestamp(...values: unknown[]) {
  for (const value of values) {
    const text = optionalString(value);
    if (text && Number.isFinite(Date.parse(text))) return new Date(text).toISOString();
  }
  return "";
}

function retryAfterMilliseconds(value: string | null) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function readBoundedJson(response: Response, maximumBytes: number) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel();
    throw new Error(`NWS response exceeds the ${maximumBytes.toLocaleString()} byte safety limit.`);
  }
  if (!response.body) throw new Error("NWS returned an empty response body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw new Error(`NWS response exceeds the ${maximumBytes.toLocaleString()} byte safety limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  chunks.forEach((chunk) => { bytes.set(chunk, offset); offset += chunk.byteLength; });
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new Error("NWS returned malformed JSON."); }
}

function validateCollection(value: unknown): NwsAlertFeatureCollection {
  const collection = asRecord(value);
  if (collection.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
    throw new Error("NWS response is not a GeoJSON FeatureCollection.");
  }
  return {
    type: "FeatureCollection",
    features: collection.features,
    title: optionalString(collection.title),
    updated: optionalString(collection.updated),
  };
}

function supportedGeometry(value: unknown): SupportedGeometry | null {
  const geometry = asRecord(value);
  if ((geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") || !Array.isArray(geometry.coordinates)) return null;
  return { type: geometry.type, coordinates: geometry.coordinates };
}

function collectPositions(geometry: SupportedGeometry) {
  const positions: Position[] = [];
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number" && Number.isFinite(value[0]) && Number.isFinite(value[1])) {
      positions.push([value[0], value[1]]);
      return;
    }
    value.forEach(visit);
  };
  visit(geometry.coordinates);
  return positions;
}

function geometryCenter(geometry: SupportedGeometry) {
  const positions = collectPositions(geometry);
  if (!positions.length) return null;
  const latitude = positions.reduce((total, position) => total + position[1], 0) / positions.length;
  const longitudeRadians = positions.map((position) => position[0] * Math.PI / 180);
  const meanSin = longitudeRadians.reduce((total, value) => total + Math.sin(value), 0) / longitudeRadians.length;
  const meanCos = longitudeRadians.reduce((total, value) => total + Math.cos(value), 0) / longitudeRadians.length;
  const longitude = Math.atan2(meanSin, meanCos) * 180 / Math.PI;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

function certaintyConfidence(value: unknown) {
  switch (optionalString(value)?.toLowerCase()) {
    case "observed": return 0.95;
    case "likely": return 0.85;
    case "possible": return 0.65;
    case "unlikely": return 0.4;
    default: return 0.5;
  }
}

export class NwsAlertsAdapter implements SourceAdapter<NwsAlertFeatureCollection> {
  readonly descriptor = NWS_ALERTS_DESCRIPTOR;
  private readonly fetchImplementation: FetchImplementation;
  private lastPayload?: NwsAlertFeatureCollection;
  private etag?: string;
  private lastModified?: string;
  private reportedHealth: AdapterReportedHealth = { status: "degraded", message: "Awaiting the first NWS alert refresh." };

  constructor(options: { fetchImplementation?: FetchImplementation } = {}) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async fetch(context: AdapterFetchContext) {
    const headers = new Headers({
      "Accept": "application/geo+json",
      "User-Agent": NWS_USER_AGENT,
    });
    if (this.etag) headers.set("If-None-Match", this.etag);
    if (this.lastModified) headers.set("If-Modified-Since", this.lastModified);
    try {
      const response = await this.fetchImplementation(NWS_ACTIVE_ALERTS_URL, {
        method: "GET",
        headers,
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      if (response.status === 304 && this.lastPayload) {
        this.reportedHealth = { status: "healthy", message: "NWS active alerts are unchanged since the previous refresh." };
        return this.lastPayload;
      }
      if (!response.ok) {
        throw new SourceAdapterHttpError(
          `NWS active-alert feed returned HTTP ${response.status}.`,
          response.status,
          retryAfterMilliseconds(response.headers.get("retry-after")),
        );
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("json")) throw new Error(`NWS returned an unexpected content type: ${contentType || "unknown"}.`);
      const payload = validateCollection(await readBoundedJson(response, MAX_RESPONSE_BYTES));
      this.etag = response.headers.get("etag") ?? this.etag;
      this.lastModified = response.headers.get("last-modified") ?? this.lastModified;
      this.lastPayload = payload;
      this.reportedHealth = { status: "healthy", message: `${payload.features.length} active NWS alerts received.` };
      return payload;
    } catch (error) {
      const statusCode = error instanceof SourceAdapterHttpError ? error.statusCode : undefined;
      this.reportedHealth = {
        status: statusCode !== undefined && statusCode >= 500 ? "down" : "degraded",
        message: error instanceof Error ? error.message : "NWS alert refresh failed.",
      };
      throw error;
    }
  }

  normalize(payload: NwsAlertFeatureCollection, context: AdapterNormalizeContext) {
    const receivedAtMs = Date.parse(context.receivedAt);
    let skippedWithoutGeometry = 0;
    const observations = payload.features.flatMap((rawFeature): NormalizedObservation[] => {
      const feature = asRecord(rawFeature);
      const properties = asRecord(feature.properties);
      const geometry = supportedGeometry(feature.geometry);
      const center = geometry && geometryCenter(geometry);
      const alertId = optionalString(feature.id) ?? optionalString(properties.id) ?? "";
      if (!geometry || !center || !alertId) {
        skippedWithoutGeometry += 1;
        return [];
      }
      const sentAt = isoTimestamp(properties.sent);
      const eventTime = isoTimestamp(properties.onset, properties.effective, properties.sent);
      const upstreamTimeMs = Date.parse(sentAt || eventTime);
      return [{
        observationId: `nws-alert:${alertId}`,
        entityId: `nws-alert:${alertId}`,
        entityType: "weather-alert",
        position: center,
        timestamp: eventTime,
        provenance: {
          sourceFeedId: NWS_ALERTS_SOURCE_ID,
          fetchedAt: context.fetchedAt,
          receivedAt: context.receivedAt,
          ...(sentAt ? { upstreamTimestamp: sentAt } : {}),
          stalenessMs: Number.isFinite(receivedAtMs) && Number.isFinite(upstreamTimeMs) ? Math.max(0, receivedAtMs - upstreamTimeMs) : 0,
        },
        confidence: certaintyConfidence(properties.certainty),
        basis: "estimated",
        retentionClass: "bulk",
        attributes: {
          event: optionalString(properties.event) ?? null,
          areaDescription: optionalString(properties.areaDesc) ?? null,
          severity: optionalString(properties.severity)?.toLowerCase() ?? null,
          certainty: optionalString(properties.certainty)?.toLowerCase() ?? null,
          urgency: optionalString(properties.urgency)?.toLowerCase() ?? null,
          status: optionalString(properties.status)?.toLowerCase() ?? null,
          messageType: optionalString(properties.messageType)?.toLowerCase() ?? null,
          response: optionalString(properties.response)?.toLowerCase() ?? null,
          category: optionalString(properties.category)?.toLowerCase() ?? null,
          headline: optionalString(properties.headline) ?? null,
          description: truncatedString(properties.description) ?? null,
          instruction: truncatedString(properties.instruction) ?? null,
          senderName: optionalString(properties.senderName) ?? null,
          sentAt: sentAt || null,
          effectiveAt: isoTimestamp(properties.effective) || null,
          onsetAt: isoTimestamp(properties.onset) || null,
          expiresAt: isoTimestamp(properties.expires) || null,
          endsAt: isoTimestamp(properties.ends) || null,
          affectedZones: stringArray(properties.affectedZones),
          eventUrl: optionalString(properties.id) ?? optionalString(feature.id) ?? null,
          geometry,
        },
        rawPayload: rawFeature,
      }];
    });
    this.reportedHealth = {
      status: "healthy",
      message: skippedWithoutGeometry
        ? `${observations.length} georeferenced alerts available; ${skippedWithoutGeometry} alerts without provider geometry were not plotted.`
        : `${observations.length} georeferenced active alerts available.`,
    };
    return observations;
  }

  health() {
    return this.reportedHealth;
  }
}
