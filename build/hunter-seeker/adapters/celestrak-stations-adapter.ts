/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import {
  degreesLat,
  degreesLong,
  eciToGeodetic,
  gstime,
  json2satrec,
  propagate,
  type OMMJsonObject,
} from "satellite.js";
import {
  SourceAdapterHttpError,
  type AdapterFetchContext,
  type AdapterNormalizeContext,
  type AdapterReportedHealth,
  type NormalizedObservation,
  type SourceAdapter,
  type SourceDescriptor,
} from "../source-adapter.ts";

export const CELESTRAK_STATIONS_SOURCE_ID = "celestrak.space-stations";
export const CELESTRAK_STATIONS_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=STATIONS&FORMAT=JSON";
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_STATION_RECORDS = 500;
const REQUEST_TIMEOUT_MS = 20_000;
const PROVIDER_REFRESH_FLOOR_MS = 2 * 60 * 60_000;

export const CELESTRAK_ADDITIONAL_GROUPS = [
  { group: "WEATHER", sourceId: "celestrak.weather-satellites", displayName: "CelesTrak Weather Satellites", entityType: "satellite.weather" },
  { group: "GPS-OPS", sourceId: "celestrak.gps-operations", displayName: "CelesTrak GPS Operations", entityType: "satellite.navigation" },
  { group: "SCIENCE", sourceId: "celestrak.science-satellites", displayName: "CelesTrak Science Satellites", entityType: "satellite.science" },
  { group: "LAST-30-DAYS", sourceId: "celestrak.recent-launches", displayName: "CelesTrak Recent Launches", entityType: "satellite.recent-launch" },
  { group: "VISUAL", sourceId: "celestrak.visual-satellites", displayName: "CelesTrak Visual Satellites", entityType: "satellite.visual" },
] as const;

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type JsonRecord = Record<string, unknown>;

export type CelestrakStationsPayload = JsonRecord[];

export const CELESTRAK_STATIONS_DESCRIPTOR: SourceDescriptor = {
  id: CELESTRAK_STATIONS_SOURCE_ID,
  displayName: "CelesTrak Space Stations",
  category: "space",
  authTier: "tier-1",
  credentialType: "none",
  // The board recalculates positions every two minutes from cached orbital
  // elements. The adapter itself never contacts CelesTrak more than once
  // every two hours, matching the provider's published usage guidance.
  pollCadenceMs: 2 * 60_000,
  // Registry calls include local cache propagation passes; the adapter's
  // separate provider gate below is what limits actual network transfers.
  rateLimit: { requestsPerWindow: 1, windowMs: 30_000, hardHourlyBudget: 60 },
  providerDocsUrl: "https://celestrak.org/NORAD/documentation/gp-data-formats.php",
  cache: { ttlMs: 3 * 60 * 60_000, maxObservations: MAX_STATION_RECORDS },
  healthPolicy: { expectedMinimumObservations: 1, consecutiveBelowExpectedLimit: 2 },
  retentionPolicy: { mode: "live-only" },
  estimatedBytesPerDay: 24_000_000,
};

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function optionalNumber(value: unknown) {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function retryAfterMilliseconds(value: string | null) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function confidenceForElementAge(ageMs: number) {
  if (ageMs <= 24 * 60 * 60_000) return 0.92;
  if (ageMs <= 3 * 24 * 60 * 60_000) return 0.8;
  if (ageMs <= 7 * 24 * 60 * 60_000) return 0.65;
  return 0.45;
}

function celestrakEpoch(value: string) {
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`;
  const milliseconds = Date.parse(zoned);
  return {
    milliseconds,
    timestamp: Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : "",
  };
}

function magnitude3(vector: { x: number; y: number; z: number }) {
  return Math.sqrt(vector.x ** 2 + vector.y ** 2 + vector.z ** 2);
}

async function readBoundedJson(response: Response, maximumBytes: number) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel();
    throw new Error(`CelesTrak response exceeds the ${maximumBytes.toLocaleString()} byte safety limit.`);
  }
  if (!response.body) throw new Error("CelesTrak returned an empty response body.");
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
        throw new Error(`CelesTrak response exceeds the ${maximumBytes.toLocaleString()} byte safety limit.`);
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
  catch { throw new Error("CelesTrak returned malformed JSON."); }
}

function validatePayload(value: unknown, maximumRecords = MAX_STATION_RECORDS): CelestrakStationsPayload {
  if (!Array.isArray(value)) throw new Error("CelesTrak response is not an OMM JSON array.");
  if (value.length > maximumRecords) throw new Error(`CelesTrak returned more than ${maximumRecords} orbital records.`);
  return value.map(asRecord);
}

function isPropagatableOmm(record: JsonRecord): record is JsonRecord & OMMJsonObject {
  return Boolean(
    optionalString(record.OBJECT_NAME)
    && optionalString(record.OBJECT_ID)
    && optionalString(record.EPOCH)
    && optionalNumber(record.NORAD_CAT_ID) !== undefined
    && optionalNumber(record.MEAN_MOTION) !== undefined
    && optionalNumber(record.ECCENTRICITY) !== undefined
    && optionalNumber(record.INCLINATION) !== undefined
    && optionalNumber(record.RA_OF_ASC_NODE) !== undefined
    && optionalNumber(record.ARG_OF_PERICENTER) !== undefined
    && optionalNumber(record.MEAN_ANOMALY) !== undefined
    && optionalNumber(record.BSTAR) !== undefined
    && optionalNumber(record.MEAN_MOTION_DOT) !== undefined
    && optionalNumber(record.MEAN_MOTION_DDOT) !== undefined
    && optionalNumber(record.ELEMENT_SET_NO) !== undefined
  );
}

export class CelestrakStationsAdapter implements SourceAdapter<CelestrakStationsPayload> {
  readonly descriptor: SourceDescriptor;
  private readonly fetchImplementation: FetchImplementation;
  private readonly endpoint: string;
  private readonly entityType: string;
  private readonly maximumRecords: number;
  private lastPayload?: CelestrakStationsPayload;
  private networkHoldUntil = 0;
  private reportedHealth: AdapterReportedHealth = { status: "degraded", message: "Awaiting the first CelesTrak station refresh." };

  constructor(options: { fetchImplementation?: FetchImplementation; group?: string; sourceId?: string; displayName?: string; entityType?: string; maximumRecords?: number } = {}) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    const group = (options.group ?? "STATIONS").toUpperCase();
    this.endpoint = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=JSON`;
    this.entityType = options.entityType ?? "space-station";
    this.maximumRecords = options.maximumRecords ?? MAX_STATION_RECORDS;
    this.descriptor = {
      ...CELESTRAK_STATIONS_DESCRIPTOR,
      id: options.sourceId ?? CELESTRAK_STATIONS_SOURCE_ID,
      displayName: options.displayName ?? CELESTRAK_STATIONS_DESCRIPTOR.displayName,
      cache: { ...CELESTRAK_STATIONS_DESCRIPTOR.cache, maxObservations: this.maximumRecords },
    };
  }

  async fetch(context: AdapterFetchContext) {
    const requestedAtMs = Date.parse(context.requestedAt);
    const now = Number.isFinite(requestedAtMs) ? requestedAtMs : Date.now();
    if (now < this.networkHoldUntil) {
      if (this.lastPayload) {
        this.reportedHealth = { status: "healthy", message: "Station positions propagated locally from the cached CelesTrak element set." };
        return this.lastPayload;
      }
      const holdMessage = Number.isFinite(this.networkHoldUntil) ? `until ${new Date(this.networkHoldUntil).toISOString()}` : "until the app restarts";
      throw new Error(`CelesTrak request held ${holdMessage} to protect the provider.`);
    }

    const headers = new Headers({ "Accept": "application/json" });
    try {
      const response = await this.fetchImplementation(this.endpoint, {
        method: "GET",
        headers,
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      this.networkHoldUntil = now + PROVIDER_REFRESH_FLOOR_MS;
      if (!response.ok) {
        // CelesTrak explicitly asks machine clients to stop after any non-200
        // response rather than retrying. A restart is the deliberate reset.
        this.networkHoldUntil = Number.POSITIVE_INFINITY;
        throw new SourceAdapterHttpError(
          `CelesTrak station feed returned HTTP ${response.status}.`,
          response.status,
          Math.max(PROVIDER_REFRESH_FLOOR_MS, retryAfterMilliseconds(response.headers.get("retry-after")) ?? 0),
        );
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("json")) throw new Error(`CelesTrak returned an unexpected content type: ${contentType || "unknown"}.`);
      const payload = validatePayload(await readBoundedJson(response, MAX_RESPONSE_BYTES), this.maximumRecords);
      this.lastPayload = payload;
      this.reportedHealth = { status: "healthy", message: `${payload.length} CelesTrak station element sets received.` };
      return payload;
    } catch (error) {
      const statusCode = error instanceof SourceAdapterHttpError ? error.statusCode : undefined;
      this.reportedHealth = {
        status: statusCode !== undefined && statusCode >= 500 ? "down" : "degraded",
        message: error instanceof Error ? error.message : "CelesTrak refresh failed.",
      };
      throw error;
    }
  }

  normalize(payload: CelestrakStationsPayload, context: AdapterNormalizeContext) {
    const propagatedAt = new Date(context.receivedAt);
    const propagatedAtMs = propagatedAt.getTime();
    let rejected = 0;
    const observations = payload.flatMap((rawRecord): NormalizedObservation[] => {
      if (!isPropagatableOmm(rawRecord) || !Number.isFinite(propagatedAtMs)) {
        rejected += 1;
        return [];
      }
      try {
        const satrec = json2satrec(rawRecord);
        const state = propagate(satrec, propagatedAt);
        if (!state) {
          rejected += 1;
          return [];
        }
        const geodetic = eciToGeodetic(state.position, gstime(propagatedAt));
        const latitude = degreesLat(geodetic.latitude);
        const longitude = degreesLong(geodetic.longitude);
        const upstreamEpoch = optionalString(rawRecord.EPOCH)!;
        const epoch = celestrakEpoch(upstreamEpoch);
        if (!epoch.timestamp) {
          rejected += 1;
          return [];
        }
        const elementAgeMs = Math.max(0, propagatedAtMs - epoch.milliseconds);
        const noradId = String(rawRecord.NORAD_CAT_ID);
        const name = optionalString(rawRecord.OBJECT_NAME)!;
        const meanMotion = optionalNumber(rawRecord.MEAN_MOTION)!;
        return [{
          observationId: `${this.descriptor.id === CELESTRAK_STATIONS_SOURCE_ID ? "celestrak-station" : this.descriptor.id}:${noradId}`,
          entityId: `satellite:${noradId}`,
          entityType: this.entityType,
          position: {
            latitude,
            longitude,
            altitudeMeters: geodetic.height * 1_000,
          },
          timestamp: context.receivedAt,
          provenance: {
            sourceFeedId: this.descriptor.id,
            fetchedAt: context.fetchedAt,
            receivedAt: context.receivedAt,
            upstreamTimestamp: epoch.timestamp,
            stalenessMs: elementAgeMs,
          },
          confidence: confidenceForElementAge(elementAgeMs),
          basis: "estimated",
          retentionClass: "bulk",
          attributes: {
            title: name,
            noradCatalogId: noradId,
            internationalDesignator: optionalString(rawRecord.OBJECT_ID) ?? null,
            objectType: optionalString(rawRecord.OBJECT_TYPE) ?? null,
            countryCode: optionalString(rawRecord.COUNTRY_CODE) ?? null,
            orbitalElementEpoch: epoch.timestamp,
            propagationModel: "SGP4",
            meanMotionRevolutionsPerDay: meanMotion,
            orbitalPeriodMinutes: meanMotion > 0 ? 1_440 / meanMotion : null,
            inclinationDegrees: optionalNumber(rawRecord.INCLINATION) ?? null,
            eccentricity: optionalNumber(rawRecord.ECCENTRICITY) ?? null,
            orbitalElements: {
              OBJECT_NAME: rawRecord.OBJECT_NAME,
              OBJECT_ID: rawRecord.OBJECT_ID,
              EPOCH: rawRecord.EPOCH,
              NORAD_CAT_ID: rawRecord.NORAD_CAT_ID,
              MEAN_MOTION: rawRecord.MEAN_MOTION,
              ECCENTRICITY: rawRecord.ECCENTRICITY,
              INCLINATION: rawRecord.INCLINATION,
              RA_OF_ASC_NODE: rawRecord.RA_OF_ASC_NODE,
              ARG_OF_PERICENTER: rawRecord.ARG_OF_PERICENTER,
              MEAN_ANOMALY: rawRecord.MEAN_ANOMALY,
              BSTAR: rawRecord.BSTAR,
              MEAN_MOTION_DOT: rawRecord.MEAN_MOTION_DOT,
              MEAN_MOTION_DDOT: rawRecord.MEAN_MOTION_DDOT,
              ELEMENT_SET_NO: rawRecord.ELEMENT_SET_NO,
              REV_AT_EPOCH: rawRecord.REV_AT_EPOCH,
            },
            velocityKilometersPerSecond: magnitude3(state.velocity),
            eventUrl: `https://celestrak.org/NORAD/elements/table.php?CATNR=${encodeURIComponent(noradId)}`,
          },
          rawPayload: rawRecord,
        }];
      } catch {
        rejected += 1;
        return [];
      }
    });
    this.reportedHealth = {
      status: rejected ? "degraded" : "healthy",
      message: rejected
        ? `${observations.length} station positions propagated; ${rejected} invalid element set${rejected === 1 ? " was" : "s were"} skipped.`
        : `${observations.length} station positions propagated locally with SGP4.`,
    };
    return observations;
  }

  health() {
    return this.reportedHealth;
  }
}
