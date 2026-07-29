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
  type SourceCreditBudget,
  type SourceDescriptor,
} from "../source-adapter.ts";

export const OPENSKY_CIVIL_AIRCRAFT_SOURCE_ID = "opensky.civil-airspace";
export const OPENSKY_CIVIL_AIRCRAFT_URL = "https://opensky-network.org/api/states/all?extended=1";
const MAX_RESPONSE_BYTES = 12_000_000;
const MAX_STATE_RECORDS = 20_000;
const MAX_POSITIONED_AIRCRAFT = 3_000;
const MAX_POSITION_AGE_SECONDS = 25 * 60;
const SAFE_FALLBACK_REFRESH_MS = 20 * 60_000;
const CREDIT_WINDOW_MS = 24 * 60 * 60_000;
const ANONYMOUS_DAILY_CREDITS = 400;
const GLOBAL_REQUEST_COST_CREDITS = 4;
const CREDIT_RESERVE = Math.ceil(ANONYMOUS_DAILY_CREDITS * 0.1);
const MIN_CREDIT_AWARE_REFRESH_MS = 2 * 60_000;
const REQUEST_TIMEOUT_MS = 25_000;
const METERS_PER_SECOND_TO_KNOTS = 1.9438444924;
const METERS_TO_FEET = 3.280839895;
const METERS_PER_SECOND_TO_FEET_PER_MINUTE = 196.8503937;

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type JsonRecord = Record<string, unknown>;

export type OpenSkyStateVector = unknown[];
export type OpenSkyStatePayload = {
  time: number;
  states: OpenSkyStateVector[];
  remainingCredits?: number;
};

export type OpenSkyCreditCadence = SourceCreditBudget & {
  timeUntilEstimatedRefillMs: number;
};

export function calculateOpenSkyCreditCadence(options: {
  nowMs: number;
  remainingCredits?: number;
  estimatedRefillAtMs?: number;
  retryAfterMs?: number;
}): OpenSkyCreditCadence {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const exactRetryMs = options.retryAfterMs !== undefined && Number.isFinite(options.retryAfterMs)
    ? Math.max(0, options.retryAfterMs)
    : undefined;
  const estimatedRefillAtMs = exactRetryMs !== undefined
    ? nowMs + exactRetryMs
    : options.estimatedRefillAtMs !== undefined && Number.isFinite(options.estimatedRefillAtMs) && options.estimatedRefillAtMs > nowMs
      ? options.estimatedRefillAtMs
      : nowMs + CREDIT_WINDOW_MS;
  const timeUntilEstimatedRefillMs = Math.max(MIN_CREDIT_AWARE_REFRESH_MS, estimatedRefillAtMs - nowMs);
  const remainingCredits = options.remainingCredits === undefined
    ? undefined
    : Math.max(0, Math.floor(options.remainingCredits));
  let effectiveRefreshMs = SAFE_FALLBACK_REFRESH_MS;
  let basis: OpenSkyCreditCadence["basis"] = "safe-fallback";

  if (exactRetryMs !== undefined) {
    effectiveRefreshMs = Math.max(MIN_CREDIT_AWARE_REFRESH_MS, exactRetryMs);
    basis = "provider-retry-after";
  } else if (remainingCredits !== undefined) {
    const usableCredits = Math.max(0, remainingCredits - CREDIT_RESERVE);
    const requestsAvailable = Math.floor(usableCredits / GLOBAL_REQUEST_COST_CREDITS);
    effectiveRefreshMs = requestsAvailable > 0
      ? Math.max(MIN_CREDIT_AWARE_REFRESH_MS, Math.ceil(timeUntilEstimatedRefillMs / requestsAvailable))
      : timeUntilEstimatedRefillMs;
    basis = "rolling-24-hour-estimate";
  }

  const nextNetworkAtMs = nowMs + effectiveRefreshMs;
  return {
    ...(remainingCredits === undefined ? {} : { remainingCredits }),
    requestCostCredits: GLOBAL_REQUEST_COST_CREDITS,
    reserveCredits: CREDIT_RESERVE,
    effectiveRefreshMs,
    estimatedRefillAt: new Date(estimatedRefillAtMs).toISOString(),
    nextNetworkAt: new Date(nextNetworkAtMs).toISOString(),
    timeUntilEstimatedRefillMs,
    basis,
  };
}

export const OPENSKY_CIVIL_AIRCRAFT_DESCRIPTOR: SourceDescriptor = {
  id: OPENSKY_CIVIL_AIRCRAFT_SOURCE_ID,
  displayName: "OpenSky Civil Airspace",
  category: "aviation",
  authTier: "tier-1",
  credentialType: "none",
  pollCadenceMs: 2 * 60_000,
  // Registry passes inside the cache window are local. The adapter's network
  // gate below limits anonymous global snapshots to one every 20 minutes.
  rateLimit: { requestsPerWindow: 1, windowMs: 30_000, hardHourlyBudget: 60 },
  providerDocsUrl: "https://openskynetwork.github.io/opensky-api/rest.html",
  signupUrl: "https://opensky-network.org/",
  cache: { ttlMs: 30 * 60_000, maxObservations: MAX_POSITIONED_AIRCRAFT },
  healthPolicy: { expectedMinimumObservations: 1, consecutiveBelowExpectedLimit: 2 },
  retentionPolicy: { mode: "live-only" },
  estimatedBytesPerDay: 864_000_000,
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

function epochSecondsToIso(value: unknown) {
  const seconds = optionalNumber(value);
  if (seconds === undefined) return "";
  const date = new Date(seconds * 1_000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function retryAfterMilliseconds(response: Response) {
  const value = response.headers.get("x-rate-limit-retry-after-seconds") ?? response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function sourceType(value: unknown) {
  return ({ 0: "ads-b", 1: "asterix", 2: "mlat", 3: "flarm" } as Record<number, string>)[optionalNumber(value) ?? -1] ?? "unknown";
}

function confidenceFor(positionSource: string) {
  if (positionSource === "ads-b") return 0.9;
  if (positionSource === "asterix") return 0.78;
  if (positionSource === "mlat") return 0.72;
  if (positionSource === "flarm") return 0.68;
  return 0.6;
}

function categoryLabel(value: unknown) {
  const category = optionalNumber(value);
  return ({
    0: "no-category-information",
    1: "no-adsb-category-information",
    2: "light-aircraft",
    3: "small-aircraft",
    4: "large-aircraft",
    5: "high-vortex-large-aircraft",
    6: "heavy-aircraft",
    7: "high-performance-aircraft",
    8: "rotorcraft",
    9: "glider",
    10: "lighter-than-air",
    11: "parachutist",
    12: "ultralight",
    13: "reserved",
    14: "unmanned-aerial-vehicle",
  } as Record<number, string>)[category ?? -1] ?? "unsupported-object";
}

function isAirborneAircraftCategory(value: unknown) {
  const category = optionalNumber(value);
  return category === undefined || (category >= 0 && category <= 14);
}

async function readBoundedJson(response: Response, maximumBytes: number) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel();
    throw new Error(`OpenSky response exceeds the ${maximumBytes.toLocaleString()} byte safety limit.`);
  }
  if (!response.body) throw new Error("OpenSky returned an empty response body.");
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
        throw new Error(`OpenSky response exceeds the ${maximumBytes.toLocaleString()} byte safety limit.`);
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
  catch { throw new Error("OpenSky returned malformed JSON."); }
}

function validatePayload(value: unknown, remainingCredits?: number): OpenSkyStatePayload {
  const payload = asRecord(value);
  const time = optionalNumber(payload.time);
  if (time === undefined || (payload.states !== null && !Array.isArray(payload.states))) {
    throw new Error("OpenSky response does not match the documented state-vector schema.");
  }
  const states = (payload.states ?? []) as unknown[];
  if (states.length > MAX_STATE_RECORDS) throw new Error(`OpenSky returned more than ${MAX_STATE_RECORDS.toLocaleString()} state vectors.`);
  return {
    time,
    states: states.filter(Array.isArray) as OpenSkyStateVector[],
    ...(remainingCredits === undefined ? {} : { remainingCredits }),
  };
}

function evenlyThin<T>(values: T[], maximum: number) {
  if (values.length <= maximum) return values;
  const stride = values.length / maximum;
  return Array.from({ length: maximum }, (_, index) => values[Math.floor(index * stride)]);
}

export class OpenSkyCivilAircraftAdapter implements SourceAdapter<OpenSkyStatePayload> {
  readonly descriptor = OPENSKY_CIVIL_AIRCRAFT_DESCRIPTOR;
  private readonly fetchImplementation: FetchImplementation;
  private lastPayload?: OpenSkyStatePayload;
  private networkHoldUntil = 0;
  private estimatedCreditRefillAt = 0;
  private creditBudget?: SourceCreditBudget;
  private reportedHealth: AdapterReportedHealth = { status: "degraded", message: "Awaiting the first anonymous OpenSky snapshot." };

  constructor(options: { fetchImplementation?: FetchImplementation } = {}) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async fetch(context: AdapterFetchContext) {
    const requestedAtMs = Date.parse(context.requestedAt);
    const now = Number.isFinite(requestedAtMs) ? requestedAtMs : Date.now();
    if (this.lastPayload && now < this.networkHoldUntil) {
      this.reportedHealth = {
        status: "healthy",
        message: "Civil-airspace positions are being served from the credit-guarded OpenSky snapshot cache.",
        creditBudget: this.creditBudget,
      };
      return this.lastPayload;
    }
    try {
      const response = await this.fetchImplementation(OPENSKY_CIVIL_AIRCRAFT_URL, {
        method: "GET",
        headers: new Headers({ "Accept": "application/json" }),
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      if (!response.ok) {
        const retryAfterMs = retryAfterMilliseconds(response);
        const cadence = calculateOpenSkyCreditCadence({
          nowMs: now,
          remainingCredits: response.status === 429 ? 0 : this.creditBudget?.remainingCredits,
          estimatedRefillAtMs: this.estimatedCreditRefillAt || undefined,
          retryAfterMs,
        });
        this.creditBudget = cadence;
        this.estimatedCreditRefillAt = Date.parse(cadence.estimatedRefillAt);
        this.networkHoldUntil = Date.parse(cadence.nextNetworkAt);
        throw new SourceAdapterHttpError(`OpenSky state-vector feed returned HTTP ${response.status}.`, response.status, retryAfterMs);
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("json")) throw new Error(`OpenSky returned an unexpected content type: ${contentType || "unknown"}.`);
      const remainingCredits = optionalNumber(response.headers.get("x-rate-limit-remaining") ? Number(response.headers.get("x-rate-limit-remaining")) : undefined);
      const payload = validatePayload(await readBoundedJson(response, MAX_RESPONSE_BYTES), remainingCredits);
      const cadence = calculateOpenSkyCreditCadence({
        nowMs: now,
        remainingCredits,
        estimatedRefillAtMs: this.estimatedCreditRefillAt || undefined,
      });
      this.lastPayload = payload;
      this.creditBudget = cadence;
      this.estimatedCreditRefillAt = Date.parse(cadence.estimatedRefillAt);
      this.networkHoldUntil = Date.parse(cadence.nextNetworkAt);
      this.reportedHealth = {
        status: "healthy",
        message: `${payload.states.length.toLocaleString()} OpenSky state vectors received${remainingCredits === undefined ? "; credit balance was not reported" : `; ${remainingCredits.toLocaleString()} anonymous credits remain`}. Network refresh protected at ${Math.ceil(cadence.effectiveRefreshMs / 60_000).toLocaleString()} minute intervals.`,
        creditBudget: cadence,
      };
      return payload;
    } catch (error) {
      if (!this.networkHoldUntil || this.networkHoldUntil < now) {
        const cadence = calculateOpenSkyCreditCadence({ nowMs: now, estimatedRefillAtMs: this.estimatedCreditRefillAt || undefined });
        this.creditBudget = cadence;
        this.networkHoldUntil = Date.parse(cadence.nextNetworkAt);
      }
      const statusCode = error instanceof SourceAdapterHttpError ? error.statusCode : undefined;
      this.reportedHealth = {
        status: statusCode !== undefined && statusCode >= 500 ? "down" : "degraded",
        message: error instanceof Error ? error.message : "OpenSky refresh failed.",
        creditBudget: this.creditBudget,
      };
      throw error;
    }
  }

  normalize(payload: OpenSkyStatePayload, context: AdapterNormalizeContext) {
    const receivedAtMs = Date.parse(context.receivedAt);
    const candidates = payload.states.flatMap((state): NormalizedObservation[] => {
      const icao24 = optionalString(state[0])?.toLowerCase();
      const longitude = optionalNumber(state[5]);
      const latitude = optionalNumber(state[6]);
      const onGround = state[8] === true;
      const upstreamTimestamp = epochSecondsToIso(state[3]) || epochSecondsToIso(state[4]) || epochSecondsToIso(payload.time);
      const upstreamTimeMs = Date.parse(upstreamTimestamp);
      const ageSeconds = Number.isFinite(receivedAtMs) && Number.isFinite(upstreamTimeMs) ? Math.max(0, (receivedAtMs - upstreamTimeMs) / 1_000) : Number.POSITIVE_INFINITY;
      if (!icao24 || longitude === undefined || latitude === undefined || onGround || ageSeconds > MAX_POSITION_AGE_SECONDS || !isAirborneAircraftCategory(state[17])) return [];
      const callsign = optionalString(state[1]);
      const barometricAltitudeMeters = optionalNumber(state[7]);
      const geometricAltitudeMeters = optionalNumber(state[13]);
      const altitudeMeters = geometricAltitudeMeters ?? barometricAltitudeMeters;
      const velocityMetersPerSecond = optionalNumber(state[9]);
      const verticalRateMetersPerSecond = optionalNumber(state[11]);
      const positionSource = sourceType(state[16]);
      return [{
        observationId: `opensky-aircraft:${icao24}`,
        entityId: `aircraft:${icao24}`,
        entityType: "civilian-aircraft",
        position: {
          latitude,
          longitude,
          ...(altitudeMeters === undefined ? {} : { altitudeMeters }),
        },
        timestamp: upstreamTimestamp,
        provenance: {
          sourceFeedId: OPENSKY_CIVIL_AIRCRAFT_SOURCE_ID,
          fetchedAt: context.fetchedAt,
          receivedAt: context.receivedAt,
          upstreamTimestamp,
          stalenessMs: Math.round(ageSeconds * 1_000),
        },
        confidence: confidenceFor(positionSource),
        basis: "measured",
        retentionClass: "bulk",
        attributes: {
          title: callsign ?? icao24.toUpperCase(),
          callsign: callsign ?? null,
          originCountry: optionalString(state[2]) ?? null,
          transponderHex: icao24.toUpperCase(),
          sourceType: positionSource,
          classification: "civil-or-unclassified",
          classificationBasis: "excluded when matched by the active adsb.lol military layer",
          aircraftCategory: categoryLabel(state[17]),
          aircraftCategoryCode: optionalNumber(state[17]) ?? null,
          positionAgeSeconds: ageSeconds,
          barometricAltitudeFeet: barometricAltitudeMeters === undefined ? null : barometricAltitudeMeters * METERS_TO_FEET,
          geometricAltitudeFeet: geometricAltitudeMeters === undefined ? null : geometricAltitudeMeters * METERS_TO_FEET,
          groundspeedKnots: velocityMetersPerSecond === undefined ? null : velocityMetersPerSecond * METERS_PER_SECOND_TO_KNOTS,
          trackDegrees: optionalNumber(state[10]) ?? null,
          verticalRateFeetPerMinute: verticalRateMetersPerSecond === undefined ? null : verticalRateMetersPerSecond * METERS_PER_SECOND_TO_FEET_PER_MINUTE,
          squawk: optionalString(state[14]) ?? null,
          specialPurposeIndicator: state[15] === true,
          remainingAnonymousCredits: payload.remainingCredits ?? null,
          eventUrl: "https://opensky-network.org/network/explorer",
        },
        rawPayload: state,
      }];
    });
    const observations = evenlyThin(candidates, MAX_POSITIONED_AIRCRAFT);
    const excluded = payload.states.length - candidates.length;
    this.reportedHealth = {
      status: observations.length || payload.states.length === 0 ? "healthy" : "degraded",
      message: `${observations.length.toLocaleString()} positioned airborne contacts available${excluded ? `; ${excluded.toLocaleString()} stale, grounded, unsupported, or unpositioned vectors were excluded` : ""}.`,
      creditBudget: this.creditBudget,
    };
    return observations;
  }

  health() {
    return this.reportedHealth;
  }
}
