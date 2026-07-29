export type HunterSeekerObservation = {
  observationId: string;
  entityId: string;
  entityType: string;
  position: { latitude: number; longitude: number; altitudeMeters?: number };
  timestamp: string;
  provenance: {
    sourceFeedId: string;
    fetchedAt: string;
    receivedAt: string;
    upstreamTimestamp?: string;
    stalenessMs: number;
  };
  confidence: number;
  basis: "measured" | "derived" | "estimated";
  retentionClass: "bulk" | "protected" | "derived";
  attributes: Record<string, unknown>;
};

type Position = [number, number];
type PointGeometry = { type: "Point"; coordinates: Position };
type PolygonGeometry = { type: "Polygon"; coordinates: Position[][] };
type MultiPolygonGeometry = { type: "MultiPolygon"; coordinates: Position[][][] };
type MapGeometry = PointGeometry | PolygonGeometry | MultiPolygonGeometry;

export type HunterSeekerMapFeature = {
  type: "Feature";
  id: string;
  properties: {
    observationId: string;
    sourceId: string;
    kind: "military-aircraft-point" | "civilian-aircraft-point" | "maritime-vessel-point" | "space-station-point" | "alpr-camera-point" | "seismic-point" | "weather-point" | "weather-area";
    magnitude: number;
    severity: string;
    stalenessMinutes: number;
    headingDegrees: number;
    freshness: "live" | "cached" | "stale" | "degraded" | "acquiring" | "offline";
  };
  geometry: MapGeometry;
};

export type HunterSeekerFeatureCollection = {
  type: "FeatureCollection";
  features: HunterSeekerMapFeature[];
};

const NWS_SOURCE_ID = "noaa.nws-alerts";
const ADSB_LOL_MILITARY_SOURCE_ID = "adsb.lol.military";
const CELESTRAK_STATIONS_SOURCE_ID = "celestrak.space-stations";
const DEFLOCK_ALPR_SOURCE_ID = "deflock.osm-alpr";

function textAttribute(observation: HunterSeekerObservation, key: string) {
  const value = observation.attributes[key];
  return typeof value === "string" && value.trim() ? value : "";
}

function numberAttribute(observation: HunterSeekerObservation, key: string) {
  const value = observation.attributes[key];
  return typeof value === "number" && Number.isFinite(value) ? value : -1;
}

function parsePosition(value: unknown): Position | null {
  if (!Array.isArray(value) || value.length < 2 || typeof value[0] !== "number" || typeof value[1] !== "number") return null;
  if (!Number.isFinite(value[0]) || !Number.isFinite(value[1]) || value[0] < -180 || value[0] > 180 || value[1] < -90 || value[1] > 90) return null;
  return [value[0], value[1]];
}

function parseRing(value: unknown) {
  if (!Array.isArray(value)) return null;
  const positions = value.map(parsePosition);
  return positions.length >= 4 && positions.every((position): position is Position => position !== null) ? positions : null;
}

function parsePolygonCoordinates(value: unknown) {
  if (!Array.isArray(value)) return null;
  const rings = value.map(parseRing);
  return rings.length && rings.every((ring): ring is Position[] => ring !== null) ? rings : null;
}

function providerGeometry(observation: HunterSeekerObservation): PolygonGeometry | MultiPolygonGeometry | null {
  const geometry = observation.attributes.geometry;
  if (!geometry || typeof geometry !== "object" || Array.isArray(geometry)) return null;
  const candidate = geometry as { type?: unknown; coordinates?: unknown };
  if (candidate.type === "Polygon") {
    const coordinates = parsePolygonCoordinates(candidate.coordinates);
    return coordinates ? { type: "Polygon", coordinates } : null;
  }
  if (candidate.type === "MultiPolygon" && Array.isArray(candidate.coordinates)) {
    const polygons = candidate.coordinates.map(parsePolygonCoordinates);
    return polygons.length && polygons.every((polygon): polygon is Position[][] => polygon !== null)
      ? { type: "MultiPolygon", coordinates: polygons }
      : null;
  }
  return null;
}

function properties(observation: HunterSeekerObservation, kind: HunterSeekerMapFeature["properties"]["kind"], freshnessByObservationId: Record<string, HunterSeekerMapFeature["properties"]["freshness"]>) {
  return {
    observationId: observation.observationId,
    sourceId: observation.provenance.sourceFeedId,
    kind,
    magnitude: numberAttribute(observation, "magnitude"),
    severity: textAttribute(observation, "severity") || "unknown",
    stalenessMinutes: Math.max(0, observation.provenance.stalenessMs / 60_000),
    headingDegrees: Math.max(0, numberAttribute(observation, "trackDegrees")),
    freshness: freshnessByObservationId[observation.observationId] ?? "degraded",
  };
}

export function buildHunterSeekerMapData(observations: HunterSeekerObservation[], freshnessByObservationId: Record<string, HunterSeekerMapFeature["properties"]["freshness"]> = {}): HunterSeekerFeatureCollection {
  const features: HunterSeekerMapFeature[] = [];
  observations.forEach((observation) => {
    const point: PointGeometry = {
      type: "Point",
      coordinates: [observation.position.longitude, observation.position.latitude],
    };
    if (observation.provenance.sourceFeedId === NWS_SOURCE_ID) {
      const geometry = providerGeometry(observation);
      if (geometry) features.push({
        type: "Feature",
        id: `${observation.observationId}:area`,
        properties: properties(observation, "weather-area", freshnessByObservationId),
        geometry,
      });
      features.push({
        type: "Feature",
        id: `${observation.observationId}:point`,
        properties: properties(observation, "weather-point", freshnessByObservationId),
        geometry: point,
      });
      return;
    }
    if (observation.provenance.sourceFeedId === ADSB_LOL_MILITARY_SOURCE_ID) {
      features.push({
        type: "Feature",
        id: `${observation.observationId}:point`,
        properties: properties(observation, "military-aircraft-point", freshnessByObservationId),
        geometry: point,
      });
      return;
    }
    if (observation.entityType.includes("aircraft")) {
      features.push({
        type: "Feature",
        id: `${observation.observationId}:point`,
        properties: properties(observation, "civilian-aircraft-point", freshnessByObservationId),
        geometry: point,
      });
      return;
    }
    if (observation.entityType.includes("vessel") || observation.entityType.includes("maritime")) {
      features.push({
        type: "Feature",
        id: `${observation.observationId}:point`,
        properties: properties(observation, "maritime-vessel-point", freshnessByObservationId),
        geometry: point,
      });
      return;
    }
    if (observation.provenance.sourceFeedId === CELESTRAK_STATIONS_SOURCE_ID || observation.entityType.includes("satellite") || observation.entityType.includes("space-station")) {
      features.push({
        type: "Feature",
        id: `${observation.observationId}:point`,
        properties: properties(observation, "space-station-point", freshnessByObservationId),
        geometry: point,
      });
      return;
    }
    if (observation.provenance.sourceFeedId === DEFLOCK_ALPR_SOURCE_ID || observation.entityType.includes("alpr-camera")) {
      features.push({
        type: "Feature",
        id: `${observation.observationId}:point`,
        properties: properties(observation, "alpr-camera-point", freshnessByObservationId),
        geometry: point,
      });
      return;
    }
    features.push({
      type: "Feature",
      id: `${observation.observationId}:point`,
      properties: properties(observation, "seismic-point", freshnessByObservationId),
      geometry: point,
    });
  });
  return { type: "FeatureCollection", features };
}
