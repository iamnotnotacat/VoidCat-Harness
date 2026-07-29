import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { HunterSeekerPublicObservation } from "../build/hunter-seeker/hunter-seeker-service.ts";
import { VoidCatJobManager } from "../build/voidcat-job-manager.ts";
import { MockOsintInvestigationRuntime, MockProviderExecutor, MOCK_INVESTIGATION_BUDGET, correlateOsintResults, createDefaultMockProviders } from "../build/osint/index.ts";

const NOW = Date.parse("2026-07-28T15:00:00.000Z");

function runtime() {
  const jobs = new VoidCatJobManager({ maximumConcurrentJobs: 1, maximumQueuedJobs: 4, minimumUpdateIntervalMs: 0, now: () => NOW });
  return { jobs, runtime: new MockOsintInvestigationRuntime({ jobs, now: () => NOW }) };
}

function aircraftObservation(): HunterSeekerPublicObservation {
  const timestamp = new Date(NOW - 30_000).toISOString();
  return {
    observationId: "fixture-aircraft-observation", entityId: "aircraft:ABC123", entityType: "military-aircraft",
    position: { latitude: 29.75, longitude: -95.36, altitudeMeters: 9_000 }, timestamp,
    provenance: { sourceFeedId: "fixture.hunter-air", fetchedAt: new Date(NOW).toISOString(), receivedAt: new Date(NOW).toISOString(), upstreamTimestamp: timestamp, stalenessMs: 30_000 },
    confidence: 0.91, basis: "measured", retentionClass: "bulk",
    attributes: { title: "VOID1", transponderHex: "abc123", callsign: "VOID 1", registration: "N100VC", groundspeedKnots: 420 },
  };
}

test("domain fixture runs end to end through managed jobs and produces a deterministic cited report", async () => {
  const firstRuntime = runtime();
  const input = { kind: "domain" as const, domain: "Example.COM.", objective: "Correlate bounded offline evidence for the seed domain.", authorizationMode: "public-research" as const, budget: { ...MOCK_INVESTIGATION_BUDGET } };
  const handle = firstRuntime.runtime.start(input); const first = await handle.result; const snapshot = handle.snapshot();
  assert.equal(snapshot.status, "completed"); assert.equal(snapshot.module, "osint-investigation"); assert.equal(snapshot.name, "mock-vertical-slice");
  assert.equal(snapshot.resources.externalCalls, 3); assert.equal(snapshot.progress.current, snapshot.progress.total);
  assert.equal(first.investigation.status, "completed"); assert.equal(first.plan.reservations.providers, 3); assert.equal(first.plan.reservations.externalCalls, 3);
  assert.ok(first.plan.reservations.externalCalls <= first.investigation.budget.maximumExternalCalls); assert.ok(first.plan.reservations.maximumEvidenceBytes <= first.investigation.budget.maximumEvidenceBytes);

  const domainEntities = first.correlation.entities.filter((entity) => entity.identifiers.some((identifier) => identifier.type === "domain" && identifier.normalizedValue === "example.com"));
  assert.equal(domainEntities.length, 1); assert.ok(first.correlation.deduplication.mergedEntities >= 3);
  const domainEntity = domainEntities[0];
  const organizationClaim = first.correlation.claims.find((claim) => claim.subjectEntityId === domainEntity.id && claim.predicate === "attribute.organization" && claim.value === "Example Research Cooperative");
  assert.ok(organizationClaim); assert.equal(organizationClaim.status, "supported"); assert.equal(organizationClaim.confidenceCategory, "very-high"); assert.equal(organizationClaim.evidenceIds.length, 3);
  assert.match(organizationClaim.explanation, /3 independent source families/);
  const entityIds = new Set(first.correlation.entities.map(({ id }) => id)); const evidenceIds = new Set(first.correlation.evidence.map(({ id }) => id));
  for (const relationship of first.correlation.relationships) {
    assert.ok(entityIds.has(relationship.sourceEntityId)); assert.ok(entityIds.has(relationship.targetEntityId)); assert.ok(relationship.evidenceIds.every((id) => evidenceIds.has(id)));
  }
  assert.deepEqual(new Set(first.correlation.leads.map(({ seed }) => seed.type)), new Set(["ip-address", "organization", "username"]));
  assert.ok(first.correlation.leads.every((lead) => lead.status === "candidate" && lead.depth === 1));
  assert.equal(first.expansion.candidateCount, first.correlation.leads.length); assert.equal(first.expansion.execution.automatic, false); assert.equal(first.expansion.execution.requiresExplicitApproval, true);
  assert.ok(first.expansion.suggestions.every(({ automatic, requiresExplicitApproval }) => automatic === false && requiresExplicitApproval === true));
  assert.equal(first.report.evidenceMode, "deterministic-offline-fixtures"); assert.equal(first.report.counts.candidateLeads, 3); assert.match(first.report.markdown, /MOCK EVIDENCE ONLY/); assert.match(first.report.markdown, /\[EV:ev_/); assert.ok(!first.report.markdown.includes(handle.jobId));
  for (const finding of first.report.findings) { assert.ok(finding.evidenceIds.length > 0); for (const id of finding.evidenceIds) assert.ok(first.report.markdown.includes(`[EV:${id}]`)); }
  assert.equal(first.investigation.id, "inv_c221e2bf71f738bf99349ec9"); assert.equal(first.plan.id, "plan_341edcd410feb4725e3ce97d"); assert.equal(first.report.id, "report_c5d7d9e4d89b95e7d2b51c28");
  assert.deepEqual(first.report.counts, { entities: 5, observations: 6, claims: 12, relationships: 4, evidence: 3, evidenceBytes: 333, candidateLeads: 3, contradictions: 0, changes: 0 });
  assert.equal(createHash("sha256").update(first.report.markdown).digest("hex"), "0179e8a34aeba5ed6e3aad67ca11a9bd0077aeb755ec12673ddd23b5a7c5fc7c");

  const secondRuntime = runtime(); const second = await secondRuntime.runtime.start(input).result;
  assert.deepEqual(second, first);
});

test("Hunter-Seeker observation intake remains cited and deduplicates with mock context", async () => {
  const fixture = runtime(); const observation = aircraftObservation();
  const handle = fixture.runtime.start({ kind: "hunter-observation", observation, objective: "Create a bounded offline context report for the selected aircraft." });
  const result = await handle.result; const snapshot = handle.snapshot();
  assert.equal(snapshot.status, "completed"); assert.equal(snapshot.resources.externalCalls, 1); assert.equal(result.plan.steps[0].providerId, "mock.hunter-context");
  assert.equal(result.correlation.entities.filter(({ type }) => type === "aircraft").length, 1); assert.equal(result.correlation.deduplication.mergedEntities, 1);
  const hunterEvidence = result.correlation.evidence.find(({ providerId }) => providerId === "hunter-seeker");
  assert.ok(hunterEvidence); assert.equal(hunterEvidence.metadata.hunterObservationId, observation.observationId); assert.match(hunterEvidence.sourceRef, new RegExp(observation.observationId));
  assert.ok(result.correlation.observations.some(({ id }) => id.includes("obs_") && evidenceIdsForObservation(result, id).includes(hunterEvidence.id)));
  assert.equal(result.report.counts.evidence, 2); assert.equal(result.report.counts.candidateLeads, 0); assert.match(result.report.markdown, new RegExp(`EV:${hunterEvidence.id}`));
});

function evidenceIdsForObservation(result: Awaited<ReturnType<MockOsintInvestigationRuntime["start"]>["result"]>, observationId: string) {
  return result.correlation.observations.find(({ id }) => id === observationId)?.evidenceIds ?? [];
}

test("custom budgets bound provider fan-out and malformed domains fail before a job starts", async () => {
  const fixture = runtime();
  const result = await fixture.runtime.start({ kind: "domain", domain: "example.com", objective: "Use only two offline fixture providers.", budget: { ...MOCK_INVESTIGATION_BUDGET, maximumProviders: 2, maximumExternalCalls: 2 } }).result;
  assert.equal(result.plan.steps.length, 2); assert.equal(result.investigation.counts.externalCalls, 2); assert.equal(result.report.scope.providers.length, 2);
  assert.throws(() => fixture.runtime.start({ kind: "domain", domain: "https://example.com/admin", objective: "Invalid input must fail closed." }), /plain fully qualified domain name/);
  assert.equal(fixture.jobs.list().length, 1);
});

test("a queued mock investigation can be hard-cancelled through the shared job manager", async () => {
  const fixture = runtime(); const handle = fixture.runtime.start({ kind: "domain", domain: "example.com", objective: "Cancellation fixture." });
  assert.equal(handle.cancel(), true); await assert.rejects(handle.result, /cancel/i); assert.equal(handle.snapshot().status, "cancelled");
});

test("an in-flight mock provider operation aborts promptly and releases its managed job", async () => {
  const jobs = new VoidCatJobManager({ maximumConcurrentJobs: 1, maximumQueuedJobs: 2, minimumUpdateIntervalMs: 0, now: () => NOW });
  const executor = new MockProviderExecutor(undefined, { delayMs: 5_000 }); const investigationRuntime = new MockOsintInvestigationRuntime({ jobs, executor, now: () => NOW });
  const handle = investigationRuntime.start({ kind: "domain", domain: "example.com", objective: "In-flight cancellation fixture." });
  await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(handle.snapshot().status, "running");
  const started = performance.now(); assert.equal(handle.cancel(), true); await assert.rejects(handle.result, /cancel/i);
  assert.ok(performance.now() - started < 1_000); assert.equal(handle.snapshot().status, "cancelled");
  for (let attempt = 0; attempt < 20 && handle.snapshot().cleanupPending; attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(handle.snapshot().cleanupPending, false); assert.equal(handle.snapshot().resources.externalCalls, 1);
});

test("conflicting normalized observations remain separate contested claims with a confidence penalty", async () => {
  const fixture = runtime(); const baseline = await fixture.runtime.start({ kind: "domain", domain: "example.com", objective: "Contradiction fixture." }).result;
  const providerResults = structuredClone(baseline.providerResults); const sourceResult = providerResults.find(({ providerId }) => providerId === "mock.passive-dns") as typeof providerResults[number];
  const original = sourceResult.observations.find(({ attributes }) => attributes.organization === "Example Research Cooperative") as typeof sourceResult.observations[number];
  sourceResult.observations.push({ ...structuredClone(original), id: "obs_deliberate_conflict", attributes: { ...original.attributes, organization: "Different Fixture Organization" } });
  const providers = createDefaultMockProviders().map(({ descriptor }) => descriptor);
  const correlated = correlateOsintResults({ investigationId: baseline.investigation.id, providerResults, providers });
  const contested = correlated.claims.filter(({ subjectEntityId, predicate }) => subjectEntityId === original.entityId && predicate === "attribute.organization");
  assert.equal(contested.length, 2); assert.ok(contested.every(({ status }) => status === "contested")); assert.equal(correlated.contradictions.length, 1);
  const supportedBaseline = baseline.correlation.claims.find(({ subjectEntityId, predicate }) => subjectEntityId === original.entityId && predicate === "attribute.organization") as typeof baseline.correlation.claims[number];
  assert.ok(contested.every(({ confidence }) => confidence < supportedBaseline.confidence));
});

test("Gate 2 runtime contains no network, database, credential, or filesystem-write primitive", async () => {
  const files = ["mock-providers.ts", "correlation-and-confidence.ts", "mock-investigation-runtime.ts"];
  const joined = (await Promise.all(files.map((file) => readFile(path.join(process.cwd(), "build", "osint", file), "utf8")))).join("\n");
  for (const forbidden of [/\bfetch\s*\(/, /node:https?/, /node:(?:net|tls|dns)/, /DatabaseSync/, /writeFile/, /safeStorage/, /credentialStore/]) assert.doesNotMatch(joined, forbidden);
});
