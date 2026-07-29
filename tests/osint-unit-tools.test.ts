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

test("all twelve high-level tools use closed registry schemas without raw provider selection", () => {
  const { runtime, registry } = harness(); const tools = runtime.discover();
  assert.deepEqual(tools.map(({ name }) => name), ["osint-unit.authorized-exposure-check", "osint-unit.expand-entity", "osint-unit.explain-claim-or-confidence", "osint-unit.investigate-domain", "osint-unit.investigate-hunter-event", "osint-unit.investigate-infrastructure", "osint-unit.investigate-ip", "osint-unit.investigate-organization", "osint-unit.investigate-username", "osint-unit.list-candidate-leads", "osint-unit.retrieve-evidence", "osint-unit.search-passive-web-sources"]);
  for (const tool of tools) { assert.equal(tool.module, "osint-unit"); assert.equal(tool.inputSchema.additionalProperties, false); assert.equal("providerId" in (tool.inputSchema.properties ?? {}), false); assert.ok(tool.rateLimit.invocations > 0); }
  assert.equal(registry.discover({ module: "osint-unit" }).length, 12); runtime.dispose();
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
  const { runtime, invoke } = harness(); const discovered = runtime.discover(); const modelTools = osintToolsForModel(discovered); assert.equal(modelTools.length, 12); assert.ok(modelTools.every(({ function: item }) => item.name.startsWith("osint_") && !("providerId" in (item.parameters.properties ?? {}))));
  const inferred = inferredOsintToolCall("Investigate domain example.com", discovered); assert.equal(inferred?.function.name, "osint_investigate_domain");
  const result = await invoke("osint-unit.investigate-domain", { domain: "example.com" }); const evidenceId = result.evidence[0].id; const grounded = markUncitedOsintConclusions(`Evidence exists [EV:${evidenceId}]. A speculative owner is Alice.`, [result]); assert.match(grounded, /speculative owner is Alice\. \[UNSUPPORTED — NO EVIDENCE ID\]/); const validation = validateOsintCitations(grounded, [result]); assert.equal(validation.valid, true); assert.equal(validateOsintCitations("Claim [EV:invented]", [result]).valid, false); runtime.dispose();
});
