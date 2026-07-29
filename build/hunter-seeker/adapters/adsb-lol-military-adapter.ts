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

export const ADSB_LOL_MILITARY_SOURCE_ID = "adsb.lol.military";
export const ADSB_LOL_MILITARY_URL = "https://api.adsb.lol/v2/mil";
const MAX_RESPONSE_BYTES = 4_000_000;
const MAX_AIRCRAFT_RECORDS = 5_000;
const MAX_LAST_POSITION_AGE_SECONDS = 15 * 60;
const REQUEST_TIMEOUT_MS = 20_000;
const FEET_TO_METERS = 0.3048;

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type JsonRecord = Record<string, unknown>;

export type AdsbLolMilitaryPayload = {
  ac: unknown[];
  now: number;
  total: number;
  message: string;
};

export const ADSB_LOL_MILITARY_DESCRIPTOR: SourceDescriptor = {
  id: ADSB_LOL_MILITARY_SOURCE_ID,
  displayName: "ADSB.lol Military Aircraft",
  category: "aviation",
  authTier: "tier-1",
  credentialType: "none",
  pollCadenceMs: 2 * 60_000,
  // adsb.lol publishes no request quota. Keep a conservative local ceiling;
  // the UI may be set lower, but the registry never bypasses this provider floor.
  rateLimit: { requestsPerWindow: 1, windowMs: 60_000, hardHourlyBudget: 60 },
  providerDocsUrl: "https://api.adsb.lol/docs",
  cache: { ttlMs: 5 * 60_000, maxObservations: 2_000 },
  healthPolicy: { expectedMinimumObservations: 1, consecutiveBelowExpectedLimit: 2 },
  retentionPolicy: { mode: "live-only" },
  estimatedBytesPerDay: 500_000_000,
};

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function optionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

function altitudeFeet(value: unknown) {
  if (value === "ground") return 0;
  return optionalNumber(value);
}

function confidenceFor(sourceType: string, usedLastPosition: boolean) {
  if (usedLastPosition) return 0.55;
  if (sourceType.startsWith("adsb")) return 0.9;
  if (sourceType === "mlat") return 0.75;
  if (sourceType.startsWith("tisb")) return 0.65;
  return 0.6;
}

async function readBoundedJson(response: Response, maximumBytes: number) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel();
    throw new Error(`adsb.lol response exceeds the ${maximumBytes.toLocaleString()} byte safety limit.`);
  }
  if (!response.body) throw new Error("adsb.lol returned an empty response body.");
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
        throw new Error(`adsb.lol response exceeds the ${maximumBytes.toLocaleString()} byte safety limit.`);
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
  catch { throw new Error("adsb.lol returned malformed JSON."); }
}

function validatePayload(value: unknown): AdsbLolMilitaryPayload {
  const payload = asRecord(value);
  const now = optionalNumber(payload.now);
  if (!Array.isArray(payload.ac) || now === undefined || !Number.isFinite(new Date(now).getTime())) {
    throw new Error("adsb.lol response does not match the documented v2 aircraft schema.");
  }
  if (payload.ac.length > MAX_AIRCRAFT_RECORDS) {
    throw new Error(`adsb.lol returned more than ${MAX_AIRCRAFT_RECORDS.toLocaleString()} aircraft records.`);
  }
  return {
    ac: payload.ac,
    now,
    total: optionalNumber(payload.total) ?? payload.ac.length,
    message: optionalString(payload.msg) ?? "",
  };
}

export class AdsbLolMilitaryAdapter implements SourceAdapter<AdsbLolMilitaryPayload> {
  readonly descriptor = ADSB_LOL_MILITARY_DESCRIPTOR;
  private readonly fetchImplementation: FetchImplementation;
  private lastPayload?: AdsbLolMilitaryPayload;
  private etag?: string;
  private lastModified?: string;
  private reportedHealth: AdapterReportedHealth = { status: "degraded", message: "Awaiting the first adsb.lol refresh." };

  constructor(options: { fetchImplementation?: FetchImplementation } = {}) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async fetch(context: AdapterFetchContext) {
    const headers = new Headers({ "Accept": "application/json" });
    if (this.etag) headers.set("If-None-Match", this.etag);
    if (this.lastModified) headers.set("If-Modified-Since", this.lastModified);
    try {
      const response = await this.fetchImplementation(ADSB_LOL_MILITARY_URL, {
        method: "GET",
        headers,
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      if (response.status === 304 && this.lastPayload) {
        this.reportedHealth = { status: "healthy", message: "adsb.lol aircraft data is unchanged since the previous refresh." };
        return this.lastPayload;
      }
      if (!response.ok) {
        throw new SourceAdapterHttpError(
          `adsb.lol military feed returned HTTP ${response.status}.`,
          response.status,
          retryAfterMilliseconds(response.headers.get("retry-after")),
        );
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("json")) throw new Error(`adsb.lol returned an unexpected content type: ${contentType || "unknown"}.`);
      const payload = validatePayload(await readBoundedJson(response, MAX_RESPONSE_BYTES));
      this.etag = response.headers.get("etag") ?? this.etag;
      this.lastModified = response.headers.get("last-modified") ?? this.lastModified;
      this.lastPayload = payload;
      this.reportedHealth = { status: "healthy", message: `${payload.total} military aircraft contacts received from adsb.lol.` };
      return payload;
    } catch (error) {
      const statusCode = error instanceof SourceAdapterHttpError ? error.statusCode : undefined;
      this.reportedHealth = {
        status: statusCode !== undefined && statusCode >= 500 ? "down" : "degraded",
        message: error instanceof Error ? error.message : "adsb.lol refresh failed.",
      };
      throw error;
    }
  }

  normalize(payload: AdsbLolMilitaryPayload, context: AdapterNormalizeContext) {
    const receivedAtMs = Date.parse(context.receivedAt);
    let skippedWithoutCurrentPosition = 0;
    const observations = payload.ac.flatMap((rawAircraft): NormalizedObservation[] => {
      const aircraft = asRecord(rawAircraft);
      const hex = optionalString(aircraft.hex)?.toLowerCase();
      const directLatitude = optionalNumber(aircraft.lat);
      const directLongitude = optionalNumber(aircraft.lon);
      const lastPosition = asRecord(aircraft.lastPosition);
      const hasDirectPosition = directLatitude !== undefined && directLongitude !== undefined;
      const latitude = hasDirectPosition ? directLatitude : optionalNumber(lastPosition.lat);
      const longitude = hasDirectPosition ? directLongitude : optionalNumber(lastPosition.lon);
      const positionAgeSeconds = hasDirectPosition
        ? optionalNumber(aircraft.seen_pos) ?? optionalNumber(aircraft.seen) ?? 0
        : optionalNumber(lastPosition.seen_pos) ?? Number.POSITIVE_INFINITY;
      if (!hex || latitude === undefined || longitude === undefined || positionAgeSeconds > MAX_LAST_POSITION_AGE_SECONDS) {
        skippedWithoutCurrentPosition += 1;
        return [];
      }
      const upstreamTimeMs = payload.now - Math.max(0, positionAgeSeconds) * 1_000;
      const upstreamTimestamp = new Date(upstreamTimeMs).toISOString();
      const sourceType = optionalString(aircraft.type)?.toLowerCase() ?? "unknown";
      const callsign = optionalString(aircraft.flight);
      const registration = optionalString(aircraft.r);
      const aircraftType = optionalString(aircraft.t);
      const geometricAltitudeFeet = altitudeFeet(aircraft.alt_geom);
      const barometricAltitudeFeet = altitudeFeet(aircraft.alt_baro);
      const altitude = geometricAltitudeFeet ?? barometricAltitudeFeet;
      const usedLastPosition = !hasDirectPosition;
      return [{
        observationId: `adsb-lol-military:${hex}`,
        entityId: `aircraft:${hex}`,
        entityType: "military-aircraft",
        position: {
          latitude,
          longitude,
          ...(altitude === undefined ? {} : { altitudeMeters: altitude * FEET_TO_METERS }),
        },
        timestamp: upstreamTimestamp,
        provenance: {
          sourceFeedId: ADSB_LOL_MILITARY_SOURCE_ID,
          fetchedAt: context.fetchedAt,
          receivedAt: context.receivedAt,
          upstreamTimestamp,
          stalenessMs: Number.isFinite(receivedAtMs) ? Math.max(0, receivedAtMs - upstreamTimeMs) : Math.max(0, positionAgeSeconds * 1_000),
        },
        confidence: confidenceFor(sourceType, usedLastPosition),
        basis: "measured",
        retentionClass: "bulk",
        attributes: {
          title: callsign ?? registration ?? hex.toUpperCase(),
          callsign: callsign ?? null,
          registration: registration ?? null,
          aircraftType: aircraftType ?? null,
          transponderHex: hex.toUpperCase(),
          sourceType,
          positionSource: usedLastPosition ? "last-position" : "current-broadcast",
          barometricAltitudeFeet: barometricAltitudeFeet ?? null,
          geometricAltitudeFeet: geometricAltitudeFeet ?? null,
          groundspeedKnots: optionalNumber(aircraft.gs) ?? null,
          trackDegrees: optionalNumber(aircraft.track) ?? optionalNumber(aircraft.calc_track) ?? null,
          verticalRateFeetPerMinute: optionalNumber(aircraft.geom_rate) ?? optionalNumber(aircraft.baro_rate) ?? null,
          squawk: optionalString(aircraft.squawk) ?? null,
          emergency: optionalString(aircraft.emergency) ?? null,
          category: optionalString(aircraft.category) ?? null,
          signalDbfs: optionalNumber(aircraft.rssi) ?? null,
          positionAgeSeconds,
          eventUrl: `https://adsb.lol/?icao=${encodeURIComponent(hex)}`,
        },
        rawPayload: rawAircraft,
      }];
    });
    this.reportedHealth = {
      status: observations.length || !skippedWithoutCurrentPosition ? "healthy" : "degraded",
      message: skippedWithoutCurrentPosition
        ? `${observations.length} positioned military aircraft available; ${skippedWithoutCurrentPosition} contacts without a recent position were not plotted.`
        : `${observations.length} positioned military aircraft available.`,
    };
    return observations;
  }

  health() {
    return this.reportedHealth;
  }
}
