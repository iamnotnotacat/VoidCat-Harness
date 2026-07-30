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
  type SourceCategory,
  type SourceDescriptor,
} from "../source-adapter.ts";

const EONET_ENDPOINT = "https://eonet.gsfc.nasa.gov/api/v3/events/geojson?status=open&limit=2000&days=60";
const MAX_RESPONSE_BYTES = 10_000_000;
const REQUEST_TIMEOUT_MS = 20_000;
const PROVIDER_REFRESH_FLOOR_MS = 10 * 60_000;
const MAX_EVENTS = 2_000;

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type JsonRecord = Record<string, unknown>;
type EonetPayload = { features?: unknown };
type SharedState = { payload?: EonetPayload; fetchedAt: number; active?: Promise<EonetPayload> };

export const NASA_EONET_SOURCE_ID = "nasa.eonet.events";
export const NASA_EONET_CLASSES = [
  { categoryId: "drought", entityType: "natural-event.drought", legacySourceId: "nasa.eonet.drought" },
  { categoryId: "dustHaze", entityType: "natural-event.dust-haze", legacySourceId: "nasa.eonet.dust-haze" },
  { categoryId: "earthquakes", entityType: "natural-event.earthquake", legacySourceId: "nasa.eonet.earthquakes" },
  { categoryId: "floods", entityType: "natural-event.flood", legacySourceId: "nasa.eonet.floods" },
  { categoryId: "landslides", entityType: "natural-event.landslide", legacySourceId: "nasa.eonet.landslides" },
  { categoryId: "manmade", entityType: "natural-event.manmade", legacySourceId: "nasa.eonet.manmade" },
  { categoryId: "seaLakeIce", entityType: "natural-event.ice", legacySourceId: "nasa.eonet.sea-lake-ice" },
  { categoryId: "severeStorms", entityType: "natural-event.storm", legacySourceId: "nasa.eonet.severe-storms" },
  { categoryId: "snow", entityType: "natural-event.snow", legacySourceId: "nasa.eonet.snow" },
  { categoryId: "tempExtremes", entityType: "natural-event.temperature", legacySourceId: "nasa.eonet.temperature-extremes" },
  { categoryId: "volcanoes", entityType: "natural-event.volcano", legacySourceId: "nasa.eonet.volcanoes" },
  { categoryId: "waterColor", entityType: "natural-event.water-color", legacySourceId: "nasa.eonet.water-color" },
  { categoryId: "wildfires", entityType: "natural-event.wildfire", legacySourceId: "nasa.eonet.wildfires" },
] as const;

const EONET_CLASS_BY_ID = new Map<string, (typeof NASA_EONET_CLASSES)[number]>(NASA_EONET_CLASSES.map((entry) => [entry.categoryId, entry]));

const sharedStates = new WeakMap<FetchImplementation, SharedState>();

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function boundedJson(response: Response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("NASA EONET response exceeded the 10 MB limit.");
  if (!response.body) throw new Error("NASA EONET returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("NASA EONET response exceeded the 10 MB limit."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  chunks.forEach((chunk) => { bytes.set(chunk, offset); offset += chunk.byteLength; });
  try { return JSON.parse(new TextDecoder().decode(bytes)) as EonetPayload; }
  catch { throw new Error("NASA EONET returned malformed GeoJSON."); }
}

async function sharedFetch(fetcher: FetchImplementation, context: AdapterFetchContext) {
  const state = sharedStates.get(fetcher) ?? { fetchedAt: 0 };
  sharedStates.set(fetcher, state);
  const now = Number.isFinite(Date.parse(context.requestedAt)) ? Date.parse(context.requestedAt) : Date.now();
  if (state.payload && now - state.fetchedAt < PROVIDER_REFRESH_FLOOR_MS) return state.payload;
  if (state.active) return state.active;
  state.active = (async () => {
    const response = await fetcher(EONET_ENDPOINT, {
      method: "GET",
      headers: { Accept: "application/geo+json, application/json", "User-Agent": "VoidCat-Harness/0.1 passive-natural-events" },
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    if (!response.ok) throw new SourceAdapterHttpError(`NASA EONET returned HTTP ${response.status}.`, response.status);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    // NASA's official GeoJSON route currently serves a valid JSON body with an
    // application/rss+xml header. This exception is deliberately scoped to the
    // fixed EONET endpoint; boundedJson still enforces the byte ceiling and a
    // real JSON parse before any data reaches normalization.
    const acceptedType = contentType.includes("json") || contentType.includes("geo+json") || contentType.includes("application/rss+xml");
    if (!acceptedType) throw new Error(`NASA EONET returned an unexpected content type: ${contentType || "unknown"}.`);
    const payload = await boundedJson(response);
    if (!Array.isArray(payload.features)) throw new Error("NASA EONET GeoJSON did not contain a feature list.");
    state.payload = payload;
    state.fetchedAt = now;
    return payload;
  })();
  try { return await state.active; }
  finally { state.active = undefined; }
}

function categoryIds(properties: JsonRecord) {
  return Array.isArray(properties.categories)
    ? properties.categories.map((entry) => text(record(entry).id)).filter((value): value is string => Boolean(value))
    : [];
}

function geometryPoint(geometry: JsonRecord): { latitude: number; longitude: number } | null {
  const coordinates = geometry.coordinates;
  if (geometry.type === "Point" && Array.isArray(coordinates) && Number.isFinite(coordinates[0]) && Number.isFinite(coordinates[1])) {
    return { longitude: Number(coordinates[0]), latitude: Number(coordinates[1]) };
  }
  const positions: number[][] = [];
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") { positions.push([value[0], value[1]]); return; }
    value.forEach(collect);
  };
  collect(coordinates);
  if (!positions.length) return null;
  const longitude = positions.reduce((sum, item) => sum + item[0], 0) / positions.length;
  const latitude = positions.reduce((sum, item) => sum + item[1], 0) / positions.length;
  return Number.isFinite(longitude) && Number.isFinite(latitude) && longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90
    ? { longitude, latitude }
    : null;
}

export class NasaEonetAdapter implements SourceAdapter<EonetPayload> {
  readonly descriptor: SourceDescriptor;
  private readonly fetchImplementation: FetchImplementation;
  private healthState: AdapterReportedHealth = { status: "degraded", message: "Awaiting the first NASA EONET refresh." };

  constructor(options: { fetchImplementation?: FetchImplementation } = {}) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.descriptor = {
      id: NASA_EONET_SOURCE_ID,
      displayName: "NASA EONET Natural Events",
      category: "environment" as SourceCategory,
      authTier: "tier-1",
      credentialType: "none",
      pollCadenceMs: 10 * 60_000,
      rateLimit: { requestsPerWindow: 1, windowMs: 30_000, hardHourlyBudget: 6 },
      providerDocsUrl: "https://eonet.gsfc.nasa.gov/docs/v3",
      cache: { ttlMs: 15 * 60_000, maxObservations: MAX_EVENTS },
      healthPolicy: { expectedMinimumObservations: 0, consecutiveBelowExpectedLimit: 3 },
      retentionPolicy: { mode: "live-only" },
      estimatedBytesPerDay: 500_000,
    };
  }

  async fetch(context: AdapterFetchContext) {
    try {
      const payload = await sharedFetch(this.fetchImplementation, context);
      this.healthState = { status: "healthy", message: "NASA EONET shared natural-event cache is current." };
      return payload;
    } catch (error) {
      this.healthState = { status: error instanceof SourceAdapterHttpError && error.statusCode >= 500 ? "down" : "degraded", message: error instanceof Error ? error.message : "NASA EONET request failed." };
      throw error;
    }
  }

  normalize(payload: EonetPayload, context: AdapterNormalizeContext): NormalizedObservation[] {
    const features = Array.isArray(payload.features) ? payload.features.slice(0, 2_000) : [];
    const observations = features.flatMap((candidate): NormalizedObservation[] => {
      const feature = record(candidate);
      const properties = record(feature.properties);
      const eventClass = categoryIds(properties).map((id) => EONET_CLASS_BY_ID.get(id)).find((value): value is (typeof NASA_EONET_CLASSES)[number] => Boolean(value));
      if (!eventClass) return [];
      const position = geometryPoint(record(feature.geometry));
      const id = text(feature.id) ?? text(properties.id);
      if (!position || !id) return [];
      const sourceList = Array.isArray(properties.sources) ? properties.sources.map(record) : [];
      const eventUrl = sourceList.map((source) => text(source.url)).find(Boolean) ?? text(properties.link) ?? "https://eonet.gsfc.nasa.gov/";
      const upstream = text(properties.date);
      const timestamp = upstream && Number.isFinite(Date.parse(upstream)) ? new Date(upstream).toISOString() : context.fetchedAt;
      const stalenessMs = Math.max(0, Date.parse(context.receivedAt) - Date.parse(timestamp));
      const geometry = record(feature.geometry);
      return [{
        observationId: `${NASA_EONET_SOURCE_ID}:${id}`,
        entityId: `eonet-event:${id}`,
        entityType: eventClass.entityType,
        position,
        timestamp,
        provenance: { sourceFeedId: this.descriptor.id, fetchedAt: context.fetchedAt, receivedAt: context.receivedAt, ...(upstream ? { upstreamTimestamp: timestamp } : {}), stalenessMs },
        confidence: 0.88,
        basis: "measured",
        retentionClass: "bulk",
        attributes: {
          title: text(properties.title) ?? `${eventClass.categoryId} event`,
          eventCategory: eventClass.categoryId,
          description: text(properties.description) ?? "NASA EONET open natural-event record.",
          magnitude: number(properties.magnitudeValue) ?? -1,
          magnitudeUnit: text(properties.magnitudeUnit) ?? "unknown",
          severity: "active",
          eventUrl,
          geometry: ["Polygon", "MultiPolygon"].includes(String(geometry.type)) ? geometry : undefined,
          sourceName: "NASA Earth Observatory Natural Event Tracker",
          coverageLimitation: "EONET is a curated natural-event catalog; reporting can be delayed and absence is not proof that no event exists.",
        },
        rawPayload: feature,
      }];
    }).slice(0, MAX_EVENTS);
    const representedClasses = new Set(observations.map((observation) => String(observation.attributes.eventCategory))).size;
    this.healthState = { status: "healthy", message: `${observations.length} active natural event${observations.length === 1 ? "" : "s"} across ${representedClasses} EONET class${representedClasses === 1 ? "" : "es"}.` };
    return observations;
  }

  health() { return this.healthState; }
}

export function createNasaEonetAdapters() {
  return [new NasaEonetAdapter()];
}
