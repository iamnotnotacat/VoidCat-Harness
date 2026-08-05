/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import type { NormalizedObservation } from "./source-adapter.ts";

export type CommonEventPosition = [number, number] | [number, number, number];
export type CommonEventGeometry =
  | { type: "Point"; coordinates: CommonEventPosition }
  | { type: "MultiPoint" | "LineString"; coordinates: CommonEventPosition[] }
  | { type: "MultiLineString" | "Polygon"; coordinates: CommonEventPosition[][] }
  | { type: "MultiPolygon"; coordinates: CommonEventPosition[][][] };

export type CommonEventEntity = { id: string; type: string; name?: string; identifiers?: Record<string, string> };
export type CommonEvent = {
  source: string;
  sourceEventId: string;
  eventType: string;
  observedAt: string;
  publishedAt: string | null;
  geometry: CommonEventGeometry;
  severity: number | null;
  confidence: number;
  entities: CommonEventEntity[];
  properties: Record<string, unknown>;
  sourceUrl: string | null;
  license: string;
  retrievedAt: string;
};

const SEVERITY_LABELS: Record<string, number> = { unknown: 0.25, minor: 0.25, moderate: 0.5, severe: 0.75, extreme: 1 };

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeWebUrl(value: unknown) {
  const candidate = text(value);
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function finiteUnitInterval(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
}

function normalizedSeverity(attributes: Record<string, unknown>) {
  const numeric = finiteUnitInterval(attributes.severityScore ?? attributes.severity);
  if (numeric !== null) return numeric;
  const label = text(attributes.severity)?.toLowerCase();
  return label && label in SEVERITY_LABELS ? SEVERITY_LABELS[label] : null;
}

function isPosition(value: unknown): value is CommonEventPosition {
  if (!Array.isArray(value) || (value.length !== 2 && value.length !== 3)) return false;
  if (!value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))) return false;
  return value[0] >= -180 && value[0] <= 180 && value[1] >= -90 && value[1] <= 90;
}

function isGeometry(value: unknown): value is CommonEventGeometry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as { type?: unknown; coordinates?: unknown };
  if (candidate.type === "Point") return isPosition(candidate.coordinates);
  if (candidate.type === "MultiPoint" || candidate.type === "LineString") return Array.isArray(candidate.coordinates) && candidate.coordinates.length > 0 && candidate.coordinates.every(isPosition);
  if (candidate.type === "MultiLineString" || candidate.type === "Polygon") return Array.isArray(candidate.coordinates) && candidate.coordinates.length > 0 && candidate.coordinates.every((line) => Array.isArray(line) && line.length > 0 && line.every(isPosition));
  if (candidate.type === "MultiPolygon") return Array.isArray(candidate.coordinates) && candidate.coordinates.length > 0 && candidate.coordinates.every((polygon) => Array.isArray(polygon) && polygon.length > 0 && polygon.every((ring) => Array.isArray(ring) && ring.length > 0 && ring.every(isPosition)));
  return false;
}

function normalizedEntities(observation: NormalizedObservation): CommonEventEntity[] {
  const supplied = observation.attributes.entities;
  if (Array.isArray(supplied)) {
    const valid = supplied.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const candidate = entry as Record<string, unknown>;
      const id = text(candidate.id);
      const type = text(candidate.type);
      if (!id || !type) return [];
      const name = text(candidate.name);
      const identifiers = candidate.identifiers && typeof candidate.identifiers === "object" && !Array.isArray(candidate.identifiers)
        ? Object.fromEntries(Object.entries(candidate.identifiers as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1].trim())))
        : undefined;
      return [{ id, type, ...(name ? { name } : {}), ...(identifiers && Object.keys(identifiers).length ? { identifiers } : {}) }];
    });
    if (valid.length) return valid;
  }
  const name = text(observation.attributes.name ?? observation.attributes.title);
  return [{ id: observation.entityId, type: observation.entityType, ...(name ? { name } : {}) }];
}

function sourceEventId(observation: NormalizedObservation) {
  return text(observation.attributes.sourceEventId)
    ?? text(observation.attributes.eventId)
    ?? (observation.observationId.slice(observation.provenance.sourceFeedId.length + 1) || observation.observationId);
}

export function toCommonEvent(observation: NormalizedObservation): CommonEvent {
  const suppliedGeometry = observation.attributes.geometry;
  const geometry: CommonEventGeometry = isGeometry(suppliedGeometry) ? suppliedGeometry : {
    type: "Point",
    coordinates: observation.position.altitudeMeters === undefined
      ? [observation.position.longitude, observation.position.latitude]
      : [observation.position.longitude, observation.position.latitude, observation.position.altitudeMeters],
  };
  const event: CommonEvent = {
    source: observation.provenance.sourceFeedId,
    sourceEventId: sourceEventId(observation),
    eventType: text(observation.attributes.eventType) ?? observation.entityType.replaceAll(".", "_"),
    observedAt: observation.timestamp,
    publishedAt: text(observation.attributes.publishedAt),
    geometry,
    severity: normalizedSeverity(observation.attributes),
    confidence: observation.confidence,
    entities: normalizedEntities(observation),
    properties: { ...observation.attributes },
    sourceUrl: safeWebUrl(observation.attributes.sourceUrl ?? observation.attributes.url),
    license: text(observation.attributes.license) ?? "Provider-specific terms; verify before redistribution",
    retrievedAt: observation.provenance.fetchedAt,
  };
  validateCommonEvent(event);
  return event;
}

export function validateCommonEvent(event: CommonEvent) {
  const issues: string[] = [];
  if (!event.source?.trim()) issues.push("source is required");
  if (!event.sourceEventId?.trim()) issues.push("sourceEventId is required");
  if (!event.eventType?.trim()) issues.push("eventType is required");
  if (!Number.isFinite(Date.parse(event.observedAt))) issues.push("observedAt must be a timestamp");
  if (event.publishedAt !== null && !Number.isFinite(Date.parse(event.publishedAt))) issues.push("publishedAt must be null or a timestamp");
  if (!Number.isFinite(Date.parse(event.retrievedAt))) issues.push("retrievedAt must be a timestamp");
  if (!isGeometry(event.geometry)) issues.push("geometry must be valid WGS84 GeoJSON");
  if (event.severity !== null && (!Number.isFinite(event.severity) || event.severity < 0 || event.severity > 1)) issues.push("severity must be null or between zero and one");
  if (!Number.isFinite(event.confidence) || event.confidence < 0 || event.confidence > 1) issues.push("confidence must be between zero and one");
  if (!Array.isArray(event.entities)) issues.push("entities must be an array");
  if (!event.properties || typeof event.properties !== "object" || Array.isArray(event.properties)) issues.push("properties must be an object");
  if (event.sourceUrl !== null && !safeWebUrl(event.sourceUrl)) issues.push("sourceUrl must be null or HTTP(S)");
  if (!event.license?.trim()) issues.push("license is required");
  if (issues.length) throw new Error(`Common event failed validation: ${issues.join("; ")}`);
}
