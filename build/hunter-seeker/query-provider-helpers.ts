/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import { createHash } from "node:crypto";
import type { NormalizedObservation, ObservationBasis } from "./source-adapter.ts";
import type { CommonEventGeometry } from "./common-event.ts";
import type { HunterBoundingBox, HunterSourceQueryContext } from "./source-query.ts";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function stableId(value: unknown) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 24);
}

export function text(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : null; }
export function number(value: unknown) { const candidate = typeof value === "number" ? value : Number(value); return Number.isFinite(candidate) ? candidate : null; }
export function timestamp(value: unknown, fallback: string) { const candidate = text(value); return candidate && Number.isFinite(Date.parse(candidate)) ? new Date(candidate).toISOString() : fallback; }
export function clamp01(value: unknown, fallback = 0.5) { const candidate = number(value); return candidate === null ? fallback : Math.max(0, Math.min(1, candidate)); }

export function pointFromGeometry(geometry: unknown): { latitude: number; longitude: number; geometry?: CommonEventGeometry } | null {
  if (!geometry || typeof geometry !== "object" || Array.isArray(geometry)) return null;
  const candidate = geometry as { type?: unknown; coordinates?: unknown };
  const coordinates = candidate.coordinates;
  if (candidate.type === "Point" && Array.isArray(coordinates)) {
    const longitude = number(coordinates[0]); const latitude = number(coordinates[1]);
    return longitude !== null && latitude !== null && longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90
      ? { longitude, latitude, geometry: { type: "Point", coordinates: [longitude, latitude] } } : null;
  }
  function collect(value: unknown, output: Array<[number, number]>) {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && number(value[0]) !== null && number(value[1]) !== null) { output.push([Number(value[0]), Number(value[1])]); return; }
    value.forEach((item) => collect(item, output));
  }
  const positions: Array<[number, number]> = [];
  collect(coordinates, positions);
  if (!positions.length) return null;
  const longitude = positions.reduce((sum, position) => sum + position[0], 0) / positions.length;
  const latitude = positions.reduce((sum, position) => sum + position[1], 0) / positions.length;
  const allowed = new Set(["MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"]);
  return { longitude, latitude, ...(allowed.has(String(candidate.type)) ? { geometry: candidate as CommonEventGeometry } : {}) };
}

export function pointFromWkt(value: unknown) {
  const match = /^POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)$/i.exec(text(value) ?? "");
  if (!match) return null;
  const longitude = Number(match[1]); const latitude = Number(match[2]);
  return longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90 ? { longitude, latitude } : null;
}

export function inBoundingBox(latitude: number, longitude: number, bbox?: HunterBoundingBox) {
  return !bbox || (longitude >= bbox.west && longitude <= bbox.east && latitude >= bbox.south && latitude <= bbox.north);
}

export function createQueryObservation(input: {
  sourceId: string;
  sourceEventId: string;
  entityType: string;
  latitude: number;
  longitude: number;
  observedAt: string;
  context: HunterSourceQueryContext;
  title: string;
  confidence?: number;
  basis?: ObservationBasis;
  severity?: number | null;
  sourceUrl?: string | null;
  license: string;
  geometry?: CommonEventGeometry;
  attributes?: Record<string, unknown>;
}) : NormalizedObservation {
  const receivedAt = input.context.requestedAt;
  return {
    observationId: `${input.sourceId}:${input.sourceEventId}`,
    entityId: `${input.sourceId}:entity:${input.sourceEventId}`,
    entityType: input.entityType,
    position: { latitude: input.latitude, longitude: input.longitude },
    timestamp: input.observedAt,
    provenance: { sourceFeedId: input.sourceId, fetchedAt: input.context.requestedAt, receivedAt, upstreamTimestamp: input.observedAt, stalenessMs: Math.max(0, Date.parse(input.context.requestedAt) - Date.parse(input.observedAt)) },
    confidence: clamp01(input.confidence, 0.65),
    basis: input.basis ?? "measured",
    retentionClass: "bulk",
    attributes: {
      title: input.title,
      sourceEventId: input.sourceEventId,
      eventType: input.entityType.replaceAll(".", "_"),
      severityScore: input.severity ?? undefined,
      sourceUrl: input.sourceUrl ?? undefined,
      license: input.license,
      geometry: input.geometry,
      queryGenerated: true,
      ...input.attributes,
    },
  };
}

export function parseCsv(input: string, delimiter = ",") {
  const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === delimiter) { row.push(field); field = ""; }
    else if (character === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += character;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  return rows;
}

export function centerOf(bbox?: HunterBoundingBox) {
  return bbox ? { latitude: (bbox.south + bbox.north) / 2, longitude: (bbox.west + bbox.east) / 2 } : { latitude: 0, longitude: 0 };
}

export function bboxString(bbox: HunterBoundingBox) { return `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`; }

export function sourceReferenceUrl(value: unknown) {
  const candidate = text(value);
  if (!candidate) return null;
  try { const url = new URL(candidate); return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null; } catch { return null; }
}
