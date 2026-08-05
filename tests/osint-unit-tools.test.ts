/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { VoidCatJobManager } from "../build/voidcat-job-manager.ts";
import { VoidCatToolRegistry } from "../build/voidcat-tool-registry.ts";
import { DEFAULT_INVESTIGATION_BUDGET, type InvestigationSeed } from "../build/osint/contracts.ts";
import { LIVE_OSINT_PROVIDER_ADAPTERS, generateOpenSquatStyleCandidates, normalizeLiveProviderResult, type LiveOsintProviderId } from "../build/osint/live-provider-adapters.ts";
import { inferredOsintToolCall, markUncitedOsintConclusions, osintToolsForModel, validateOsintCitations } from "../build/osint/osint-unit-chat-tools.ts";
import { OsintUnitToolRuntime, type LiveUnitProviderResult } from "../build/osint/osint-unit-tools.ts";
import type { HunterSeekerPublicObservation } from "../build/hunter-seeker/hunter-seeker-service.ts";

const AT = "2026-07-28T18:00:00.000Z";
const hunterObservation: HunterSeekerPublicObservation = { observationId: "weather-gate8", entityId: "weather-alert:gate8", entityType: "weather-alert", position: { latitude: 29.76, longitude: -95.37 }, timestamp: AT, provenance: { sourceFeedId: "noaa.nws-alerts", fetchedAt: AT, receivedAt: AT, upstreamTimestamp: AT, stalenessMs: 0 }, confidence: 0.95, basis: "measured", retentionClass: "bulk", attributes: { event: "Gate 8 Flood Warning", severity: "Severe" } };

function rawFixture(providerId: LiveOsintProviderId, target: string) {
  if (providerId === "opensquat-local") return generateOpenSquatStyleCandidates(target, 8);
  if (providerId === "searxng") return { results: [{ title: `Passive record for ${target}`, url: "https://example.test/evidence", content: "Fixture public evidence.", engine: "fixture" }] };
  if (providerId === "shodan") return { ip_str: target, ports: [443], hostnames: ["host.example.test"], org: "Fixture Network", asn: "AS64500", last_update: AT };
  if (providerId === "censys") return { result: { resource: { services: [{ port: 443, service_name: "HTTPS", observed_at: AT }], last_updated_at: AT, location: { country: "US" } } } };
  if (providerId === "hibp") return [{ Name: "FixtureBreach" }];
  return [];
}

function fixtureExecutor(calls: LiveOsintProviderId[] = []) {
  return async (body: Record<string, unknown>, options: { investigationId: string; signal?: AbortSignal }): Promise<LiveUnitProviderResult> => {
    if (options.signal?.aborted) throw options.signal.reason;
    const providerId = String(body.providerId) as LiveOsintProviderId; calls.push(providerId);
    const adapter = LIVE_OSINT_PROVIDER_ADAPTERS.find(({ descriptor }) => descriptor.id === providerId)!;
    const seed: InvestigationSeed = { type: body.targetType as InvestigationSeed["type"], value: String(body.target), attributes: {}, source: { kind: "agent", id: "test-unit" } };
    const query = adapter.plan(seed, { investigationId: options.investigationId, objective: String(body.objective), authorizationMode: body.authorizationMode as "public-research" | "exposure-check", budget: DEFAULT_INVESTIGATION_BUDGET })[0];
    if (!query) throw new Error(`${providerId} fixture could not plan this seed.`);
    const result = normalizeLiveProviderResult(providerId, rawFixture(providerId, seed.value), { investigationId: options.investigationId, query, provider: adapter.descriptor, retrievedAt: AT, budget: DEFAULT_INVESTIGATION_BUDGET, cache: { status: "fixture", ageMs: 0 } });
    return { investigationId: options.investigationId, result, hunterForwarding: providerId === "hibp" ? "blocked-pending-approval" : "not-sensitive" };
  };
}

function harness(calls: LiveOsintProviderId[] = []) {
  const registry = new VoidCatToolRegistry(); const jobs = new VoidCatJobManager({ maximumConcurrentJobs: 8, minimumUpdateIntervalMs: 0 });
  const runtime = new OsintUnitToolRuntime({ registry, jobs, executeProvider: fixtureExecutor(calls), resolveHunterObservation: async (id) => id === hunterObservation.observationId ? hunterObservation : undefined });
  const invoke = (name: string, args: Record<string, unknown>, maximumOutputTokens = 4_096) => runtime.startInvocation(name, args, { caller: { kind: "agent", id: "gate8-test", modelLane: "under-7gb-fixture" }, maximumOutputTokens }).result;
  return { runtime, registry, jobs, invoke };
}

test("all high-level collection and intelligence tools use closed registry schemas without raw provider selection", () => {
  const { runtime, registry } = harness(); const tools = runtime.discover();
  assert.deepEqual(tools.map(({ name }) => name), ["osint-unit.authorized-exposure-check", "osint-unit.build-source-lineage", "osint-unit.calculate-confidence", "osint-unit.compare-entities", "osint-unit.create-hypothesis", "osint-unit.expand-entity", "osint-unit.explain-claim-or-confidence", "osint-unit.find-paths-between-entities", "osint-unit.generate-collection-plan", "osint-unit.get-entity-profile", "osint-unit.get-entity-timeline", "osint-unit.identify-information-gaps", "osint-unit.investigate-domain", "osint-unit.investigate-hunter-event", "osint-unit.investigate-infrastructure", "osint-unit.investigate-ip", "osint-unit.investigate-organization", "osint-unit.investigate-username", "osint-unit.list-candidate-leads", "osint-unit.retrieve-contradictions", "osint-unit.retrieve-evidence", "osint-unit.retrieve-supporting-evidence", "osint-unit.run-pattern-detector", "osint-unit.run-quality-checks", "osint-unit.search-entities", "osint-unit.search-geospatial-observations", "osint-unit.search-passive-web-sources", "osint-unit.test-hypothesis"]);
  for (const tool of tools) { assert.equal(tool.module, "osint-unit"); assert.equal(tool.inputSchema.additionalProperties, false); assert.equal("providerId" in (tool.inputSchema.properties ?? {}), false); assert.ok(tool.rateLimit.invocations > 0); }
  assert.equal(registry.discover({ module: "osint-unit" }).length, 28); runtime.dispose();
});

test("domain, IP, username, organization, infrastructure, Hunter event, and web tools use only fixed policy paths", async () => {
  const calls: LiveOsintProviderId[] = []; const { runtime, registry, jobs, invoke } = harness(calls);
  const domain = await invoke("osint-unit.investigate-domain", { domain: "example.com" });
  const ip = await invoke("osint-unit.investigate-ip", { ipAddress: "203.0.113.8" });
  await invoke("osint-unit.investigate-username", { username: "voidcat_operator" });
  await invoke("osint-unit.investigate-organization", { organization: "VoidCat Research" });
  await invoke("osint-unit.investigate-infrastructure", { targetType: "domain", target: "example.com" });
  const hunter = await invoke("osint-unit.investigate-hunter-event", { observationId: hunterObservation.observationId });
  await invoke("osint-unit.search-passive-web-sources", { query: "bounded fixture query" });
  assert.deepEqual(calls, ["opensquat-local", "searxng", "shodan", "censys", "searxng", "searxng", "shodan", "censys", "searxng", "searxng"]);
  for (const result of [domain, ip, hunter]) { assert.ok(result.investigationId); assert.ok(result.evidence.length); assert.ok(result.citations.every(({ marker, evidenceId }) => marker === `[EV:${evidenceId}]`)); assert.deepEqual(result.unsupportedConclusions, []); }
  assert.ok(hunter.evidence.some(({ sourceRef }) => sourceRef.includes(hunterObservation.observationId)));
  assert.equal(registry.invocationRecords({ module: "osint-unit" }).length, 7); assert.equal(jobs.list({ module: "osint-unit" }).filter(({ status }) => status === "completed").length, 7); runtime.dispose();
});

test("evidence retrieval, confidence explanation, lead listing, and expansion remain cited and bounded", async () => {
  const { runtime, invoke } = harness(); const domain = await invoke("osint-unit.investigate-domain", { domain: "example.com" }); const domainId = domain.investigationId!;
  const retrieved = await invoke("osint-unit.retrieve-evidence", { investigationId: domainId, evidenceIds: [domain.evidence[0].id] }); assert.equal(retrieved.evidence[0].id, domain.evidence[0].id);
  const leads = await invoke("osint-unit.list-candidate-leads", { investigationId: domainId, limit: 5 }); assert.ok(leads.candidateLeads.length); assert.ok(leads.candidateLeads.every(({ status }) => status === "candidate"));
  const expansion = await invoke("osint-unit.expand-entity", { investigationId: domainId, leadId: leads.candidateLeads[0].id }); assert.equal(expansion.status, "candidate-awaiting-operator-approval"); assert.match(expansion.summary, /no provider was contacted|suppressed/i); assert.match(expansion.nextAction ?? "", /approve/i);
  const ip = await invoke("osint-unit.investigate-ip", { ipAddress: "203.0.113.8" }); assert.ok(ip.claims.length); const explained = await invoke("osint-unit.explain-claim-or-confidence", { investigationId: ip.investigationId!, claimId: ip.claims[0].id }); assert.equal(explained.claims[0].id, ip.claims[0].id); assert.ok(explained.claims[0].evidenceIds.length); runtime.dispose();
});

test("local intelligence tools search, explain, compare, detect patterns, and test hypotheses without new provider calls", async () => {
  const calls: LiveOsintProviderId[] = []; const { runtime, invoke } = harness(calls);
  const domain = await invoke("osint-unit.investigate-domain", { domain: "example.com" }); const investigationId = domain.investigationId!; const callsAfterCollection = calls.length;
  const search = await invoke("osint-unit.search-entities", { investigationId, query: "example" }); assert.equal(search.analysis?.kind, "entity-search"); assert.ok(Array.isArray(search.analysis?.data));
  const entityId = domain.entities[0].id;
  const profile = await invoke("osint-unit.get-entity-profile", { investigationId, entityId }); assert.equal(profile.analysis?.kind, "entity-profile");
  const timeline = await invoke("osint-unit.get-entity-timeline", { investigationId, entityId }); assert.equal(timeline.analysis?.kind, "entity-timeline");
  const gaps = await invoke("osint-unit.identify-information-gaps", { investigationId }); assert.equal(gaps.analysis?.kind, "information-gaps");
  const patterns = await invoke("osint-unit.run-pattern-detector", { investigationId }); assert.equal(patterns.analysis?.kind, "pattern-signals");
  const quality = await invoke("osint-unit.run-quality-checks", { investigationId }); assert.equal(quality.analysis?.kind, "quality-findings");
  const lineage = await invoke("osint-unit.build-source-lineage", { investigationId }); assert.equal(lineage.analysis?.kind, "source-lineage");
  const geo = await invoke("osint-unit.search-geospatial-observations", { investigationId, latitude: 29.76, longitude: -95.37, radiusKm: 25, from: "2026-07-27T00:00:00.000Z", to: "2026-07-29T00:00:00.000Z" }); assert.equal(geo.analysis?.kind, "geospatial-observations");
  const contradictions = await invoke("osint-unit.retrieve-contradictions", { investigationId }); assert.equal(contradictions.analysis?.kind, "contradictions");
  const supporting = await invoke("osint-unit.retrieve-supporting-evidence", { investigationId, recordType: "claim", recordId: domain.claims[0].id }); assert.equal(supporting.analysis?.kind, "supporting-evidence");
  const confidence = await invoke("osint-unit.calculate-confidence", { investigationId, recordType: "claim", recordId: domain.claims[0].id }); assert.equal(confidence.analysis?.kind, "confidence-assessment");
  const plan = await invoke("osint-unit.generate-collection-plan", { investigationId }); assert.equal(plan.analysis?.kind, "collection-plan"); assert.match(plan.summary, /none were executed/i);
  if (domain.entities.length > 1) {
    const compared = await invoke("osint-unit.compare-entities", { investigationId, leftEntityId: domain.entities[0].id, rightEntityId: domain.entities[1].id }); assert.equal(compared.analysis?.kind, "entity-resolution-candidate"); assert.match(compared.summary, /No merge occurred/i);
    const paths = await invoke("osint-unit.find-paths-between-entities", { investigationId, sourceEntityId: domain.entities[0].id, targetEntityId: domain.entities[1].id, maximumDepth: 3 }); assert.equal(paths.analysis?.kind, "graph-paths");
  }
  assert.ok(domain.claims[0]?.id);
  const created = await invoke("osint-unit.create-hypothesis", { investigationId, statement: "The observed domain association may recur.", supportingObservationIds: [], supportingClaimIds: [domain.claims[0].id] }); assert.equal(created.analysis?.kind, "hypothesis");
  const hypothesisId = (created.analysis?.data as { id: string }).id; const tested = await invoke("osint-unit.test-hypothesis", { investigationId, hypothesisId }); assert.equal(tested.analysis?.kind, "hypothesis-assessment");
  assert.equal(calls.length, callsAfterCollection); runtime.dispose();
});

test("authorized exposure requires a separate one-time exact-target operator action", async () => {
  const calls: LiveOsintProviderId[] = []; const { runtime, invoke } = harness(calls);
  const held = await invoke("osint-unit.authorized-exposure-check", { targetType: "email-address", exactTarget: "operator@example.com" }); assert.equal(held.status, "approval-required"); assert.deepEqual(calls, []);
  const approval = runtime.authorizeExposure({ targetType: "email-address", exactTarget: "operator@example.com", statement: "I own and authorize checking this exact inbox." }); assert.equal(approval.oneTime, true);
  const live = await invoke("osint-unit.authorized-exposure-check", { targetType: "email-address", exactTarget: "operator@example.com" }); assert.equal(live.status, "completed"); assert.deepEqual(calls, ["hibp"]); assert.ok(live.evidence.every(({ sensitivity }) => sensitivity === "exposure-sensitive"));
  const consumed = await invoke("osint-unit.authorized-exposure-check", { targetType: "email-address", exactTarget: "operator@example.com" }); assert.equal(consumed.status, "approval-required"); runtime.dispose();
});

test("managed cancellation aborts an in-flight provider and context bounds the returned evidence", async () => {
  const registry = new VoidCatToolRegistry(); const jobs = new VoidCatJobManager({ minimumUpdateIntervalMs: 0 }); let aborted = false;
  const runtime = new OsintUnitToolRuntime({ registry, jobs, resolveHunterObservation: async () => undefined, executeProvider: async (_body, options) => new Promise((_resolve, reject) => { options.signal?.addEventListener("abort", () => { aborted = true; reject(options.signal?.reason); }, { once: true }); }) });
  const handle = runtime.startInvocation("osint-unit.investigate-domain", { domain: "example.com" }, { caller: { kind: "agent", id: "cancel-test" }, maximumOutputTokens: 2_048 }); await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(handle.cancel(), true); await assert.rejects(handle.result, /cancel/i); assert.equal(aborted, true); assert.equal(handle.snapshot().status, "cancelled"); for (let count = 0; count < 20 && handle.snapshot().cleanupPending; count += 1) await new Promise((resolve) => setTimeout(resolve, 5)); assert.equal(handle.snapshot().cleanupPending, false); runtime.dispose();
});

test("model formatting exposes only aliases and unsupported conclusions are marked", async () => {
  const { runtime, invoke } = harness(); const discovered = runtime.discover(); const modelTools = osintToolsForModel(discovered); assert.equal(modelTools.length, 28); assert.ok(modelTools.every(({ function: item }) => item.name.startsWith("osint_") && !("providerId" in (item.parameters.properties ?? {}))));
  const inferred = inferredOsintToolCall("Investigate domain example.com", discovered); assert.equal(inferred?.function.name, "osint_investigate_domain");
  const result = await invoke("osint-unit.investigate-domain", { domain: "example.com" }); const evidenceId = result.evidence[0].id; const grounded = markUncitedOsintConclusions(`Evidence exists [EV:${evidenceId}]. A speculative owner is Alice.`, [result]); assert.match(grounded, /speculative owner is Alice\. \[UNSUPPORTED — NO EVIDENCE ID\]/); const validation = validateOsintCitations(grounded, [result]); assert.equal(validation.valid, true); assert.equal(validateOsintCitations("Claim [EV:invented]", [result]).valid, false); runtime.dispose();
});
