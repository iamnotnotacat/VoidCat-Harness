import assert from "node:assert/strict";
import test from "node:test";
import { VoidCatJobManager } from "../build/voidcat-job-manager.ts";
import {
  MOCK_INVESTIGATION_BUDGET,
  MockOsintInvestigationRuntime,
  correlateOsintResults,
  createDefaultMockProviders,
  type MockInvestigationResult,
  type OsintEntity,
} from "../build/osint/index.ts";

const NOW = Date.parse("2026-07-28T15:00:00.000Z");

async function fixture() {
  const jobs = new VoidCatJobManager({ maximumConcurrentJobs: 1, maximumQueuedJobs: 2, minimumUpdateIntervalMs: 0, now: () => NOW });
  return new MockOsintInvestigationRuntime({ jobs, now: () => NOW }).start({ kind: "domain", domain: "example.com", objective: "Gate 5 correlation fixture.", budget: { ...MOCK_INVESTIGATION_BUDGET } }).result;
}

function correlate(result: MockInvestigationResult, providerResults = structuredClone(result.providerResults), reliability = 1) {
  const providers = createDefaultMockProviders().map(({ descriptor }) => ({ ...descriptor, reliability: Math.min(descriptor.reliability, reliability) }));
  return correlateOsintResults({ investigationId: result.investigation.id, providerResults, providers });
}

function entity(id: string, type: OsintEntity["type"], identifier: OsintEntity["identifiers"][number]): OsintEntity {
  return { schemaVersion: "1.0.0", id, type, displayName: identifier.value, identifiers: [identifier], attributes: {}, createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString() };
}

function identifier(id: string, type: OsintEntity["identifiers"][number]["type"], value: string, normalizedValue: string, confidence = 0.95) {
  return { schemaVersion: "1.0.0" as const, id, type, value, normalizedValue, confidence, evidenceIds: [] };
}

test("exact, normalized, and high-confidence alias matches are explainable and preserve alias values", async () => {
  const baseline = await fixture(); const results = structuredClone(baseline.providerResults);
  results[0].entities.push(entity("ent_exact_a", "ip-address", identifier("id_exact_a", "ipv4", "203.0.113.10", "203.0.113.10")));
  results[1].entities.push(entity("ent_exact_b", "ip-address", identifier("id_exact_b", "ipv4", "203.0.113.10", "203.0.113.10")));
  results[0].entities.push(entity("ent_normalized_a", "domain", identifier("id_normalized_a", "domain", "CASE.Example", "case.example")));
  results[1].entities.push(entity("ent_normalized_b", "domain", identifier("id_normalized_b", "domain", "case.example.", "case.example")));
  results[0].entities.push(entity("ent_alias_a", "organization", identifier("id_alias_a", "organization-name", "Void Cat Analysis Group", "void cat analysis group")));
  results[1].entities.push(entity("ent_alias_b", "organization", identifier("id_alias_b", "organization-name", "VOID CAT ANALYSIS GROUP", "void cat analysis group", 0.9)));
  results[0].entities.push(entity("ent_weak_alias_a", "organization", identifier("id_weak_alias_a", "organization-name", "Common Name", "common name", 0.4)));
  results[1].entities.push(entity("ent_weak_alias_b", "organization", identifier("id_weak_alias_b", "organization-name", "COMMON NAME", "common name", 0.4)));

  const correlated = correlate(baseline, results);
  assert.ok(correlated.identityLinks.some(({ matchKind, normalizedValue }) => matchKind === "exact" && normalizedValue === "203.0.113.10"));
  assert.ok(correlated.identityLinks.some(({ matchKind, normalizedValue }) => matchKind === "normalized" && normalizedValue === "case.example"));
  const aliasLink = correlated.identityLinks.find(({ matchKind, normalizedValue }) => matchKind === "alias" && normalizedValue === "void cat analysis group");
  assert.ok(aliasLink); assert.deepEqual(aliasLink.values, ["VOID CAT ANALYSIS GROUP", "Void Cat Analysis Group"]);
  const aliasEntity = correlated.entities.find(({ id }) => id === aliasLink.canonicalEntityId)!;
  assert.equal(aliasEntity.identifiers.filter(({ normalizedValue }) => normalizedValue === "void cat analysis group").length, 2);
  assert.equal(correlated.entities.filter(({ identifiers }) => identifiers.some(({ normalizedValue }) => normalizedValue === "common name")).length, 2, "weak name aliases must not collapse distinct entities");
});

test("temporal observations remain separate and service-set changes become explicit change records", async () => {
  const baseline = await fixture(); const results = structuredClone(baseline.providerResults);
  const source = results.find(({ providerId }) => providerId === "mock.passive-dns")!;
  const original = source.observations.find(({ attributes }) => attributes.organization === "Example Research Cooperative")!;
  original.attributes = { ...original.attributes, ports: [80, 443] };
  const reorderedAt = new Date(Date.parse(original.observedAt) + 30_000).toISOString();
  source.observations.push({ ...structuredClone(original), id: "obs_service_reordered", observedAt: reorderedAt, retrievedAt: reorderedAt, attributes: { ...original.attributes, ports: [443, 80] } });
  const later = new Date(Date.parse(original.observedAt) + 3_600_000).toISOString();
  source.observations.push({ ...structuredClone(original), id: "obs_temporal_change", observedAt: later, retrievedAt: later, attributes: { ...original.attributes, organization: "Example Research Cooperative LLC", ports: [80, 443, 8443] } });

  const correlated = correlate(baseline, results);
  assert.equal(correlated.observations.filter(({ id }) => id === original.id || id === "obs_temporal_change").length, 2);
  const organizationChange = correlated.changes.find(({ predicate }) => predicate === "attribute.organization");
  assert.ok(organizationChange); assert.equal(organizationChange.changeType, "attribute-change");
  const serviceChange = correlated.changes.find(({ predicate }) => predicate === "attribute.ports");
  assert.ok(serviceChange); assert.equal(serviceChange.changeType, "service-change"); assert.deepEqual(serviceChange.fromValue, [80, 443]); assert.deepEqual(serviceChange.toValue, [80, 443, 8443]);
  assert.equal(correlated.changes.filter(({ predicate }) => predicate === "attribute.ports").length, 1, "service array reordering is not a change");
  const organizationClaims = correlated.claims.filter(({ subjectEntityId, predicate }) => subjectEntityId === original.entityId && predicate === "attribute.organization");
  assert.equal(organizationClaims.length, 2); assert.equal(organizationClaims.find(({ value }) => value === "Example Research Cooperative")?.status, "superseded");
  assert.equal(organizationClaims.find(({ value }) => value === "Example Research Cooperative LLC")?.status, "supported");
  assert.equal(correlated.contradictions.filter(({ predicate }) => predicate === "attribute.organization").length, 0);
});

test("contemporaneous conflicts create explicit contradictions and reciprocal conclusion evidence", async () => {
  const baseline = await fixture(); const results = structuredClone(baseline.providerResults);
  const source = results.find(({ providerId }) => providerId === "mock.passive-dns")!;
  const original = source.observations.find(({ attributes }) => attributes.organization === "Example Research Cooperative")!;
  const concurrentAt = new Date(Date.parse(original.observedAt) + 30_000).toISOString();
  source.observations.push({ ...structuredClone(original), id: "obs_conflict_gate5", observedAt: concurrentAt, retrievedAt: concurrentAt, attributes: { ...original.attributes, organization: "Conflicting Organization" } });
  const correlated = correlate(baseline, results);
  const contradiction = correlated.contradictions.find(({ subjectEntityId, predicate }) => subjectEntityId === original.entityId && predicate === "attribute.organization");
  assert.ok(contradiction); assert.equal(contradiction.claimIds.length, 2); assert.equal(contradiction.values.length, 2); assert.ok(contradiction.evidenceIds.length >= 1); assert.match(contradiction.explanation, /silently selected/);
  for (const claimId of contradiction.claimIds) {
    const conclusion = correlated.conclusions.find((item) => item.claimId === claimId)!;
    assert.equal(conclusion.confidence.contradictionPenalty, 0.55); assert.equal(conclusion.contradictingClaimIds.length, 1); assert.ok(conclusion.contradictingEvidenceIds.length >= 1);
  }
});

test("confidence explains independence, reliability, freshness, directness, contradictions, and coverage", async () => {
  const baseline = await fixture(); const direct = correlate(baseline);
  const claim = direct.claims.find(({ predicate, value }) => predicate === "attribute.organization" && value === "Example Research Cooperative")!;
  const conclusion = direct.conclusions.find(({ claimId }) => claimId === claim.id)!;
  assert.equal(conclusion.confidence.independentSourceCount, 3); assert.equal(conclusion.confidence.sources.length, 3); assert.equal(conclusion.confidence.contradictionPenalty, 1);
  assert.ok(conclusion.supportingEvidenceIds.length === 3); assert.ok(conclusion.freshness.newestObservedAt); assert.ok(conclusion.coverageLimitations.length >= 1);
  for (const phrase of ["Claim:", "Support:", "Contradiction:", "Freshness:", "Confidence:", "Coverage:"]) assert.match(claim.explanation, new RegExp(phrase));

  const sharedResults = structuredClone(baseline.providerResults);
  for (const result of sharedResults) for (const evidence of result.evidence) evidence.metadata = { ...evidence.metadata, sourceFamily: "shared-upstream-dataset" };
  const shared = correlate(baseline, sharedResults); const sharedClaim = shared.claims.find(({ predicate, value }) => predicate === claim.predicate && value === claim.value)!;
  const sharedConclusion = shared.conclusions.find(({ claimId }) => claimId === sharedClaim.id)!;
  assert.equal(sharedConclusion.confidence.independentSourceCount, 1); assert.ok(sharedClaim.confidence < claim.confidence);

  const lowReliability = correlate(baseline, undefined, 0.2); const lowClaim = lowReliability.claims.find(({ predicate, value }) => predicate === claim.predicate && value === claim.value)!;
  assert.ok(lowClaim.confidence < claim.confidence);

  const staleResults = structuredClone(baseline.providerResults);
  for (const result of staleResults) for (const observation of result.observations) if (observation.attributes.organization === "Example Research Cooperative") { observation.directness = "inferred"; observation.freshness = "historical"; }
  const stale = correlate(baseline, staleResults); const staleClaim = stale.claims.find(({ predicate, value }) => predicate === claim.predicate && value === claim.value)!;
  assert.ok(staleClaim.confidence < claim.confidence);
});
