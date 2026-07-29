/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import {
  SourceAdapterHttpError,
  type AdapterReportedHealth,
  type NormalizedObservation,
  type SourceAdapter,
  type SourceDescriptor,
} from "../source-adapter.ts";

export const DEFLOCK_ALPR_SOURCE_ID = "deflock.osm-alpr";
export const DEFLOCK_MINIMUM_ZOOM = 6;
export const DEFLOCK_MAXIMUM_VIEWPORT_AREA = 625;
export const DEFLOCK_DAILY_REFRESH_MS = 24 * 60 * 60_000;

export type DeflockViewport = {
  south: number;
  west: number;
  north: number;
  east: number;
  zoom: number;
};

export type OverpassAlprElement = {
  type?: unknown;
  id?: unknown;
  lat?: unknown;
  lon?: unknown;
  timestamp?: unknown;
  tags?: unknown;
};

export type OverpassAlprPayload = {
  elements?: unknown;
  osm3s?: { timestamp_osm_base?: unknown };
  voidcat?: {
    skipped?: boolean;
    reason?: string;
    viewport?: DeflockViewport;
    coverage?: "worldwide";
    tileCount?: number;
    fetchedBytes?: number;
    activeRegion?: string;
    regionMarkers?: DeflockRegionMarker[];
  };
};

type DeflockTileIndex = { expiration_utc?: unknown; regions?: unknown; tile_url?: unknown; tile_size_degrees?: unknown };
export type DeflockRegionMarker = { id: string; label: string; latitude: number; longitude: number; south: number; west: number; north: number; east: number };
type CachedTile = { body: string; expiresAt: number; bytes: number; count: number };

const DEFLOCK_INDEX_ENDPOINT = "https://cdn.deflock.me/regions/index.json";
const DEFLOCK_CDN_ORIGIN = "https://cdn.deflock.me";
const MAX_INDEX_BYTES = 256_000;
const MAX_TILE_BYTES = 8_000_000;
const MAX_WORLD_TILES = 120;
const MAX_WORLD_CAMERAS = 250_000;

export const DEFLOCK_ALPR_DESCRIPTOR: SourceDescriptor = {
  id: DEFLOCK_ALPR_SOURCE_ID,
  displayName: "DeFlock Camera Registry",
  category: "infrastructure",
  authTier: "tier-1",
  credentialType: "none",
  pollCadenceMs: DEFLOCK_DAILY_REFRESH_MS,
  rateLimit: { requestsPerWindow: MAX_WORLD_TILES + 1, windowMs: DEFLOCK_DAILY_REFRESH_MS, hardHourlyBudget: 30 },
  providerDocsUrl: "https://deflock.org/",
  cache: { ttlMs: DEFLOCK_DAILY_REFRESH_MS, maxObservations: MAX_WORLD_CAMERAS, replaceOnWrite: true },
  healthPolicy: { expectedMinimumObservations: 0, consecutiveBelowExpectedLimit: 3 },
  retentionPolicy: { mode: "live-only" },
  estimatedBytesPerDay: 0,
};

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function tagsOf(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export function validateDeflockViewport(viewport: DeflockViewport) {
  const { south, west, north, east, zoom } = viewport;
  if (![south, west, north, east, zoom].every(Number.isFinite)) throw new Error("DeFlock map bounds must be finite numbers.");
  if (south < -90 || north > 90 || south >= north) throw new Error("DeFlock latitude bounds are invalid.");
  if (west < -180 || east > 180 || west >= east) throw new Error("DeFlock longitude bounds are invalid.");
  if (zoom < 0 || zoom > 24) throw new Error("DeFlock map zoom is invalid.");
  return { south, west, north, east, zoom };
}

export function deflockViewportReady(viewport: DeflockViewport | null) {
  if (!viewport || viewport.zoom < DEFLOCK_MINIMUM_ZOOM) return false;
  return (viewport.north - viewport.south) * (viewport.east - viewport.west) <= DEFLOCK_MAXIMUM_VIEWPORT_AREA;
}

export function buildDeflockOverpassQuery(viewport: DeflockViewport) {
  const bbox = `${viewport.south.toFixed(6)},${viewport.west.toFixed(6)},${viewport.north.toFixed(6)},${viewport.east.toFixed(6)}`;
  return `[out:json][timeout:15];\n(\n  node["surveillance:type"~"^(ALPR|ANPR|LPR|license_plate|license_plate_reader)$",i](${bbox});\n);\nout meta;`;
}

function cameraTitle(tags: Record<string, string>) {
  const manufacturer = tags.manufacturer || tags.brand || tags["camera:manufacturer"];
  if (manufacturer) return `${manufacturer.toUpperCase()} ALPR CAMERA`;
  return "ALPR CAMERA";
}

function coordinateLabel(latitude: number, longitude: number) {
  const lat = `${Math.abs(latitude).toFixed(0)}°${latitude < 0 ? "S" : "N"}`;
  const lon = `${Math.abs(longitude).toFixed(0)}°${longitude < 0 ? "W" : "E"}`;
  return `DEFLOCK SECTOR ${lat} ${lon}`;
}

function regionMarker(id: string, tileSize: number): DeflockRegionMarker | null {
  const [southText, westText] = id.split("/");
  const south = Number(southText);
  const west = Number(westText);
  if (!Number.isFinite(south) || !Number.isFinite(west)) return null;
  const size = Number.isFinite(tileSize) && tileSize > 0 && tileSize <= 45 ? tileSize : 20;
  const north = Math.min(90, south + size);
  const east = Math.min(180, west + size);
  const latitude = (south + north) / 2;
  const longitude = (west + east) / 2;
  return { id, label: coordinateLabel(latitude, longitude), latitude, longitude, south, west, north, east };
}

export class DeflockAlprAdapter implements SourceAdapter<OverpassAlprPayload> {
  readonly descriptor = DEFLOCK_ALPR_DESCRIPTOR;
  private viewport: DeflockViewport | null = null;
  private activeRegion: string | null = null;
  private indexCache: { markers: DeflockRegionMarker[]; tileTemplate: string; expiresAt: number; bytes: number } | null = null;
  private readonly tileCache = new Map<string, CachedTile>();
  private healthState: AdapterReportedHealth = { status: "healthy", message: "Worldwide DeFlock region index is ready for its daily pull." };

  setViewport(viewport: DeflockViewport) {
    this.viewport = validateDeflockViewport(viewport);
    return this.viewport;
  }

  currentViewport() {
    return this.viewport ? { ...this.viewport } : null;
  }

  selectRegion(regionId: string | null) {
    if (regionId !== null && !/^-?\d+(?:\.\d+)?\/-?\d+(?:\.\d+)?$/.test(regionId)) throw new Error("DeFlock region ID is invalid.");
    this.activeRegion = regionId;
    return this.activeRegion;
  }

  selectViewportRegion(viewport: DeflockViewport) {
    const validated = this.setViewport(viewport);
    const centerLatitude = (validated.south + validated.north) / 2;
    const centerLongitude = (validated.west + validated.east) / 2;
    const marker = this.indexCache?.markers.find((candidate) => centerLatitude >= candidate.south && centerLatitude <= candidate.north && centerLongitude >= candidate.west && centerLongitude <= candidate.east);
    this.activeRegion = marker?.id ?? null;
    return this.activeRegion;
  }

  private async index(signal: AbortSignal) {
    if (this.indexCache && Date.now() < this.indexCache.expiresAt) return this.indexCache;
    const response = await fetch(DEFLOCK_INDEX_ENDPOINT, { signal, redirect: "error", headers: { "Accept": "application/json", "User-Agent": "VoidCat-Harness/0.0.4 (daily passive DeFlock region index)" } });
    if (!response.ok) throw new SourceAdapterHttpError(`DeFlock tile index returned HTTP ${response.status}.`, response.status);
    const body = await response.text();
    const bytes = Buffer.byteLength(body, "utf8");
    if (bytes > MAX_INDEX_BYTES) throw new SourceAdapterHttpError("DeFlock tile index exceeded its safety limit.", 413);
    const parsed = JSON.parse(body) as DeflockTileIndex;
    if (!Array.isArray(parsed.regions) || typeof parsed.tile_url !== "string") throw new SourceAdapterHttpError("DeFlock tile index was malformed.", 502);
    const ids = [...new Set(parsed.regions.filter((value): value is string => typeof value === "string" && /^-?\d+(?:\.\d+)?\/-?\d+(?:\.\d+)?$/.test(value)))];
    if (!ids.length || ids.length > MAX_WORLD_TILES) throw new SourceAdapterHttpError("DeFlock tile index advertised an unsafe number of regions.", 502);
    const tileSize = typeof parsed.tile_size_degrees === "number" ? parsed.tile_size_degrees : 20;
    const markers = ids.map((id) => regionMarker(id, tileSize)).filter((value): value is DeflockRegionMarker => value !== null);
    this.indexCache = { markers, tileTemplate: parsed.tile_url, expiresAt: Date.now() + DEFLOCK_DAILY_REFRESH_MS, bytes };
    return this.indexCache;
  }

  private async tile(regionId: string, index: { tileTemplate: string }, signal: AbortSignal) {
    const cached = this.tileCache.get(regionId);
    if (cached && Date.now() < cached.expiresAt) return cached;
    const tileUrl = new URL(index.tileTemplate.replace("{lat}/{lon}", regionId), DEFLOCK_CDN_ORIGIN);
    if (tileUrl.origin !== DEFLOCK_CDN_ORIGIN || !tileUrl.pathname.startsWith("/regions/")) throw new SourceAdapterHttpError("DeFlock tile index attempted to leave its fixed CDN.", 502);
    const response = await fetch(tileUrl, { signal, redirect: "error", headers: { "Accept": "application/json", "User-Agent": "VoidCat-Harness/0.0.4 (on-demand DeFlock region layer)" } });
    if (!response.ok) throw new SourceAdapterHttpError(`DeFlock region ${regionId} returned HTTP ${response.status}.`, response.status);
    const declaredBytes = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_TILE_BYTES) throw new SourceAdapterHttpError(`DeFlock region ${regionId} exceeded its safety limit.`, 413);
    const body = await response.text();
    const bytes = Buffer.byteLength(body, "utf8");
    if (bytes > MAX_TILE_BYTES) throw new SourceAdapterHttpError(`DeFlock region ${regionId} exceeded its safety limit.`, 413);
    const parsed = JSON.parse(body) as unknown;
    if (!Array.isArray(parsed) || parsed.length > MAX_WORLD_CAMERAS) throw new SourceAdapterHttpError(`DeFlock region ${regionId} was malformed or too large.`, 502);
    const entry = { body, bytes, count: parsed.length, expiresAt: Date.now() + DEFLOCK_DAILY_REFRESH_MS };
    this.tileCache.set(regionId, entry);
    return entry;
  }

  async fetch({ signal }: { signal: AbortSignal; requestedAt: string }): Promise<OverpassAlprPayload> {
    try {
      const index = await this.index(signal);
      let elements: unknown[] = [];
      let fetchedBytes = index.bytes;
      if (this.activeRegion) {
        if (!index.markers.some((marker) => marker.id === this.activeRegion)) throw new SourceAdapterHttpError("The selected DeFlock region is no longer advertised.", 404);
        const tile = await this.tile(this.activeRegion, index, signal);
        elements = JSON.parse(tile.body) as unknown[];
        fetchedBytes += tile.bytes;
      }
      this.healthState = { status: "healthy", message: this.activeRegion
        ? `${elements.length.toLocaleString()} cameras loaded for ${index.markers.find((marker) => marker.id === this.activeRegion)?.label ?? this.activeRegion}; region data is cached for 24 hours.`
        : `${index.markers.length} worldwide DeFlock sectors ready; select a map hub to load cameras.` };
      return { elements, voidcat: { coverage: "worldwide", tileCount: index.markers.length, fetchedBytes, regionMarkers: index.markers, ...(this.activeRegion ? { activeRegion: this.activeRegion } : {}) } };
    } catch (error) {
      if (error instanceof SourceAdapterHttpError) throw error;
      this.healthState = { status: "degraded", message: error instanceof Error ? error.message : "DeFlock worldwide camera source failed." };
      throw new SourceAdapterHttpError(this.healthState.message ?? "DeFlock camera source failed.", 503);
    }
  }

  normalize(payload: OverpassAlprPayload, context: { fetchedAt: string; receivedAt: string }): NormalizedObservation[] {
    if (!Array.isArray(payload.elements)) return [];
    const baseTimestamp = text(payload.osm3s?.timestamp_osm_base);
    const regionObservations = (payload.voidcat?.regionMarkers ?? []).map((marker): NormalizedObservation => ({
      observationId: `${DEFLOCK_ALPR_SOURCE_ID}:region:${marker.id}`,
      entityId: `deflock-region:${marker.id}`,
      entityType: "infrastructure.deflock-region",
      position: { latitude: marker.latitude, longitude: marker.longitude },
      timestamp: context.fetchedAt,
      provenance: { sourceFeedId: DEFLOCK_ALPR_SOURCE_ID, fetchedAt: context.fetchedAt, receivedAt: context.receivedAt, stalenessMs: 0 },
      confidence: 1,
      basis: "derived",
      retentionClass: "bulk",
      attributes: { title: marker.label, regionId: marker.id, regionLabel: marker.label, regionBounds: { south: marker.south, west: marker.west, north: marker.north, east: marker.east }, active: marker.id === payload.voidcat?.activeRegion, sourceName: "DeFlock worldwide region index", coverageLimitation: "A region hub indicates an available DeFlock data sector; click it to load known cameras in that sector." },
    }));
    const cameras = payload.elements.flatMap((candidate): NormalizedObservation[] => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
      const element = candidate as OverpassAlprElement;
      const numericId = typeof element.id === "string" ? Number(element.id) : element.id;
      if ((element.type !== undefined && element.type !== "node") || !finite(numericId) || !finite(element.lat) || !finite(element.lon)) return [];
      const tags = tagsOf(element.tags);
      const surveillanceType = (tags["surveillance:type"] || "alpr").toLowerCase();
      if (!/^(alpr|anpr|lpr|license_plate|license_plate_reader)$/.test(surveillanceType)) return [];
      const upstreamTimestamp = text(element.timestamp) || baseTimestamp;
      const observedAt = Number.isFinite(Date.parse(upstreamTimestamp)) ? upstreamTimestamp : context.fetchedAt;
      const stalenessMs = Math.max(0, Date.parse(context.receivedAt) - Date.parse(observedAt));
      const osmId = Math.trunc(numericId);
      const manufacturer = tags.manufacturer || tags.brand || tags["camera:manufacturer"] || "unknown";
      const isFlock = /flock/i.test(manufacturer);
      return [{
        observationId: `${DEFLOCK_ALPR_SOURCE_ID}:node:${osmId}`,
        entityId: `alpr-camera:osm-node:${osmId}`,
        entityType: "infrastructure.alpr-camera",
        position: { latitude: element.lat, longitude: element.lon },
        timestamp: observedAt,
        provenance: {
          sourceFeedId: DEFLOCK_ALPR_SOURCE_ID,
          fetchedAt: context.fetchedAt,
          receivedAt: context.receivedAt,
          ...(upstreamTimestamp ? { upstreamTimestamp } : {}),
          stalenessMs,
        },
        confidence: isFlock ? 0.96 : manufacturer === "unknown" ? 0.78 : 0.9,
        basis: "measured",
        retentionClass: "bulk",
        attributes: {
          title: cameraTitle(tags),
          cameraType: "automatic-license-plate-reader",
          manufacturer,
          isFlockSafety: isFlock,
          direction: tags.direction || "unknown",
          operator: tags.operator || "unknown",
          surveillanceZone: tags["surveillance:zone"] || "unknown",
          network: tags.network || "unknown",
          osmElementType: "node",
          osmElementId: String(osmId),
          eventUrl: `https://www.openstreetmap.org/node/${osmId}`,
          sourceName: "DeFlock worldwide registry / OpenStreetMap",
          coverageLimitation: "Crowdsourced known-camera locations only; absence does not establish that an area has no ALPR cameras.",
        },
        rawPayload: element,
      }];
    });
    return [...regionObservations, ...cameras];
  }

  health() {
    return this.healthState;
  }
}
