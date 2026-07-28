import { createHash } from "node:crypto";
import { validateNormalizedObservation } from "../hunter-seeker/source-adapter.ts";
import type { HunterSeekerPublicObservation } from "../hunter-seeker/hunter-seeker-service.ts";
import {
  OSINT_SCHEMA_VERSION,
  confidenceCategory,
  toOsintJsonRecord,
  validateOsintContract,
  type InvestigationSeed,
  type OsintEntity,
  type OsintEntityType,
  type OsintEvidence,
  type OsintIdentifier,
  type OsintIdentifierType,
  type OsintObservation,
} from "./contracts.ts";
import { normalizeIdentifierValue, osintStableId } from "./provider-contracts.ts";

export type HunterSeekerIntakeContext = {
  investigationId: string;
  receivedAt: string;
};

export type HunterSeekerIntakeResult = {
  seed: InvestigationSeed;
  entity: OsintEntity;
  evidence: OsintEvidence;
  observation: OsintObservation;
  coverageLimitations: string[];
};

export type HunterSeekerRegionSeed = {
  label: string;
  bounds: { west: number; south: number; east: number; north: number };
};

function attributeString(attributes: Record<string, unknown>, ...names: string[]) {
  for (const name of names) {
    const value = attributes[name];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function classifyEntity(entityType: string): OsintEntityType {
  const normalized = entityType.toLowerCase();
  if (normalized.includes("aircraft")) return "aircraft";
  if (normalized.includes("maritime") || normalized.includes("vessel") || normalized.includes("ship")) return "vessel";
  if (normalized.includes("satellite") || normalized.includes("space-station") || normalized.includes("orbital")) return "satellite";
  if (normalized.includes("earthquake") || normalized.includes("weather") || normalized.includes("alert") || normalized.includes("event")) return "event";
  return "unknown";
}

function identifierCandidates(observation: HunterSeekerPublicObservation, type: OsintEntityType): Array<{ type: OsintIdentifierType; value: string; confidence: number }> {
  const attributes = observation.attributes;
  const values: Array<{ type: OsintIdentifierType; value: string | undefined; confidence: number }> = [];
  if (type === "aircraft") {
    values.push(
      { type: "aircraft-icao", value: attributeString(attributes, "transponderHex", "icao24", "icao"), confidence: observation.confidence },
      { type: "aircraft-callsign", value: attributeString(attributes, "callsign"), confidence: Math.min(observation.confidence, 0.9) },
      { type: "aircraft-registration", value: attributeString(attributes, "registration", "tailNumber"), confidence: Math.min(observation.confidence, 0.9) },
    );
  } else if (type === "vessel") {
    values.push(
      { type: "vessel-mmsi", value: attributeString(attributes, "mmsi"), confidence: observation.confidence },
      { type: "vessel-name", value: attributeString(attributes, "shipName", "vesselName", "title"), confidence: Math.min(observation.confidence, 0.8) },
    );
  } else if (type === "satellite") {
    values.push(
      { type: "satellite-norad", value: attributeString(attributes, "noradCatalogId", "noradId"), confidence: observation.confidence },
      { type: "international-designator", value: attributeString(attributes, "internationalDesignator"), confidence: Math.min(observation.confidence, 0.9) },
    );
  } else {
    values.push({ type: "hunter-entity", value: observation.entityId, confidence: observation.confidence });
  }
  values.push({ type: "hunter-observation", value: observation.observationId, confidence: 1 });
  const unique = new Map<string, { type: OsintIdentifierType; value: string; confidence: number }>();
  for (const candidate of values) {
    if (!candidate.value) continue;
    const normalized = normalizeIdentifierValue(candidate.type, candidate.value);
    unique.set(`${candidate.type}:${normalized}`, { type: candidate.type, value: candidate.value, confidence: candidate.confidence });
  }
  return [...unique.values()];
}

function freshness(stalenessMs: number): OsintObservation["freshness"] {
  if (stalenessMs <= 2 * 60_000) return "live";
  if (stalenessMs <= 30 * 60_000) return "recent";
  if (stalenessMs <= 24 * 60 * 60_000) return "stale";
  return "historical";
}

function displayName(observation: HunterSeekerPublicObservation) {
  return attributeString(observation.attributes, "title", "callsign", "shipName", "event", "place") ?? observation.entityId;
}

function assertContext(context: HunterSeekerIntakeContext) {
  if (!context.investigationId.trim() || context.investigationId.length > 160) throw new Error("Hunter-Seeker intake requires a bounded investigation identifier.");
  if (!Number.isFinite(Date.parse(context.receivedAt))) throw new Error("Hunter-Seeker intake receivedAt must be an ISO timestamp.");
}

export class HunterSeekerIntakeAdapter {
  adaptObservation(observation: HunterSeekerPublicObservation, context: HunterSeekerIntakeContext): HunterSeekerIntakeResult {
    assertContext(context);
    validateNormalizedObservation(observation, observation.provenance.sourceFeedId);
    const entityType = classifyEntity(observation.entityType);
    const candidates = identifierCandidates(observation, entityType);
    const primary = candidates.find(({ type }) => type !== "hunter-observation") ?? candidates[0];
    const primaryNormalized = normalizeIdentifierValue(primary.type, primary.value);
    const entityId = osintStableId("ent", { type: entityType, identifierType: primary.type, value: primaryNormalized });
    const evidenceId = osintStableId("ev", { provider: "hunter-seeker", observationId: observation.observationId, source: observation.provenance.sourceFeedId });
    const evidencePayload = JSON.stringify({
      observationId: observation.observationId, entityId: observation.entityId, entityType: observation.entityType, position: observation.position,
      timestamp: observation.timestamp, provenance: observation.provenance, confidence: observation.confidence, basis: observation.basis,
    });
    const evidence = validateOsintContract("evidence", {
      schemaVersion: OSINT_SCHEMA_VERSION, id: evidenceId, providerId: "hunter-seeker", sourceType: "hunter-seeker",
      sourceRef: `hunter-seeker:${observation.provenance.sourceFeedId}:${observation.observationId}`, retrievedAt: context.receivedAt, observedAt: observation.timestamp,
      title: `${displayName(observation)} — Hunter-Seeker observation`,
      excerpt: `${observation.entityType} observed at ${observation.position.latitude.toFixed(4)}, ${observation.position.longitude.toFixed(4)} on ${observation.timestamp}.`,
      sha256: createHash("sha256").update(evidencePayload).digest("hex"), byteLength: Buffer.byteLength(evidencePayload), sensitivity: "public",
      cache: { status: observation.provenance.stalenessMs > 0 ? "cached" : "live", ageMs: observation.provenance.stalenessMs },
      attribution: { provider: observation.provenance.sourceFeedId },
      metadata: toOsintJsonRecord({ hunterObservationId: observation.observationId, hunterEntityId: observation.entityId, basis: observation.basis, retentionClass: observation.retentionClass }),
    });
    const identifiers: OsintIdentifier[] = candidates.map((candidate) => {
      const normalizedValue = normalizeIdentifierValue(candidate.type, candidate.value);
      return validateOsintContract("identifier", {
        schemaVersion: OSINT_SCHEMA_VERSION, id: osintStableId("id", { entityId, type: candidate.type, value: normalizedValue }), type: candidate.type,
        value: candidate.value, normalizedValue, confidence: candidate.confidence, firstSeenAt: observation.timestamp, lastSeenAt: observation.timestamp, evidenceIds: [evidence.id],
      });
    });
    const entity = validateOsintContract("entity", {
      schemaVersion: OSINT_SCHEMA_VERSION, id: entityId, type: entityType, displayName: displayName(observation), identifiers,
      attributes: toOsintJsonRecord({ hunterEntityType: observation.entityType, hunterEntityId: observation.entityId, position: observation.position, attributes: observation.attributes }),
      createdAt: observation.timestamp, updatedAt: context.receivedAt,
    });
    const coverageLimitations = [
      "This intake represents one Hunter-Seeker observation, not a complete historical or identity record.",
      `The source reported ${observation.basis} evidence with ${Math.round(observation.confidence * 100)}% source confidence.`,
    ];
    const normalizedObservation = validateOsintContract("observation", {
      schemaVersion: OSINT_SCHEMA_VERSION, id: osintStableId("obs", { investigationId: context.investigationId, hunterObservationId: observation.observationId }),
      investigationId: context.investigationId, entityId: entity.id, providerId: "hunter-seeker", observedAt: observation.timestamp, retrievedAt: context.receivedAt,
      evidenceIds: [evidence.id], attributes: toOsintJsonRecord({ position: observation.position, hunterAttributes: observation.attributes }), confidence: observation.confidence,
      confidenceCategory: confidenceCategory(observation.confidence), directness: observation.basis === "measured" ? "direct" : "derived",
      freshness: freshness(observation.provenance.stalenessMs), coverageLimitations,
    });
    const seed: InvestigationSeed = {
      type: entityType, value: primary.value, label: entity.displayName,
      attributes: toOsintJsonRecord({ entityId: entity.id, position: observation.position, identifierType: primary.type }),
      source: { kind: "hunter-seeker", id: observation.provenance.sourceFeedId, observationId: observation.observationId },
    };
    return { seed, entity, evidence, observation: normalizedObservation, coverageLimitations };
  }

  adaptRegion(region: HunterSeekerRegionSeed): InvestigationSeed {
    const label = region.label.trim();
    const { west, south, east, north } = region.bounds;
    if (!label || label.length > 500) throw new Error("Hunter-Seeker region requires a bounded label.");
    if (![west, south, east, north].every(Number.isFinite) || west < -180 || west > 180 || east < -180 || east > 180 || south < -90 || south > 90 || north < -90 || north > 90 || south > north) throw new Error("Hunter-Seeker region bounds are invalid.");
    return {
      type: "geographic-area", value: `${south},${west},${north},${east}`, label,
      attributes: { geometryType: "bbox", west, south, east, north },
      source: { kind: "hunter-seeker", id: "hunter-seeker-map-region" },
    };
  }
}
