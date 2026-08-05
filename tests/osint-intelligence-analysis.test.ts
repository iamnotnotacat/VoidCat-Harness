/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { calculateForecastMetrics, createForecast, createHypothesis, findGeospatialObservations, findPathsBetweenEntities, getEntityTimeline, identifyInformationGaps, proposeCompetingHypotheses, runAnalystCouncil, runPatternDetectors, runQualityChecks, searchEntities, testHypothesis, type IntelligenceCaseSnapshot, type OsintEntity, type OsintEvidence, type StructuredIntelligenceObservation } from "../build/osint/index.ts";

const NOW = "2026-08-04T12:00:00.000Z";
function entity(id: string, name: string): OsintEntity { return { schemaVersion: "1.0.0", id, type: "domain", displayName: name, identifiers: [{ schemaVersion: "1.0.0", id: `identifier_${id}`, type: "domain", value: name, normalizedValue: name.toLowerCase(), confidence: 0.95, evidenceIds: ["ev_1"] }], attributes: {}, createdAt: NOW, updatedAt: NOW }; }
function evidence(id: string, providerId: string, hash: string): OsintEvidence { return { schemaVersion: "1.0.0", id, providerId, sourceType: "provider", sourceRef: `fixture://${providerId}/${id}`, retrievedAt: NOW, title: id, sha256: hash, byteLength: 100, sensitivity: "public", cache: { status: "fixture", ageMs: 0 }, attribution: { provider: providerId }, metadata: {} }; }
function observation(id: string, entityId: string, observedAt: string, object: unknown): StructuredIntelligenceObservation { return { schemaVersion: "1.0.0", id, investigationId: "inv_1", sourceObservationId: `source_${id}`, source: "fixture", collectedAt: NOW, observedAt, subject: { entityId, type: "domain", value: entityId }, predicate: "reported.activity", object: object as never, confidence: 0.9, directness: "direct", freshness: "recent", evidence: [{ evidenceId: "ev_1", providerId: "provider-a", integritySha256: "a".repeat(64), reference: "evidence://ev_1" }], rawEvidenceReference: "evidence://ev_1", coverageLimitations: [] }; }

function snapshot(): IntelligenceCaseSnapshot {
  const entities = [entity("a", "alpha.example"), entity("b", "bridge.example"), entity("c", "charlie.example"), entity("d", "delta.example")];
  const structuredObservations = [
    observation("o1", "a", "2026-08-04T01:00:00.000Z", { latitude: 35, longitude: -97, precisionKm: 5 }),
    observation("o2", "a", "2026-08-04T02:00:00.000Z", { latitude: 51.5, longitude: 0, precisionKm: 5 }),
    observation("o3", "b", "2026-08-04T01:00:00.000Z", "active"), observation("o4", "b", "2026-08-04T02:00:00.000Z", "active"), observation("o5", "b", "2026-08-04T03:00:00.000Z", "active"),
  ];
  return {
    investigation: { id: "inv_1", objective: "Explain infrastructure relationships.", warnings: [] }, entities,
    evidence: [evidence("ev_1", "provider-a", "a".repeat(64)), evidence("ev_2", "provider-b", "a".repeat(64))], structuredObservations,
    claims: [{ schemaVersion: "1.0.0", id: "claim_1", investigationId: "inv_1", subjectEntityId: "a", predicate: "shares_infrastructure", value: "b", validFrom: "2026-08-04T00:00:00.000Z", status: "supported", evidenceIds: ["ev_1"], observationIds: ["source_o1"], confidence: 0.72, confidenceCategory: "high", explanation: "Shared certificate evidence." }],
    relationships: [
      { schemaVersion: "1.0.0", id: "r1", investigationId: "inv_1", sourceEntityId: "a", targetEntityId: "b", type: "SHARES_INFRASTRUCTURE_WITH", direction: "undirected", observedAt: NOW, validFrom: "2026-08-01T00:00:00.000Z", evidenceIds: ["ev_1"], confidence: 0.8, confidenceCategory: "high", status: "observed" },
      { schemaVersion: "1.0.0", id: "r2", investigationId: "inv_1", sourceEntityId: "b", targetEntityId: "c", type: "RESOLVES_TO", direction: "directed", observedAt: NOW, validFrom: "2026-08-01T00:00:00.000Z", evidenceIds: ["ev_1"], confidence: 0.7, confidenceCategory: "high", status: "observed" },
      { schemaVersion: "1.0.0", id: "r3", investigationId: "inv_1", sourceEntityId: "b", targetEntityId: "d", type: "USES", direction: "directed", observedAt: NOW, validFrom: "2026-08-01T00:00:00.000Z", evidenceIds: ["ev_2"], confidence: 0.65, confidenceCategory: "moderate", status: "observed" },
    ],
    contradictions: [{ id: "contra_1", evidenceIds: ["ev_2"], observationIds: ["source_o2"], explanation: "A copied source disputes ownership." }], hypotheses: [], forecasts: [],
  };
}

test("bounded graph and timeline tools expose evidence-backed paths without arbitrary database access", () => {
  const current = snapshot(); assert.equal(searchEntities(current, "BRIDGE")[0].entity.id, "b");
  const paths = findPathsBetweenEntities(current, "a", "c", { maximumDepth: 3, validAt: NOW }); assert.equal(paths.length, 1); assert.deepEqual(paths[0].relationshipIds, ["r1", "r2"]); assert.deepEqual(paths[0].evidenceIds, ["ev_1"]);
  assert.equal(findPathsBetweenEntities(current, "c", "a", { maximumDepth: 3 }).length, 0, "directed graph traversal must not silently reverse directed edges");
  const timeline = getEntityTimeline(current, "a"); assert.deepEqual(timeline.map(({ kind }) => kind), ["claim", "observation", "observation", "relationship"]);
});

test("deterministic detectors find recurring intervals, graph bridges, impossible travel, and copied evidence", () => {
  const signals = runPatternDetectors(snapshot());
  for (const detector of ["recurring-interval", "bridge-entity", "impossible-travel", "circular-source"]) assert.ok(signals.some((signal) => signal.detector === detector), detector);
  assert.ok(signals.every(({ evidenceIds, explanation, limitations }) => evidenceIds.length > 0 && explanation && limitations.length));
});

test("geospatial matching preserves precision and quality checks expose source dependence", () => {
  const current = snapshot(); const matches = findGeospatialObservations(current, { latitude: 35, longitude: -97, radiusKm: 1, from: "2026-08-04T00:00:00.000Z", to: "2026-08-04T01:30:00.000Z" }); assert.equal(matches.length, 1); assert.equal(matches[0].possibleWithinUncertainty, true); assert.equal(matches[0].statedPrecisionKm, 5);
  const findings = runQualityChecks(current, Date.parse(NOW)); assert.ok(findings.some(({ check }) => check === "duplicate-evidence")); assert.ok(findings.every(({ evidenceIds, remediation }) => evidenceIds.length > 0 && remediation));
  const graphOnlySignals = runPatternDetectors({ ...current, structuredObservations: [] }); assert.ok(graphOnlySignals.some(({ detector }) => detector === "bridge-entity"), "graph detectors must run even when no structured attribute observations exist"); assert.ok(graphOnlySignals.some(({ detector }) => detector === "circular-source"));
});

test("hypothesis testing preserves competing explanations, contradictions, and collection gaps", () => {
  const current = snapshot(); const hypotheses = proposeCompetingHypotheses(current, ["One operator controls the cluster.", "A shared reseller explains the cluster."], NOW); assert.equal(hypotheses.length, 2); assert.notEqual(hypotheses[0].id, hypotheses[1].id);
  const candidate = createHypothesis({ investigationId: "inv_1", statement: "One operator controls the cluster.", supportingObservationIds: ["source_o1"], supportingClaimIds: ["claim_1"], contradictingObservationIds: ["source_o2"], contradictingClaimIds: [], assumptions: ["Hosting is exclusive."], informationGaps: ["Hosting account identifier"], confidenceExplanation: [], createdBy: "link-analyst", createdAt: NOW });
  const tested = testHypothesis(candidate, current); assert.equal(tested.status, "testing"); assert.ok(tested.confidence < 0.67); assert.ok(tested.informationGaps.includes("Hosting account identifier")); assert.ok(identifyInformationGaps({ ...current, hypotheses: [tested] }).length > 0);
});

test("analyst roles remain independent and the synthesizer retains disagreement", () => {
  const council = runAnalystCouncil(snapshot()); assert.deepEqual(council.reports.map(({ role }) => role), ["collector", "link-analyst", "timeline-analyst", "skeptic", "forecaster", "synthesizer"]); assert.ok(council.synthesis.disagreements.length > 0); assert.match(council.synthesis.assessment, /no hypothesis was promoted to fact/i);
});

test("forecast metrics expose calibration rather than persuasive prose", () => {
  const first = { ...createForecast({ investigationId: "inv_1", target: "Rotation", timeWindow: { start: "2026-08-05T00:00:00.000Z", end: "2026-08-06T00:00:00.000Z" }, probability: 0.7, supportingObservationIds: ["source_o1"], supportingClaimIds: ["claim_1"], assumptions: [], disconfirmingConditions: ["No rotation"], modelVersion: "test", createdAt: NOW }), status: "occurred" as const, brierScore: 0.09 };
  const second = { ...first, id: "forecast_2", probability: 0.8, status: "did-not-occur" as const, brierScore: 0.64 };
  const metrics = calculateForecastMetrics([first, second]); assert.equal(metrics.resolved, 2); assert.equal(metrics.brierScore, 0.365); assert.equal(metrics.precision, 0.5); assert.equal(metrics.recall, 1); assert.equal(metrics.falsePositiveRate, 0.5);
});
