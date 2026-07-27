import {
  SourceAdapterHttpError,
  type AdapterFetchContext,
  type AdapterNormalizeContext,
  type AdapterReportedHealth,
  type NormalizedObservation,
  type SourceAdapter,
  type SourceDescriptor,
} from "../source-adapter.ts";

export const USGS_EARTHQUAKE_SOURCE_ID = "usgs.earthquakes";
export const USGS_EARTHQUAKE_FEED_URL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson";
const MAX_RESPONSE_BYTES = 5_000_000;
const REQUEST_TIMEOUT_MS = 20_000;

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type JsonRecord = Record<string, unknown>;

export type UsgsEarthquakeFeatureCollection = {
  type: "FeatureCollection";
  metadata?: JsonRecord;
  features: unknown[];
};

export const USGS_EARTHQUAKE_DESCRIPTOR: SourceDescriptor = {
  id: USGS_EARTHQUAKE_SOURCE_ID,
  displayName: "USGS Earthquakes — Past Day",
  category: "seismic",
  authTier: "tier-1",
  credentialType: "none",
  pollCadenceMs: 2 * 60_000,
  // USGS documents a one-minute feed update cadence but does not publish a
  // quota on the feed page. VoidCat defaults to two minutes and keeps a
  // conservative one-minute provider safety ceiling if the slider is lower.
  rateLimit: { requestsPerWindow: 1, windowMs: 55_000, hardHourlyBudget: 60 },
  providerDocsUrl: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php",
  cache: { ttlMs: 5 * 60_000, maxObservations: 20_000 },
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
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isoFromEpoch(value: unknown) {
  const epoch = optionalNumber(value);
  if (epoch === undefined) return "";
  const date = new Date(epoch);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
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
    throw new Error(`USGS response exceeds the ${maximumBytes.toLocaleString()} byte safety limit.`);
  }
  if (!response.body) throw new Error("USGS returned an empty response body.");
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
        throw new Error(`USGS response exceeds the ${maximumBytes.toLocaleString()} byte safety limit.`);
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
  catch { throw new Error("USGS returned malformed JSON."); }
}

function validateCollection(value: unknown): UsgsEarthquakeFeatureCollection {
  const collection = asRecord(value);
  if (collection.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
    throw new Error("USGS response is not a GeoJSON FeatureCollection.");
  }
  return { type: "FeatureCollection", metadata: asRecord(collection.metadata), features: collection.features };
}

export class UsgsEarthquakeAdapter implements SourceAdapter<UsgsEarthquakeFeatureCollection> {
  readonly descriptor = USGS_EARTHQUAKE_DESCRIPTOR;
  private readonly fetchImplementation: FetchImplementation;
  private lastPayload?: UsgsEarthquakeFeatureCollection;
  private etag?: string;
  private lastModified?: string;
  private reportedHealth: AdapterReportedHealth = { status: "degraded", message: "Awaiting the first USGS feed refresh." };

  constructor(options: { fetchImplementation?: FetchImplementation } = {}) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async fetch(context: AdapterFetchContext) {
    const headers = new Headers({ "Accept": "application/geo+json, application/json" });
    if (this.etag) headers.set("If-None-Match", this.etag);
    if (this.lastModified) headers.set("If-Modified-Since", this.lastModified);
    try {
      const response = await this.fetchImplementation(USGS_EARTHQUAKE_FEED_URL, {
        method: "GET",
        headers,
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      if (response.status === 304 && this.lastPayload) {
        this.reportedHealth = { status: "healthy", message: "USGS feed is unchanged since the previous refresh." };
        return this.lastPayload;
      }
      if (!response.ok) {
        throw new SourceAdapterHttpError(
          `USGS feed returned HTTP ${response.status}.`,
          response.status,
          retryAfterMilliseconds(response.headers.get("retry-after")),
        );
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("json")) throw new Error(`USGS returned an unexpected content type: ${contentType || "unknown"}.`);
      const payload = validateCollection(await readBoundedJson(response, MAX_RESPONSE_BYTES));
      this.etag = response.headers.get("etag") ?? this.etag;
      this.lastModified = response.headers.get("last-modified") ?? this.lastModified;
      this.lastPayload = payload;
      this.reportedHealth = { status: "healthy", message: `${payload.features.length} USGS events received.` };
      return payload;
    } catch (error) {
      const statusCode = error instanceof SourceAdapterHttpError ? error.statusCode : undefined;
      this.reportedHealth = {
        status: statusCode !== undefined && statusCode >= 500 ? "down" : "degraded",
        message: error instanceof Error ? error.message : "USGS feed refresh failed.",
      };
      throw error;
    }
  }

  normalize(payload: UsgsEarthquakeFeatureCollection, context: AdapterNormalizeContext) {
    const receivedAtMs = Date.parse(context.receivedAt);
    return payload.features.map((rawFeature): NormalizedObservation => {
      const feature = asRecord(rawFeature);
      const properties = asRecord(feature.properties);
      const geometry = asRecord(feature.geometry);
      const coordinates = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
      const longitude = optionalNumber(coordinates[0]) ?? Number.NaN;
      const latitude = optionalNumber(coordinates[1]) ?? Number.NaN;
      const depthKm = optionalNumber(coordinates[2]);
      const eventId = optionalString(feature.id) ?? "";
      const eventTime = isoFromEpoch(properties.time);
      const updatedAt = isoFromEpoch(properties.updated);
      const upstreamTimeMs = Date.parse(updatedAt || eventTime);
      const reviewStatus = optionalString(properties.status)?.toLowerCase();
      const eventType = optionalString(properties.type)?.toLowerCase().replace(/\s+/g, "-") ?? "seismic-event";
      return {
        observationId: eventId ? `usgs-earthquake:${eventId}` : "",
        entityId: eventId ? `usgs-earthquake:${eventId}` : "",
        entityType: eventType,
        position: {
          latitude,
          longitude,
          ...(depthKm === undefined ? {} : { altitudeMeters: -depthKm * 1_000 }),
        },
        timestamp: eventTime,
        provenance: {
          sourceFeedId: USGS_EARTHQUAKE_SOURCE_ID,
          fetchedAt: context.fetchedAt,
          receivedAt: context.receivedAt,
          ...(updatedAt ? { upstreamTimestamp: updatedAt } : {}),
          stalenessMs: Number.isFinite(receivedAtMs) && Number.isFinite(upstreamTimeMs) ? Math.max(0, receivedAtMs - upstreamTimeMs) : 0,
        },
        confidence: reviewStatus === "reviewed" ? 0.95 : reviewStatus === "automatic" ? 0.75 : 0.65,
        basis: "measured",
        retentionClass: "bulk",
        attributes: {
          magnitude: optionalNumber(properties.mag) ?? null,
          magnitudeType: optionalString(properties.magType) ?? null,
          place: optionalString(properties.place) ?? null,
          title: optionalString(properties.title) ?? null,
          depthKm: depthKm ?? null,
          significance: optionalNumber(properties.sig) ?? null,
          reviewStatus: reviewStatus ?? null,
          tsunamiFlag: properties.tsunami === 1,
          feltReports: optionalNumber(properties.felt) ?? null,
          communityIntensity: optionalNumber(properties.cdi) ?? null,
          instrumentalIntensity: optionalNumber(properties.mmi) ?? null,
          alertLevel: optionalString(properties.alert) ?? null,
          network: optionalString(properties.net) ?? null,
          code: optionalString(properties.code) ?? null,
          eventUrl: optionalString(properties.url) ?? null,
          detailUrl: optionalString(properties.detail) ?? null,
          updatedAt: updatedAt || null,
        },
        rawPayload: rawFeature,
      };
    });
  }

  health() {
    return this.reportedHealth;
  }
}
