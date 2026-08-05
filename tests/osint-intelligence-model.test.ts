/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  INTELLIGENCE_MODEL_VERSION,
  buildInvestigationTimeline,
  compareEntitiesForResolution,
  createForecast,
  createHypothesis,
  scoreForecast,
  structureOsintObservation,
  type OsintEntity,
  type OsintEvidence,
  type OsintObservation,
} from "../build/osint/index.ts";

const NOW = "2026-08-04T21:20:00.000Z";

function entity(id: string, type: OsintEntity["type"], identifierType: OsintEntity["identifiers"][number]["type"], value: string, normalizedValue = value.toLowerCase(), attributes = {}): OsintEntity {
  return { schemaVersion: "1.0.0", id, type, displayName: value, identifiers: [{ schemaVersion: "1.0.0", id: `id_${id}`, type: identifierType, value, normalizedValue, confidence: 0.95, evidenceIds: ["ev_1"] }], attributes, createdAt: NOW, updatedAt: NOW };
}

const evidence: OsintEvidence = { schemaVersion: "1.0.0", id: "ev_1", providerId: "censys", sourceType: "provider", sourceRef: "fixture://censys/host", retrievedAt: NOW, observedAt: "2026-08-03T16:41:00.000Z", title: "Censys host fixture", sha256: "a".repeat(64), byteLength: 128, sensitivity: "public", cache: { status: "fixture", ageMs: 0 }, attribution: { provider: "Censys" }, metadata: {} };

test("provider observations become atomic subject-predicate-object facts with evidence integrity", () => {
  const subject = entity("ent_ip", "ip-address", "ipv4", "203.0.113.10");
  const observation: OsintObservation = { schemaVersion: "1.0.0", id: "obs_18472", investigationId: "inv_72", entityId: subject.id, providerId: "censys", observedAt: "2026-08-03T16:41:00.000Z", retrievedAt: NOW, evidenceIds: [evidence.id], attributes: { port: 443, service: "https", certificateFingerprint: "abc123" }, confidence: 0.97, confidenceCategory: "very-high", directness: "direct", freshness: "recent", coverageLimitations: ["Internet scan coverage is incomplete."] };
  const facts = structureOsintObservation({ observation, entity: subject, evidence: [evidence] });
  assert.deepEqual(facts.map(({ predicate }) => predicate), ["reported.certificatefingerprint", "reported.port", "reported.service"]);
  assert.ok(facts.every((fact) => fact.schemaVersion === INTELLIGENCE_MODEL_VERSION && fact.subject.entityId === subject.id && fact.rawEvidenceReference === "evidence://ev_1"));
  assert.ok(facts.every((fact) => fact.evidence[0].integritySha256 === evidence.sha256 && fact.sourceObservationId === observation.id));
});

test("uncertain aliases remain reversible operator-review candidates while exact identifiers may auto-match", () => {
  const alias = compareEntitiesForResolution("inv_72", entity("person_a", "person", "username", "VoidCat", "voidcat"), entity("person_b", "person", "username", "voidcat", "voidcat"), NOW);
  assert.equal(alias.relationshipType, "POSSIBLY_SAME_AS"); assert.equal(alias.decision, "operator-review-required"); assert.equal(alias.reversible, true);
  assert.equal(compareEntitiesForResolution("inv_72", entity("account_a", "social-account", "account-id", "acct-42"), entity("account_b", "social-account", "account-id", "acct-42"), NOW).decision, "auto-match-exact");
  const conflict = compareEntitiesForResolution("inv_72", entity("p1", "person", "username", "same", "same", { country: "US" }), entity("p2", "person", "username", "same", "same", { country: "GB" }), NOW);
  assert.ok(conflict.conflictingFactors.some(({ signal }) => signal === "different_country")); assert.notEqual(conflict.decision, "auto-match-exact");
});

test("hypotheses remain separate from claims and forecasts are permanently scoreable", () => {
  const hypothesis = createHypothesis({ investigationId: "inv_72", statement: "The domains may share an operator.", supportingObservationIds: ["obs_12", "obs_44"], supportingClaimIds: ["claim_shared_infra"], contradictingObservationIds: ["obs_62"], contradictingClaimIds: [], assumptions: ["The certificate is not from shared hosting."], informationGaps: ["Hosting account identifier"], confidenceExplanation: ["Shared certificate supports the hypothesis.", "Different registration contact weakens it."], createdBy: "link-analyst", createdAt: NOW });
  assert.equal(hypothesis.status, "candidate"); assert.ok(hypothesis.confidence > 0 && hypothesis.confidence < 1); assert.equal(hypothesis.supportingClaimIds[0], "claim_shared_infra");
  const forecast = createForecast({ investigationId: "inv_72", target: "Infrastructure cluster rotates domains", timeWindow: { start: "2026-08-05T00:00:00.000Z", end: "2026-08-19T00:00:00.000Z" }, probability: 0.64, supportingObservationIds: ["obs_12"], supportingClaimIds: ["claim_shared_infra"], assumptions: ["Control remains unchanged."], disconfirmingConditions: ["Certificate renews on the existing domain."], modelVersion: "forecast-domain-rotation-1.0", createdAt: NOW });
  const scored = scoreForecast(forecast, "occurred", "2026-08-10T00:00:00.000Z");
  assert.equal(scored.status, "occurred"); assert.equal(scored.brierScore, (0.64 - 1) ** 2);
});

test("timeline ordering keeps observations, claims, and time-bounded edges distinct", () => {
  const subject = entity("ent_ip", "ip-address", "ipv4", "203.0.113.10");
  const observation: OsintObservation = { schemaVersion: "1.0.0", id: "obs_1", investigationId: "inv_72", entityId: subject.id, providerId: "censys", observedAt: "2026-08-03T16:41:00.000Z", retrievedAt: NOW, evidenceIds: [evidence.id], attributes: { service: "https" }, confidence: 0.97, confidenceCategory: "very-high", directness: "direct", freshness: "recent", coverageLimitations: [] };
  const structured = structureOsintObservation({ observation, entity: subject, evidence: [evidence] });
  const timeline = buildInvestigationTimeline({ observations: structured, claims: [{ schemaVersion: "1.0.0", id: "claim_1", investigationId: "inv_72", subjectEntityId: subject.id, predicate: "exposes_service", value: "https", validFrom: "2026-08-03T17:00:00.000Z", status: "supported", evidenceIds: [evidence.id], observationIds: [observation.id], confidence: 0.9, confidenceCategory: "high", explanation: "Direct scan evidence." }], relationships: [{ schemaVersion: "1.0.0", id: "rel_1", investigationId: "inv_72", sourceEntityId: subject.id, targetEntityId: "ent_cert", type: "USES", direction: "directed", observedAt: "2026-08-03T18:00:00.000Z", validFrom: "2026-08-03T18:00:00.000Z", evidenceIds: [evidence.id], confidence: 0.8, confidenceCategory: "high", status: "observed" }] });
  assert.deepEqual(timeline.map(({ kind }) => kind), ["observation", "claim", "relationship"]); assert.equal(timeline[2].validFrom, "2026-08-03T18:00:00.000Z");
});
