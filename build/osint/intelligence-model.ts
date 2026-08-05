/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import { createHash } from "node:crypto";
import {
  confidenceCategory,
  type OsintClaim,
  type OsintEntity,
  type OsintEvidence,
  type OsintJsonValue,
  type OsintObservation,
  type OsintRelationship,
} from "./contracts.ts";

export const INTELLIGENCE_MODEL_VERSION = "1.0.0" as const;

export type IntelligenceEvidenceReference = {
  evidenceId: string;
  providerId: string;
  integritySha256: string;
  reference: `evidence://${string}`;
};

export type StructuredIntelligenceObservation = {
  schemaVersion: typeof INTELLIGENCE_MODEL_VERSION;
  id: string;
  investigationId: string;
  sourceObservationId: string;
  source: string;
  collectedAt: string;
  observedAt: string;
  subject: { entityId: string; type: OsintEntity["type"]; value: string };
  predicate: string;
  object: OsintJsonValue;
  confidence: number;
  directness: OsintObservation["directness"];
  freshness: OsintObservation["freshness"];
  evidence: IntelligenceEvidenceReference[];
  rawEvidenceReference?: `evidence://${string}`;
  coverageLimitations: string[];
};

export type EntityResolutionFactor = { signal: string; weight: number; explanation: string; evidenceIds: string[] };
export type EntityResolutionCandidate = {
  schemaVersion: typeof INTELLIGENCE_MODEL_VERSION;
  id: string;
  investigationId: string;
  leftEntityId: string;
  rightEntityId: string;
  relationshipType: "POSSIBLY_SAME_AS";
  matchProbability: number;
  supportingFactors: EntityResolutionFactor[];
  conflictingFactors: EntityResolutionFactor[];
  decision: "auto-match-exact" | "operator-review-required" | "keep-separate" | "approved" | "rejected";
  reversible: true;
  createdAt: string;
  reviewedAt?: string;
};

export type IntelligenceHypothesis = {
  schemaVersion: typeof INTELLIGENCE_MODEL_VERSION;
  id: string;
  investigationId: string;
  statement: string;
  status: "candidate" | "testing" | "supported" | "weakened" | "rejected" | "inconclusive";
  supportingObservationIds: string[];
  supportingClaimIds: string[];
  contradictingObservationIds: string[];
  contradictingClaimIds: string[];
  assumptions: string[];
  informationGaps: string[];
  confidence: number;
  confidenceExplanation: string[];
  createdBy: "operator" | "collector" | "link-analyst" | "timeline-analyst" | "skeptic" | "forecaster" | "synthesizer";
  createdAt: string;
  updatedAt: string;
};

export type IntelligenceForecast = {
  schemaVersion: typeof INTELLIGENCE_MODEL_VERSION;
  id: string;
  investigationId: string;
  target: string;
  timeWindow: { start: string; end: string };
  probability: number;
  supportingObservationIds: string[];
  supportingClaimIds: string[];
  assumptions: string[];
  disconfirmingConditions: string[];
  modelVersion: string;
  status: "open" | "occurred" | "did-not-occur" | "indeterminate";
  createdAt: string;
  resolvedAt?: string;
  brierScore?: number;
};

export type IntelligenceTimelineEntry = {
  id: string;
  occurredAt: string;
  kind: "observation" | "claim" | "relationship";
  subjectEntityId: string;
  predicate: string;
  evidenceIds: string[];
  validFrom?: string;
  validTo?: string;
};

function stableId(prefix: string, value: unknown) {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24)}`;
}

function assertIso(value: string, label: string) {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp.`);
}

function clampProbability(value: number) {
  if (!Number.isFinite(value)) throw new Error("Probability must be finite.");
  return Math.max(0, Math.min(1, value));
}

function jsonValue(value: unknown): OsintJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.slice(0, 1_000).map(jsonValue);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 1_000).map(([key, item]) => [key.slice(0, 200), jsonValue(item)]));
  return String(value);
}

function predicateName(value: string) {
  const normalized = value.trim().toLocaleLowerCase("en-US").replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized ? `reported.${normalized}` : "reported.presence";
}

export function structureOsintObservation(input: { observation: OsintObservation; entity: OsintEntity; evidence: OsintEvidence[] }) {
  const { observation, entity } = input;
  const evidenceById = new Map(input.evidence.map((item) => [item.id, item]));
  const references = observation.evidenceIds.map((id) => evidenceById.get(id)).filter((item): item is OsintEvidence => Boolean(item)).map((item) => ({ evidenceId: item.id, providerId: item.providerId, integritySha256: item.sha256, reference: `evidence://${item.id}` as const }));
  if (references.length !== observation.evidenceIds.length) throw new Error(`Observation ${observation.id} references unavailable evidence.`);
  const entries = Object.entries(observation.attributes).sort(([left], [right]) => left.localeCompare(right));
  const facts = entries.length ? entries : [["presence", true] as const];
  return facts.map(([attribute, object]) => {
    const predicate = predicateName(attribute);
    return {
      schemaVersion: INTELLIGENCE_MODEL_VERSION,
      id: stableId("iobs", { observationId: observation.id, predicate, object }),
      investigationId: observation.investigationId,
      sourceObservationId: observation.id,
      source: observation.providerId,
      collectedAt: observation.retrievedAt,
      observedAt: observation.observedAt,
      subject: { entityId: entity.id, type: entity.type, value: entity.displayName },
      predicate,
      object: jsonValue(object),
      confidence: clampProbability(observation.confidence),
      directness: observation.directness,
      freshness: observation.freshness,
      evidence: references,
      ...(references[0] ? { rawEvidenceReference: references[0].reference } : {}),
      coverageLimitations: [...new Set(observation.coverageLimitations)],
    } satisfies StructuredIntelligenceObservation;
  });
}

const EXACT_IDENTIFIER_TYPES = new Set(["email", "phone", "certificate-sha256", "account-id", "aircraft-icao", "vessel-mmsi", "satellite-norad", "cryptocurrency-address", "device-id"]);
const CONTEXTUAL_IDENTIFIER_TYPES = new Set(["username", "organization-name", "avatar-sha256", "geographic-label"]);

export function compareEntitiesForResolution(investigationId: string, left: OsintEntity, right: OsintEntity, createdAt: string): EntityResolutionCandidate {
  assertIso(createdAt, "createdAt");
  if (left.id === right.id) throw new Error("Entity resolution requires two distinct records.");
  const supportingFactors: EntityResolutionFactor[] = [];
  const conflictingFactors: EntityResolutionFactor[] = [];
  for (const leftId of left.identifiers) for (const rightId of right.identifiers) {
    if (leftId.type !== rightId.type || leftId.normalizedValue !== rightId.normalizedValue) continue;
    const exact = EXACT_IDENTIFIER_TYPES.has(leftId.type);
    const contextual = CONTEXTUAL_IDENTIFIER_TYPES.has(leftId.type);
    const weight = exact ? 0.92 : contextual ? 0.5 : 0.6;
    supportingFactors.push({ signal: `same_${leftId.type}`, weight, explanation: `${exact ? "Exact" : "Normalized"} ${leftId.type} match.`, evidenceIds: [...new Set([...leftId.evidenceIds, ...rightId.evidenceIds])] });
  }
  if (left.type !== "unknown" && right.type !== "unknown" && left.type !== right.type) conflictingFactors.push({ signal: "different_entity_type", weight: -0.45, explanation: `Entity types conflict: ${left.type} versus ${right.type}.`, evidenceIds: [] });
  for (const field of ["country", "ageRange", "birthYear"]) {
    const leftValue = left.attributes[field]; const rightValue = right.attributes[field];
    if (leftValue !== undefined && rightValue !== undefined && JSON.stringify(leftValue) !== JSON.stringify(rightValue)) conflictingFactors.push({ signal: `different_${field}`, weight: -0.12, explanation: `${field} values conflict.`, evidenceIds: [] });
  }
  const positive = supportingFactors.reduce((sum, factor) => sum + factor.weight, 0);
  const negative = conflictingFactors.reduce((sum, factor) => sum + factor.weight, 0);
  const matchProbability = clampProbability(positive + negative);
  const exactMatch = supportingFactors.some((factor) => factor.weight >= 0.9) && conflictingFactors.length === 0;
  const decision = exactMatch ? "auto-match-exact" : matchProbability >= 0.45 ? "operator-review-required" : "keep-separate";
  return {
    schemaVersion: INTELLIGENCE_MODEL_VERSION,
    id: stableId("resolution", { investigationId, entities: [left.id, right.id].sort() }),
    investigationId,
    leftEntityId: [left.id, right.id].sort()[0],
    rightEntityId: [left.id, right.id].sort()[1],
    relationshipType: "POSSIBLY_SAME_AS",
    matchProbability,
    supportingFactors,
    conflictingFactors,
    decision,
    reversible: true,
    createdAt,
  };
}

export function buildInvestigationTimeline(input: { observations: StructuredIntelligenceObservation[]; claims: OsintClaim[]; relationships: OsintRelationship[] }) {
  const entries: IntelligenceTimelineEntry[] = [
    ...input.observations.map((item) => ({ id: item.id, occurredAt: item.observedAt, kind: "observation" as const, subjectEntityId: item.subject.entityId, predicate: item.predicate, evidenceIds: item.evidence.map(({ evidenceId }) => evidenceId) })),
    ...input.claims.map((item) => ({ id: item.id, occurredAt: item.validFrom ?? item.validTo ?? "1970-01-01T00:00:00.000Z", kind: "claim" as const, subjectEntityId: item.subjectEntityId, predicate: item.predicate, evidenceIds: item.evidenceIds, ...(item.validFrom ? { validFrom: item.validFrom } : {}), ...(item.validTo ? { validTo: item.validTo } : {}) })),
    ...input.relationships.map((item) => ({ id: item.id, occurredAt: item.observedAt, kind: "relationship" as const, subjectEntityId: item.sourceEntityId, predicate: item.type, evidenceIds: item.evidenceIds, ...(item.validFrom ? { validFrom: item.validFrom } : {}), ...(item.validTo ? { validTo: item.validTo } : {}) })),
  ];
  return entries.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id));
}

export function createHypothesis(input: Omit<IntelligenceHypothesis, "schemaVersion" | "id" | "confidence" | "status" | "updatedAt"> & { confidence?: number; status?: IntelligenceHypothesis["status"] }) {
  if (!input.statement.trim()) throw new Error("A hypothesis statement is required.");
  assertIso(input.createdAt, "createdAt");
  const support = new Set([...input.supportingObservationIds, ...input.supportingClaimIds]).size;
  const contradiction = new Set([...input.contradictingObservationIds, ...input.contradictingClaimIds]).size;
  const confidence = clampProbability(input.confidence ?? (support ? support / (support + contradiction + 2) : 0.1));
  return { ...input, schemaVersion: INTELLIGENCE_MODEL_VERSION, id: stableId("hyp", { investigationId: input.investigationId, statement: input.statement.trim() }), statement: input.statement.trim(), status: input.status ?? "candidate", confidence, updatedAt: input.createdAt } satisfies IntelligenceHypothesis;
}

export function createForecast(input: Omit<IntelligenceForecast, "schemaVersion" | "id" | "status"> & { status?: IntelligenceForecast["status"] }) {
  assertIso(input.timeWindow.start, "forecast start"); assertIso(input.timeWindow.end, "forecast end"); assertIso(input.createdAt, "createdAt");
  if (Date.parse(input.timeWindow.start) >= Date.parse(input.timeWindow.end)) throw new Error("Forecast time window must end after it starts.");
  if (!input.target.trim() || !input.supportingObservationIds.length || !input.disconfirmingConditions.length) throw new Error("A forecast requires a target, cited observations, and disconfirming conditions.");
  const probability = clampProbability(input.probability);
  return { ...input, schemaVersion: INTELLIGENCE_MODEL_VERSION, id: stableId("forecast", { investigationId: input.investigationId, target: input.target.trim(), window: input.timeWindow, modelVersion: input.modelVersion }), target: input.target.trim(), probability, status: input.status ?? "open" } satisfies IntelligenceForecast;
}

export function scoreForecast(forecast: IntelligenceForecast, outcome: "occurred" | "did-not-occur" | "indeterminate", resolvedAt: string) {
  assertIso(resolvedAt, "resolvedAt");
  if (forecast.status !== "open") throw new Error("Only an open forecast can be scored.");
  if (outcome === "indeterminate") return { ...forecast, status: outcome, resolvedAt } satisfies IntelligenceForecast;
  const actual = outcome === "occurred" ? 1 : 0;
  return { ...forecast, status: outcome, resolvedAt, brierScore: (forecast.probability - actual) ** 2 } satisfies IntelligenceForecast;
}

export function explainClaim(claim: OsintClaim, contradictingEvidenceIds: string[] = []) {
  return {
    claim: `${claim.predicate}: ${JSON.stringify(claim.value)}`,
    supportingEvidence: [...claim.evidenceIds],
    contradictingEvidence: [...new Set(contradictingEvidenceIds)],
    confidence: claim.confidence,
    confidenceCategory: confidenceCategory(claim.confidence),
    explanation: claim.explanation,
    status: claim.status,
  };
}
