/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import { createHash } from "node:crypto";
import type { OsintClaim, OsintEntity, OsintEvidence, OsintRelationship } from "./contracts.ts";
import { createHypothesis, type IntelligenceForecast, type IntelligenceHypothesis, type IntelligenceTimelineEntry, type StructuredIntelligenceObservation } from "./intelligence-model.ts";

export type IntelligencePatternSignal = {
  id: string;
  investigationId: string;
  category: "temporal" | "graph" | "behavioral" | "anomaly" | "quality";
  detector: string;
  subjectEntityIds: string[];
  observationIds: string[];
  evidenceIds: string[];
  score: number;
  explanation: string;
  limitations: string[];
};

export type IntelligenceSourceLineage = { sourceId: string; originId: string; evidenceIds: string[]; copiedEvidenceIds: string[]; independent: boolean };
export type IntelligenceGraphPath = { entityIds: string[]; relationshipIds: string[]; confidence: number; evidenceIds: string[] };
export type IntelligenceQualityFinding = { id: string; investigationId: string; check: "duplicate-evidence" | "stale-source" | "timestamp" | "dead-link" | "circular-source" | "ai-content-indicator"; severity: "info" | "warning" | "critical"; evidenceIds: string[]; explanation: string; remediation: string };
export type IntelligenceGeospatialMatch = { observationId: string; structuredObservationId: string; entityId: string; observedAt: string; distanceKm: number; statedPrecisionKm: number; possibleWithinUncertainty: boolean; evidenceIds: string[] };
export type AnalystRole = "collector" | "link-analyst" | "timeline-analyst" | "skeptic" | "forecaster" | "synthesizer";
export type AnalystRoleReport = { role: AnalystRole; assessment: string; evidenceIds: string[]; observationIds: string[]; disagreements: string[]; informationGaps: string[]; confidence: number };

export type IntelligenceCaseSnapshot = {
  investigation: { id: string; objective: string; warnings: string[] };
  entities: OsintEntity[];
  evidence: OsintEvidence[];
  structuredObservations: StructuredIntelligenceObservation[];
  claims: OsintClaim[];
  relationships: OsintRelationship[];
  contradictions: Array<{ id: string; evidenceIds: string[]; observationIds: string[]; explanation: string }>;
  hypotheses: IntelligenceHypothesis[];
  forecasts: IntelligenceForecast[];
  timeline?: IntelligenceTimelineEntry[];
};

function stableId(prefix: string, value: unknown) { return `${prefix}_${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24)}`; }
function unique(values: string[], limit = 500) { return [...new Set(values)].slice(0, limit); }
function clamp(value: number) { return Math.max(0, Math.min(1, value)); }

export function searchEntities(snapshot: IntelligenceCaseSnapshot, query: string, limit = 25) {
  const normalized = query.trim().toLocaleLowerCase("en-US"); if (!normalized) return [];
  return snapshot.entities.map((entity) => {
    const values = [entity.displayName, entity.type, ...entity.identifiers.flatMap(({ value, normalizedValue }) => [value, normalizedValue])];
    const exact = values.some((value) => value.toLocaleLowerCase("en-US") === normalized);
    const partial = values.some((value) => value.toLocaleLowerCase("en-US").includes(normalized));
    return { entity, score: exact ? 1 : partial ? 0.7 : 0 };
  }).filter(({ score }) => score > 0).sort((left, right) => right.score - left.score || left.entity.id.localeCompare(right.entity.id)).slice(0, Math.max(1, Math.min(100, limit)));
}

export function getEntityProfile(snapshot: IntelligenceCaseSnapshot, entityId: string) {
  const entity = snapshot.entities.find(({ id }) => id === entityId); if (!entity) throw new Error("The entity does not belong to this investigation.");
  const observations = snapshot.structuredObservations.filter(({ subject }) => subject.entityId === entityId);
  const claims = snapshot.claims.filter(({ subjectEntityId }) => subjectEntityId === entityId);
  const relationships = snapshot.relationships.filter(({ sourceEntityId, targetEntityId }) => sourceEntityId === entityId || targetEntityId === entityId);
  const evidenceIds = unique([...observations.flatMap(({ evidence }) => evidence.map(({ evidenceId }) => evidenceId)), ...claims.flatMap(({ evidenceIds: ids }) => ids), ...relationships.flatMap(({ evidenceIds: ids }) => ids)]);
  return { entity, observations, claims, relationships, evidenceIds, coverageLimitations: unique(observations.flatMap(({ coverageLimitations }) => coverageLimitations), 50) };
}

export function getEntityTimeline(snapshot: IntelligenceCaseSnapshot, entityId: string, from?: string, to?: string) {
  getEntityProfile(snapshot, entityId);
  const lower = from ? Date.parse(from) : Number.NEGATIVE_INFINITY; const upper = to ? Date.parse(to) : Number.POSITIVE_INFINITY;
  if (Number.isNaN(lower) || Number.isNaN(upper) || lower > upper) throw new Error("The requested timeline window is invalid.");
  const entries: IntelligenceTimelineEntry[] = [
    ...snapshot.structuredObservations.filter(({ subject }) => subject.entityId === entityId).map((item) => ({ id: item.id, occurredAt: item.observedAt, kind: "observation" as const, subjectEntityId: entityId, predicate: item.predicate, evidenceIds: item.evidence.map(({ evidenceId }) => evidenceId) })),
    ...snapshot.claims.filter(({ subjectEntityId }) => subjectEntityId === entityId).map((item) => ({ id: item.id, occurredAt: item.validFrom ?? item.validTo ?? "1970-01-01T00:00:00.000Z", kind: "claim" as const, subjectEntityId: entityId, predicate: item.predicate, evidenceIds: item.evidenceIds, ...(item.validFrom ? { validFrom: item.validFrom } : {}), ...(item.validTo ? { validTo: item.validTo } : {}) })),
    ...snapshot.relationships.filter(({ sourceEntityId, targetEntityId }) => sourceEntityId === entityId || targetEntityId === entityId).map((item) => ({ id: item.id, occurredAt: item.observedAt, kind: "relationship" as const, subjectEntityId: item.sourceEntityId, predicate: item.type, evidenceIds: item.evidenceIds, ...(item.validFrom ? { validFrom: item.validFrom } : {}), ...(item.validTo ? { validTo: item.validTo } : {}) })),
  ];
  return entries.filter(({ occurredAt }) => { const time = Date.parse(occurredAt); return time >= lower && time <= upper; }).sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id));
}

export function findPathsBetweenEntities(snapshot: IntelligenceCaseSnapshot, sourceEntityId: string, targetEntityId: string, options: { maximumDepth?: number; validAt?: string; maximumPaths?: number } = {}) {
  if (!snapshot.entities.some(({ id }) => id === sourceEntityId) || !snapshot.entities.some(({ id }) => id === targetEntityId)) throw new Error("Both path endpoints must belong to this investigation.");
  const maximumDepth = Math.max(1, Math.min(6, options.maximumDepth ?? 4)); const maximumPaths = Math.max(1, Math.min(25, options.maximumPaths ?? 10)); const validAt = options.validAt ? Date.parse(options.validAt) : null;
  if (options.validAt && !Number.isFinite(validAt)) throw new Error("validAt must be an ISO timestamp.");
  const edges = snapshot.relationships.filter((edge) => {
    if (validAt === null) return true; const from = edge.validFrom ? Date.parse(edge.validFrom) : Number.NEGATIVE_INFINITY; const to = edge.validTo ? Date.parse(edge.validTo) : Number.POSITIVE_INFINITY; return validAt >= from && validAt <= to;
  });
  const adjacency = new Map<string, Array<{ edge: OsintRelationship; next: string }>>();
  for (const edge of edges) {
    adjacency.set(edge.sourceEntityId, [...(adjacency.get(edge.sourceEntityId) ?? []), { edge, next: edge.targetEntityId }]);
    if (edge.direction === "undirected") adjacency.set(edge.targetEntityId, [...(adjacency.get(edge.targetEntityId) ?? []), { edge, next: edge.sourceEntityId }]);
  }
  const output: IntelligenceGraphPath[] = []; const queue = [{ entityIds: [sourceEntityId], relationshipIds: [] as string[], confidence: 1, evidenceIds: [] as string[] }];
  while (queue.length && output.length < maximumPaths) {
    const path = queue.shift()!; const current = path.entityIds.at(-1)!;
    if (current === targetEntityId) { output.push(path); continue; }
    if (path.relationshipIds.length >= maximumDepth) continue;
    for (const { edge, next } of (adjacency.get(current) ?? []).sort((left, right) => left.edge.id.localeCompare(right.edge.id))) {
      if (path.entityIds.includes(next)) continue;
      queue.push({ entityIds: [...path.entityIds, next], relationshipIds: [...path.relationshipIds, edge.id], confidence: Math.min(path.confidence, edge.confidence), evidenceIds: unique([...path.evidenceIds, ...edge.evidenceIds]) });
    }
  }
  return output;
}

export function buildSourceLineage(evidence: OsintEvidence[]) {
  const byHash = new Map<string, OsintEvidence[]>(); for (const item of evidence) byHash.set(item.sha256, [...(byHash.get(item.sha256) ?? []), item]);
  return evidence.map((item): IntelligenceSourceLineage => {
    const origin = typeof item.metadata.originSource === "string" ? item.metadata.originSource : typeof item.metadata.sourceFamily === "string" ? item.metadata.sourceFamily : item.providerId;
    const copies = (byHash.get(item.sha256) ?? []).filter(({ id }) => id !== item.id);
    return { sourceId: item.providerId, originId: String(origin), evidenceIds: [item.id], copiedEvidenceIds: copies.map(({ id }) => id), independent: copies.length === 0 };
  });
}

function position(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null; const record = value as Record<string, unknown>; const latitude = Number(record.latitude); const longitude = Number(record.longitude); const precisionKm = Math.max(0, Number(record.precisionKm ?? 0));
  return Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { latitude, longitude, precisionKm } : null;
}
function distanceKm(left: { latitude: number; longitude: number }, right: { latitude: number; longitude: number }) { const rad = Math.PI / 180; const dLat = (right.latitude - left.latitude) * rad; const dLon = (right.longitude - left.longitude) * rad; const a = Math.sin(dLat / 2) ** 2 + Math.cos(left.latitude * rad) * Math.cos(right.latitude * rad) * Math.sin(dLon / 2) ** 2; return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); }

export function findGeospatialObservations(snapshot: IntelligenceCaseSnapshot, input: { latitude: number; longitude: number; radiusKm: number; from: string; to: string }) {
  const center = { latitude: Number(input.latitude), longitude: Number(input.longitude) }; const radiusKm = Number(input.radiusKm); const from = Date.parse(input.from); const to = Date.parse(input.to);
  if (!Number.isFinite(center.latitude) || !Number.isFinite(center.longitude) || Math.abs(center.latitude) > 90 || Math.abs(center.longitude) > 180) throw new Error("A valid latitude and longitude are required.");
  if (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 2_000) throw new Error("Geospatial radius must be between 0 and 2,000 km.");
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) throw new Error("A valid geospatial time window is required.");
  return snapshot.structuredObservations.flatMap((item): IntelligenceGeospatialMatch[] => {
    const observed = Date.parse(item.observedAt); const location = position(item.object); if (!location || observed < from || observed > to) return [];
    const distance = distanceKm(center, location); const possibleWithinUncertainty = Math.max(0, distance - location.precisionKm) <= radiusKm; if (!possibleWithinUncertainty) return [];
    return [{ observationId: item.sourceObservationId, structuredObservationId: item.id, entityId: item.subject.entityId, observedAt: item.observedAt, distanceKm: distance, statedPrecisionKm: location.precisionKm, possibleWithinUncertainty, evidenceIds: item.evidence.map(({ evidenceId }) => evidenceId) }];
  }).sort((left, right) => left.distanceKm - right.distanceKm || left.observedAt.localeCompare(right.observedAt));
}

export function runQualityChecks(snapshot: IntelligenceCaseSnapshot, now = Date.now()) {
  const findings: IntelligenceQualityFinding[] = [];
  for (const lineage of buildSourceLineage(snapshot.evidence)) if (!lineage.independent) findings.push({ id: stableId("quality", { check: "duplicate-evidence", lineage }), investigationId: snapshot.investigation.id, check: "duplicate-evidence", severity: "warning", evidenceIds: unique([...lineage.evidenceIds, ...lineage.copiedEvidenceIds]), explanation: "Evidence records share an integrity hash and cannot be counted as independent confirmation.", remediation: "Trace the source lineage and retain one origin plus materially independent sources." });
  for (const evidence of snapshot.evidence) {
    const retrieved = Date.parse(evidence.retrievedAt); const observed = evidence.observedAt ? Date.parse(evidence.observedAt) : retrieved;
    if (!Number.isFinite(retrieved) || !Number.isFinite(observed) || observed > now + 5 * 60_000) findings.push({ id: stableId("quality", { check: "timestamp", evidenceId: evidence.id }), investigationId: snapshot.investigation.id, check: "timestamp", severity: "critical", evidenceIds: [evidence.id], explanation: "The evidence contains an invalid or future timestamp.", remediation: "Normalize the provider timestamp and verify its timezone before analysis." });
    else if (now - observed > 30 * 86_400_000) findings.push({ id: stableId("quality", { check: "stale-source", evidenceId: evidence.id }), investigationId: snapshot.investigation.id, check: "stale-source", severity: "info", evidenceIds: [evidence.id], explanation: "The source observation is older than thirty days.", remediation: "Treat it as historical context and seek a current independent observation." });
    const linkStatus = String(evidence.metadata.linkStatus ?? evidence.metadata.httpStatus ?? "").toLocaleLowerCase("en-US");
    if (["dead", "gone", "404", "410", "error"].includes(linkStatus)) findings.push({ id: stableId("quality", { check: "dead-link", evidenceId: evidence.id }), investigationId: snapshot.investigation.id, check: "dead-link", severity: "warning", evidenceIds: [evidence.id], explanation: "Provider metadata marks the original source link as unavailable.", remediation: "Use the integrity-checked archive and attempt a bounded operator-approved recheck." });
    const aiProbability = Number(evidence.metadata.aiGeneratedProbability ?? evidence.metadata.aiContentScore);
    if (Number.isFinite(aiProbability) && aiProbability >= 0.7) findings.push({ id: stableId("quality", { check: "ai-content-indicator", evidenceId: evidence.id }), investigationId: snapshot.investigation.id, check: "ai-content-indicator", severity: "warning", evidenceIds: [evidence.id], explanation: `Provider metadata reports a ${Math.round(aiProbability * 100)}% AI-content indicator.`, remediation: "Do not treat the indicator as proof; verify the content through independent primary sources." });
  }
  return [...new Map(findings.map((finding) => [finding.id, finding])).values()].sort((left, right) => left.check.localeCompare(right.check) || left.id.localeCompare(right.id));
}

export function runPatternDetectors(snapshot: IntelligenceCaseSnapshot) {
  const signals: IntelligencePatternSignal[] = [];
  const groups = new Map<string, StructuredIntelligenceObservation[]>();
  for (const item of snapshot.structuredObservations) { const key = `${item.subject.entityId}:${item.predicate}`; groups.set(key, [...(groups.get(key) ?? []), item]); }
  for (const [key, values] of groups) {
    const ordered = [...values].sort((left, right) => left.observedAt.localeCompare(right.observedAt));
    if (ordered.length >= 3) {
      const intervals = ordered.slice(1).map((item, index) => Date.parse(item.observedAt) - Date.parse(ordered[index].observedAt)).filter((value) => value > 0);
      if (intervals.length >= 2) { const mean = intervals.reduce((sum, value) => sum + value, 0) / intervals.length; const deviation = Math.sqrt(intervals.reduce((sum, value) => sum + (value - mean) ** 2, 0) / intervals.length); if (deviation / mean <= 0.2) signals.push({ id: stableId("pattern", { key, detector: "recurring-interval" }), investigationId: snapshot.investigation.id, category: "temporal", detector: "recurring-interval", subjectEntityIds: [ordered[0].subject.entityId], observationIds: ordered.map(({ sourceObservationId }) => sourceObservationId), evidenceIds: unique(ordered.flatMap(({ evidence }) => evidence.map(({ evidenceId }) => evidenceId))), score: clamp(1 - deviation / mean), explanation: `${ordered.length} observations recur at a consistent interval.`, limitations: ["Cadence may reflect provider collection timing rather than subject behavior."] }); }
    }
    if (ordered.length >= 4 && Date.parse(ordered.at(-1)!.observedAt) - Date.parse(ordered[0].observedAt) <= 3_600_000) signals.push({ id: stableId("pattern", { key, detector: "activity-burst" }), investigationId: snapshot.investigation.id, category: "anomaly", detector: "activity-burst", subjectEntityIds: [ordered[0].subject.entityId], observationIds: ordered.map(({ sourceObservationId }) => sourceObservationId), evidenceIds: unique(ordered.flatMap(({ evidence }) => evidence.map(({ evidenceId }) => evidenceId))), score: clamp(ordered.length / 10), explanation: `${ordered.length} related observations occurred inside one hour.`, limitations: ["The burst may reflect batch collection or delayed provider publication."] });
    const distinctObjects = new Set(ordered.map(({ object }) => JSON.stringify(object))); if (distinctObjects.size >= 3) signals.push({ id: stableId("pattern", { key, detector: "configuration-change" }), investigationId: snapshot.investigation.id, category: "behavioral", detector: "configuration-change", subjectEntityIds: [ordered[0].subject.entityId], observationIds: ordered.map(({ sourceObservationId }) => sourceObservationId), evidenceIds: unique(ordered.flatMap(({ evidence }) => evidence.map(({ evidenceId }) => evidenceId))), score: clamp(distinctObjects.size / 8), explanation: `${distinctObjects.size} distinct values were observed for ${ordered[0].predicate}.`, limitations: ["Changes may be normal rotation, shared hosting, provider normalization, or collection artifacts."] });
    const positions = ordered.map((item) => ({ item, position: position(item.object) })).filter((entry): entry is { item: StructuredIntelligenceObservation; position: { latitude: number; longitude: number; precisionKm: number } } => Boolean(entry.position));
    for (let index = 1; index < positions.length; index += 1) { const before = positions[index - 1]; const after = positions[index]; const hours = (Date.parse(after.item.observedAt) - Date.parse(before.item.observedAt)) / 3_600_000; if (hours <= 0) continue; const distance = Math.max(0, distanceKm(before.position, after.position) - before.position.precisionKm - after.position.precisionKm); const speed = distance / hours; if (speed > 1_200) signals.push({ id: stableId("pattern", { before: before.item.id, after: after.item.id }), investigationId: snapshot.investigation.id, category: "quality", detector: "impossible-travel", subjectEntityIds: [before.item.subject.entityId], observationIds: [before.item.sourceObservationId, after.item.sourceObservationId], evidenceIds: unique([...before.item.evidence, ...after.item.evidence].map(({ evidenceId }) => evidenceId)), score: clamp(speed / 5_000), explanation: `Locations imply ${Math.round(speed).toLocaleString()} km/h after accounting for stated precision.`, limitations: ["Locations may describe network infrastructure or coarse geolocation rather than physical presence."] }); }
    }
  const degree = new Map<string, OsintRelationship[]>(); for (const edge of snapshot.relationships) { degree.set(edge.sourceEntityId, [...(degree.get(edge.sourceEntityId) ?? []), edge]); degree.set(edge.targetEntityId, [...(degree.get(edge.targetEntityId) ?? []), edge]); }
  for (const [entityId, edges] of degree) if (edges.length >= 3) signals.push({ id: stableId("pattern", { entityId, detector: "bridge-entity" }), investigationId: snapshot.investigation.id, category: "graph", detector: "bridge-entity", subjectEntityIds: [entityId], observationIds: [], evidenceIds: unique(edges.flatMap(({ evidenceIds }) => evidenceIds)), score: clamp(edges.length / 10), explanation: `${entityId} connects ${edges.length} evidence-backed relationships and may be an intermediary or coordination point.`, limitations: ["High degree may reflect collection bias or a common service provider."] });
  for (const lineage of buildSourceLineage(snapshot.evidence).filter(({ independent }) => !independent)) signals.push({ id: stableId("pattern", { lineage, detector: "circular-source" }), investigationId: snapshot.investigation.id, category: "quality", detector: "circular-source", subjectEntityIds: [], observationIds: [], evidenceIds: unique([...lineage.evidenceIds, ...lineage.copiedEvidenceIds]), score: 0.9, explanation: "Multiple evidence records share the same content integrity hash and are not independent confirmations.", limitations: ["Identical content can also represent legitimate mirroring or archival copies."] });
  for (const finding of runQualityChecks(snapshot)) if (!signals.some(({ detector, evidenceIds }) => detector === finding.check && evidenceIds.join() === finding.evidenceIds.join())) signals.push({ id: stableId("pattern", { finding }), investigationId: snapshot.investigation.id, category: "quality", detector: finding.check, subjectEntityIds: [], observationIds: [], evidenceIds: finding.evidenceIds, score: finding.severity === "critical" ? 1 : finding.severity === "warning" ? 0.75 : 0.45, explanation: finding.explanation, limitations: [finding.remediation] });
  return [...new Map(signals.map((signal) => [signal.id, signal])).values()].sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

export function identifyInformationGaps(snapshot: IntelligenceCaseSnapshot) {
  const gaps = [...snapshot.hypotheses.flatMap(({ informationGaps }) => informationGaps), ...snapshot.investigation.warnings];
  if (!snapshot.contradictions.length) gaps.push("No explicit contradiction was found; an independent disconfirming source may still be missing.");
  if (new Set(snapshot.evidence.map(({ providerId }) => providerId)).size < 2) gaps.push("The case lacks two independent provider families.");
  if (snapshot.claims.some(({ evidenceIds }) => !evidenceIds.length)) gaps.push("One or more claims lack evidence identifiers and must remain unsupported.");
  return unique(gaps, 100);
}

export function testHypothesis(hypothesis: IntelligenceHypothesis, snapshot: IntelligenceCaseSnapshot) {
  if (hypothesis.investigationId !== snapshot.investigation.id) throw new Error("The hypothesis belongs to a different investigation.");
  const observationIds = new Set(snapshot.structuredObservations.flatMap((item) => [item.id, item.sourceObservationId])); const claimIds = new Set(snapshot.claims.map(({ id }) => id));
  const supportingObservationIds = hypothesis.supportingObservationIds.filter((id) => observationIds.has(id)); const supportingClaimIds = hypothesis.supportingClaimIds.filter((id) => claimIds.has(id)); const contradictingObservationIds = hypothesis.contradictingObservationIds.filter((id) => observationIds.has(id)); const contradictingClaimIds = hypothesis.contradictingClaimIds.filter((id) => claimIds.has(id));
  const support = supportingObservationIds.length + supportingClaimIds.length; const contradiction = contradictingObservationIds.length + contradictingClaimIds.length;
  const confidence = clamp((support + 0.5) / (support + contradiction + 2)); const status = support === 0 ? "inconclusive" : contradiction > support ? "weakened" : confidence >= 0.67 ? "supported" : "testing";
  return { ...hypothesis, supportingObservationIds, supportingClaimIds, contradictingObservationIds, contradictingClaimIds, confidence, status: status as IntelligenceHypothesis["status"], confidenceExplanation: [`${support} cited supporting record(s).`, `${contradiction} cited contradicting record(s).`, ...hypothesis.confidenceExplanation], informationGaps: unique([...hypothesis.informationGaps, ...identifyInformationGaps(snapshot)]), updatedAt: new Date().toISOString() };
}

export function calculateForecastMetrics(forecasts: IntelligenceForecast[]) {
  const resolved = forecasts.filter((item) => item.status === "occurred" || item.status === "did-not-occur"); const scores = resolved.map((item) => item.brierScore ?? (item.probability - (item.status === "occurred" ? 1 : 0)) ** 2);
  const predictedPositive = resolved.filter(({ probability }) => probability >= 0.5); const truePositive = predictedPositive.filter(({ status }) => status === "occurred").length; const actualPositive = resolved.filter(({ status }) => status === "occurred").length;
  return { total: forecasts.length, resolved: resolved.length, brierScore: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null, precision: predictedPositive.length ? truePositive / predictedPositive.length : null, recall: actualPositive ? truePositive / actualPositive : null, falsePositiveRate: predictedPositive.length ? predictedPositive.filter(({ status }) => status === "did-not-occur").length / predictedPositive.length : null };
}

export function runAnalystCouncil(snapshot: IntelligenceCaseSnapshot) {
  const patterns = runPatternDetectors(snapshot); const gaps = identifyInformationGaps(snapshot); const evidenceIds = unique(snapshot.evidence.map(({ id }) => id), 100); const observationIds = unique(snapshot.structuredObservations.map(({ sourceObservationId }) => sourceObservationId), 100);
  const reports: AnalystRoleReport[] = [
    { role: "collector", assessment: `${snapshot.evidence.length} evidence records produced ${snapshot.structuredObservations.length} atomic observations; ${gaps.length} collection gaps remain.`, evidenceIds, observationIds, disagreements: [], informationGaps: gaps, confidence: snapshot.evidence.length ? 0.8 : 0.1 },
    { role: "link-analyst", assessment: `${snapshot.entities.length} entities are connected by ${snapshot.relationships.length} time-aware relationships; ${patterns.filter(({ category }) => category === "graph").length} graph signals require review.`, evidenceIds: unique(snapshot.relationships.flatMap(({ evidenceIds: ids }) => ids)), observationIds: [], disagreements: ["Shared infrastructure does not establish shared ownership."], informationGaps: gaps.filter((item) => /independent|account|ownership/i.test(item)), confidence: snapshot.relationships.length ? 0.65 : 0.2 },
    { role: "timeline-analyst", assessment: `${snapshot.structuredObservations.length} observations were ordered without collapsing historical and current associations.`, evidenceIds, observationIds, disagreements: [], informationGaps: gaps.filter((item) => /time|history|fresh/i.test(item)), confidence: snapshot.structuredObservations.length ? 0.7 : 0.1 },
    { role: "skeptic", assessment: `${snapshot.contradictions.length} explicit contradiction(s) and ${patterns.filter(({ category }) => category === "quality").length} quality warning(s) weaken unsupported interpretations.`, evidenceIds: unique(snapshot.contradictions.flatMap(({ evidenceIds: ids }) => ids)), observationIds: unique(snapshot.contradictions.flatMap(({ observationIds: ids }) => ids)), disagreements: snapshot.hypotheses.map(({ statement }) => `Alternative explanation remains possible: ${statement}`), informationGaps: gaps, confidence: 0.75 },
    { role: "forecaster", assessment: `${snapshot.forecasts.filter(({ status }) => status === "open").length} explicit forecast(s) remain open; calibration is reported only after outcomes are scored.`, evidenceIds, observationIds, disagreements: [], informationGaps: snapshot.forecasts.length ? [] : ["No bounded, testable forecast has been recorded."], confidence: snapshot.forecasts.length ? 0.6 : 0.1 },
  ];
  const disagreements = unique(reports.flatMap(({ disagreements: items }) => items));
  reports.push({ role: "synthesizer", assessment: `Structured synthesis retains ${disagreements.length} disagreement(s), ${snapshot.contradictions.length} contradiction(s), and ${gaps.length} information gap(s); no hypothesis was promoted to fact.`, evidenceIds, observationIds, disagreements, informationGaps: gaps, confidence: clamp(reports.reduce((sum, report) => sum + report.confidence, 0) / reports.length) });
  return { reports, patterns, forecastMetrics: calculateForecastMetrics(snapshot.forecasts), synthesis: reports.at(-1)! };
}

export function proposeCompetingHypotheses(snapshot: IntelligenceCaseSnapshot, statements: string[], createdAt: string) {
  return unique(statements.map((item) => item.trim()).filter(Boolean), 5).map((statement, index) => createHypothesis({ investigationId: snapshot.investigation.id, statement, supportingObservationIds: [], supportingClaimIds: [], contradictingObservationIds: [], contradictingClaimIds: [], assumptions: [], informationGaps: identifyInformationGaps(snapshot), confidenceExplanation: ["Candidate explanation requires evidence for and against it."], createdBy: index === 0 ? "link-analyst" : "skeptic", createdAt }));
}
