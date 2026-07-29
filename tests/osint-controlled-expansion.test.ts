/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { VoidCatJobManager } from "../build/voidcat-job-manager.ts";
import {
  GATE6_EVIDENCE_RESERVATION_BYTES, GATE6_MAXIMUM_DISCOVERY_DEPTH, GATE6_RUNTIME_RESERVATION_MS,
  MOCK_INVESTIGATION_BUDGET, MockOsintInvestigationRuntime, approveControlledExpansion, createDefaultMockProviders, evaluateControlledExpansion,
  type InvestigationSeed, type MockInvestigationResult, type OsintInvestigation, type OsintLead,
} from "../build/osint/index.ts";

const NOW = Date.parse("2026-07-28T20:00:00.000Z"); const AT = new Date(NOW).toISOString();

async function fixture() {
  const jobs = new VoidCatJobManager({ maximumConcurrentJobs: 1, maximumQueuedJobs: 2, minimumUpdateIntervalMs: 0, now: () => NOW });
  return new MockOsintInvestigationRuntime({ jobs, now: () => NOW }).start({ kind: "domain", domain: "example.com", objective: "Gate 6 bounded expansion fixture.", budget: { ...MOCK_INVESTIGATION_BUDGET } }).result;
}
function providers() { return createDefaultMockProviders().map(({ descriptor }) => descriptor); }
function seed(type: InvestigationSeed["type"], value: string, sourceId = "gate6-fixture"): InvestigationSeed { return { type, value, label: value, attributes: {}, source: { kind: "candidate-lead", id: sourceId } }; }
function lead(result: MockInvestigationResult, id: string, seedValue: InvestigationSeed, overrides: Partial<OsintLead> = {}): OsintLead {
  return { ...result.correlation.leads[0], id, investigationId: result.investigation.id, seed: seedValue, status: "candidate", depth: 1, createdAt: AT, updatedAt: AT, ...overrides };
}
function usedProviderIds(result: MockInvestigationResult) { return [...new Set(result.plan.steps.map(({ providerId }) => providerId))]; }
function evaluate(result: MockInvestigationResult, leads: OsintLead[], overrides: Partial<Parameters<typeof evaluateControlledExpansion>[0]> = {}) {
  return evaluateControlledExpansion({ investigation: result.investigation, leads, providers: providers(), usage: { providerIds: usedProviderIds(result), runtimeMs: 0 }, ...overrides });
}

test("A to B to A paths are suppressed as cycles before any provider can run", async () => {
  const result = await fixture(); const ancestor = { ...result.investigation.seed, value: "alpha.example", label: "alpha.example" }; const current = { ...result.investigation.seed, value: "bravo.example", label: "bravo.example" };
  const investigation: OsintInvestigation = { ...result.investigation, id: "inv_gate6_cycle", seed: current };
  const returnLead = lead(result, "lead_cycle_return", { ...ancestor, source: { kind: "candidate-lead", id: "lead-from-bravo" } }, { investigationId: investigation.id });
  const evaluation = evaluateControlledExpansion({ investigation, leads: [returnLead], providers: providers(), ancestry: [ancestor], usage: { providerIds: usedProviderIds(result), externalCalls: 0, runtimeMs: 0, entities: 1, evidenceBytes: 0 } });
  assert.equal(evaluation.eligibleCount, 0); assert.deepEqual(evaluation.suggestions[0].suppressionReasons, ["cycle-detected"]); assert.equal(evaluation.suggestions[0].automatic, false);
});

test("normalized duplicates and previously investigated seeds are suppressed deterministically", async () => {
  const result = await fixture(); const leads = [lead(result, "lead_duplicate_a", seed("domain", "Candidate.Example.")), lead(result, "lead_duplicate_b", seed("domain", "candidate.example")), lead(result, "lead_already_done", seed("domain", "finished.example"))];
  const history = [{ investigationId: "inv_prior", seed: seed("domain", "FINISHED.EXAMPLE.") }]; const evaluation = evaluate(result, leads, { investigated: history });
  assert.equal(evaluation.suggestions.filter(({ seedKey, status }) => seedKey === "domain:candidate.example" && status === "eligible").length, 1);
  assert.equal(evaluation.suggestions.filter(({ suppressionReasons }) => suppressionReasons.includes("duplicate-candidate")).length, 1);
  assert.ok(evaluation.suggestions.find(({ seedKey }) => seedKey === "domain:finished.example")?.suppressionReasons.includes("already-investigated"));
  assert.deepEqual(evaluation, evaluate(result, [...leads].reverse(), { investigated: history }));
});

test("fan-out is hard bounded and every discovered entity remains an unsubmitted candidate", async () => {
  const result = await fixture(); const leads = Array.from({ length: 6 }, (_, index) => lead(result, `lead_fanout_${index}`, seed("domain", `candidate-${index}.example`)));
  const evaluation = evaluate(result, leads, { maximumFanOut: 2, usage: { providerIds: [], externalCalls: 0, runtimeMs: 0, entities: 0, evidenceBytes: 0 } });
  assert.equal(evaluation.maximumDepth, GATE6_MAXIMUM_DISCOVERY_DEPTH); assert.equal(evaluation.eligibleCount, 2); assert.equal(evaluation.suppressedCount, 4);
  assert.equal(evaluation.suggestions.filter(({ suppressionReasons }) => suppressionReasons.includes("fan-out-limit")).length, 4);
  assert.ok(evaluation.suggestions.every(({ lead: candidate, automatic, requiresExplicitApproval }) => candidate.status === "candidate" && automatic === false && requiresExplicitApproval));
  assert.equal(evaluation.reservedBySuggestions.externalCalls, 2); assert.equal(evaluation.reservedBySuggestions.runtimeMs, 2 * GATE6_RUNTIME_RESERVATION_MS); assert.equal(evaluation.reservedBySuggestions.evidenceBytes, 2 * GATE6_EVIDENCE_RESERVATION_BYTES);
  assert.throws(() => evaluate(result, leads, { maximumFanOut: 26 }), /between 1 and 25/);
});

test("provider and every investigation budget can independently suppress expansion", async () => {
  const result = await fixture(); const candidate = lead(result, "lead_budget", seed("domain", "budget.example")); const baseCounts = { providers: 0, externalCalls: 0, entities: 0, evidenceBytes: 0, leads: 1 };
  const make = (budget: OsintInvestigation["budget"], counts: OsintInvestigation["counts"], usage: Parameters<typeof evaluateControlledExpansion>[0]["usage"]) => evaluateControlledExpansion({ investigation: { ...result.investigation, budget, counts }, leads: [candidate], providers: providers(), usage });
  const providerHeld = make({ ...result.investigation.budget, maximumProviders: 1 }, { ...baseCounts, providers: 1 }, { providerIds: ["already.used"], externalCalls: 0, runtimeMs: 0, entities: 0, evidenceBytes: 0 }); assert.ok(providerHeld.suggestions[0].suppressionReasons.includes("provider-budget-exhausted"));
  const externalHeld = make(result.investigation.budget, baseCounts, { providerIds: [], externalCalls: result.investigation.budget.maximumExternalCalls, runtimeMs: 0, entities: 0, evidenceBytes: 0 }); assert.ok(externalHeld.suggestions[0].suppressionReasons.includes("external-call-budget-exhausted"));
  const runtimeHeld = make(result.investigation.budget, baseCounts, { providerIds: [], externalCalls: 0, runtimeMs: result.investigation.budget.maximumRuntimeMs - GATE6_RUNTIME_RESERVATION_MS + 1, entities: 0, evidenceBytes: 0 }); assert.ok(runtimeHeld.suggestions[0].suppressionReasons.includes("runtime-budget-exhausted"));
  const entityHeld = make(result.investigation.budget, baseCounts, { providerIds: [], externalCalls: 0, runtimeMs: 0, entities: result.investigation.budget.maximumEntities, evidenceBytes: 0 }); assert.ok(entityHeld.suggestions[0].suppressionReasons.includes("entity-budget-exhausted"));
  const evidenceHeld = make(result.investigation.budget, baseCounts, { providerIds: [], externalCalls: 0, runtimeMs: 0, entities: 0, evidenceBytes: result.investigation.budget.maximumEvidenceBytes - GATE6_EVIDENCE_RESERVATION_BYTES + 1 }); assert.ok(evidenceHeld.suggestions[0].suppressionReasons.includes("evidence-budget-exhausted"));
  const depthHeld = make({ ...result.investigation.budget, maximumDiscoveryDepth: 0 }, baseCounts, { providerIds: [], externalCalls: 0, runtimeMs: 0, entities: 0, evidenceBytes: 0 }); assert.ok(depthHeld.suggestions[0].suppressionReasons.includes("depth-limit"));
});

test("only an exact operator or Hunter-Seeker approval creates one bounded, still-unsubmitted next request", async () => {
  const result = await fixture(); const evaluation = evaluate(result, [lead(result, "lead_approval", seed("domain", "approval.example"))], { usage: { providerIds: [], externalCalls: 0, runtimeMs: 0, entities: 0, evidenceBytes: 0 } }); const suggestion = evaluation.suggestions.find(({ status }) => status === "eligible")!;
  assert.throws(() => approveControlledExpansion(evaluation, { investigationId: evaluation.investigationId, evaluationId: evaluation.id, suggestionId: suggestion.id, leadId: suggestion.lead.id, actor: "operator", actorId: "operator", confirmed: true, statement: "too short", approvedAt: AT }), /explicit actor/);
  const approved = approveControlledExpansion(evaluation, { investigationId: evaluation.investigationId, evaluationId: evaluation.id, suggestionId: suggestion.id, leadId: suggestion.lead.id, actor: "hunter-seeker", actorId: "hunter-observation:fixture", confirmed: true, statement: "Approve exactly this bounded passive candidate follow-up.", approvedAt: AT });
  assert.equal(approved.status, "approved-not-submitted"); assert.equal(approved.automatic, false); assert.equal(approved.submitted, false); assert.equal(approved.lead.status, "approved"); assert.equal(approved.nextRequest.seed.source.kind, "candidate-lead"); assert.equal(approved.nextRequest.budget.maximumDiscoveryDepth, 0); assert.equal(approved.nextRequest.budget.maximumExternalCalls, 1); assert.equal(approved.nextRequest.requestedProviderIds.length, 1); assert.equal(approved.nextRequest.requestedCapabilityIds.length, 1);
  const held = { ...evaluation, suggestions: evaluation.suggestions.map((item) => ({ ...item, status: "suppressed" as const, suppressionReasons: ["fan-out-limit" as const], reservation: undefined })) };
  assert.throws(() => approveControlledExpansion(held, { investigationId: held.investigationId, evaluationId: held.id, suggestionId: suggestion.id, leadId: suggestion.lead.id, actor: "operator", actorId: "operator", confirmed: true, statement: "Approve exactly this bounded passive candidate follow-up.", approvedAt: AT }), /suppressed candidate/);
});

test("the Gate 6 boundary contains no executor, job start, transport, or persistence primitive", async () => {
  const source = await readFile(path.join(process.cwd(), "build", "osint", "controlled-expansion.ts"), "utf8");
  for (const forbidden of [/\bfetch\s*\(/, /\.start\s*\(/, /\.query\s*\(/, /node:https?/, /node:(?:net|tls|dns)/, /DatabaseSync/, /writeFile/, /safeStorage/, /credentialStore/]) assert.doesNotMatch(source, forbidden);
});
