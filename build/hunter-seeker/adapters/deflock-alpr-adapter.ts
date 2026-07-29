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
  voidcat?: { skipped?: boolean; reason?: string; viewport?: DeflockViewport };
};

const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";
const MAX_RESPONSE_BYTES = 5_000_000;

export const DEFLOCK_ALPR_DESCRIPTOR: SourceDescriptor = {
  id: DEFLOCK_ALPR_SOURCE_ID,
  displayName: "DeFlock Camera Registry",
  category: "infrastructure",
  authTier: "tier-1",
  credentialType: "none",
  pollCadenceMs: 2 * 60_000,
  rateLimit: { requestsPerWindow: 1, windowMs: 30_000, hardHourlyBudget: 30 },
  providerDocsUrl: "https://deflock.org/",
  cache: { ttlMs: 15 * 60_000, maxObservations: 4_000 },
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
  return `[out:json][timeout:15];\n(\n  node["man_made"="surveillance"]["surveillance:type"~"^(ALPR|ANPR|license_plate)$",i](${bbox});\n);\nout meta;`;
}

function cameraTitle(tags: Record<string, string>) {
  const manufacturer = tags.manufacturer || tags.brand || tags["camera:manufacturer"];
  if (manufacturer) return `${manufacturer.toUpperCase()} ALPR CAMERA`;
  return "ALPR CAMERA";
}

export class DeflockAlprAdapter implements SourceAdapter<OverpassAlprPayload> {
  readonly descriptor = DEFLOCK_ALPR_DESCRIPTOR;
  private viewport: DeflockViewport | null = null;
  private healthState: AdapterReportedHealth = { status: "healthy", message: `Zoom to level ${DEFLOCK_MINIMUM_ZOOM}+ to load visible DeFlock cameras.` };

  setViewport(viewport: DeflockViewport) {
    this.viewport = validateDeflockViewport(viewport);
    this.healthState = deflockViewportReady(this.viewport)
      ? { status: "healthy", message: "Visible DeFlock camera bounds are ready." }
      : { status: "healthy", message: `Zoom to level ${DEFLOCK_MINIMUM_ZOOM}+ to load visible DeFlock cameras.` };
    return this.viewport;
  }

  currentViewport() {
    return this.viewport ? { ...this.viewport } : null;
  }

  async fetch({ signal }: { signal: AbortSignal; requestedAt: string }): Promise<OverpassAlprPayload> {
    const viewport = this.viewport;
    if (!viewport || !deflockViewportReady(viewport)) {
      return { elements: [], voidcat: { skipped: true, reason: "zoom-required", ...(viewport ? { viewport } : {}) } };
    }
    try {
      const response = await fetch(OVERPASS_ENDPOINT, {
        method: "POST",
        signal,
        redirect: "error",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": "VoidCat-Harness/0.0.4 (passive DeFlock map layer)",
        },
        body: new URLSearchParams({ data: buildDeflockOverpassQuery(viewport) }),
      });
      const retryAfterSeconds = Number(response.headers.get("retry-after"));
      const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1_000 : undefined;
      if (!response.ok) throw new SourceAdapterHttpError(`DeFlock camera source returned HTTP ${response.status}.`, response.status, retryAfterMs);
      const declaredBytes = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredBytes) && declaredBytes > MAX_RESPONSE_BYTES) throw new SourceAdapterHttpError("DeFlock camera response exceeded the 5 MB safety limit.", 413);
      const body = await response.text();
      if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) throw new SourceAdapterHttpError("DeFlock camera response exceeded the 5 MB safety limit.", 413);
      const payload = JSON.parse(body) as OverpassAlprPayload;
      this.healthState = { status: "healthy", message: "Visible DeFlock camera records loaded from OpenStreetMap." };
      return payload;
    } catch (error) {
      if (error instanceof SourceAdapterHttpError) throw error;
      this.healthState = { status: "degraded", message: error instanceof Error ? error.message : "DeFlock camera source failed." };
      throw new SourceAdapterHttpError(this.healthState.message ?? "DeFlock camera source failed.", 503);
    }
  }

  normalize(payload: OverpassAlprPayload, context: { fetchedAt: string; receivedAt: string }): NormalizedObservation[] {
    if (!Array.isArray(payload.elements)) return [];
    const baseTimestamp = text(payload.osm3s?.timestamp_osm_base);
    return payload.elements.flatMap((candidate): NormalizedObservation[] => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
      const element = candidate as OverpassAlprElement;
      if (element.type !== "node" || !finite(element.id) || !finite(element.lat) || !finite(element.lon)) return [];
      const tags = tagsOf(element.tags);
      const surveillanceType = (tags["surveillance:type"] || "").toLowerCase();
      if (!/^(alpr|anpr|license_plate)$/.test(surveillanceType)) return [];
      const upstreamTimestamp = text(element.timestamp) || baseTimestamp;
      const observedAt = Number.isFinite(Date.parse(upstreamTimestamp)) ? upstreamTimestamp : context.fetchedAt;
      const stalenessMs = Math.max(0, Date.parse(context.receivedAt) - Date.parse(observedAt));
      const osmId = Math.trunc(element.id);
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
          sourceName: "DeFlock / OpenStreetMap",
          coverageLimitation: "Crowdsourced known-camera locations only; absence does not establish that an area has no ALPR cameras.",
        },
        rawPayload: element,
      }];
    });
  }

  health() {
    return this.healthState;
  }
}
