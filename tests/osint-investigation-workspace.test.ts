/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { VoidCatJobManager } from "../build/voidcat-job-manager.ts";
import { DEFAULT_INVESTIGATION_BUDGET, LIVE_OSINT_PROVIDER_ADAPTERS, OsintInvestigationWorkspace, OsintStore, generateOpenSquatStyleCandidates, normalizeLiveProviderResult, renderStoredInvestigationReport, type InvestigationSeed, type LiveOsintProviderId } from "../build/osint/index.ts";

const NOW = Date.parse("2026-07-28T21:00:00.000Z");
async function disposableStore() { const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voidcat-osint-test-")); const store = new OsintStore({ dataRoot, mode: "synthetic", now: () => NOW, minimumFreeBytes: 0, writeGuard: async () => ({ allowed: true }) }); await store.initialize(); return { dataRoot, store }; }
async function cleanup(dataRoot: string, store: OsintStore) { store.close(); assert.ok(path.basename(dataRoot).startsWith("voidcat-osint-test-")); await fs.rm(dataRoot, { recursive: true, force: true }); }

function fixtureExecutor(calls: string[]) {
  return async (body: Record<string, unknown>, options: { investigationId: string; signal: AbortSignal }) => {
    if (options.signal.aborted) throw options.signal.reason; const providerId = String(body.providerId) as LiveOsintProviderId; calls.push(providerId);
    const adapter = LIVE_OSINT_PROVIDER_ADAPTERS.find(({ descriptor }) => descriptor.id === providerId)!;
    const seed: InvestigationSeed = { type: String(body.targetType) as InvestigationSeed["type"], value: String(body.target), label: String(body.target), attributes: {}, source: { kind: "operator", id: "gate-nine-test" } };
    const query = adapter.plan(seed, { investigationId: options.investigationId, objective: String(body.objective), authorizationMode: String(body.authorizationMode) as "public-research", budget: { ...DEFAULT_INVESTIGATION_BUDGET } })[0];
    const raw = providerId === "opensquat-local" ? generateOpenSquatStyleCandidates(seed.value, 5) : { results: [{ title: "Example evidence", url: "https://example.net/reference", content: "A bounded fixture relevant to the exact target.", engine: "fixture" }] };
    return { result: normalizeLiveProviderResult(providerId, raw, { investigationId: options.investigationId, query, provider: adapter.descriptor, retrievedAt: new Date(NOW).toISOString(), budget: { ...DEFAULT_INVESTIGATION_BUDGET }, cache: { status: providerId === "opensquat-local" ? "fixture" : "cached", ageMs: providerId === "opensquat-local" ? 0 : 45_000 } }) };
  };
}

async function waitForTerminal(jobs: VoidCatJobManager, id: string) { for (let index = 0; index < 200; index += 1) { const snapshot = jobs.snapshot(id); if (["completed", "failed", "cancelled", "timed-out", "limit-exceeded"].includes(snapshot.status)) return snapshot; await new Promise((resolve) => setTimeout(resolve, 2)); } throw new Error("Managed investigation did not reach a terminal state."); }

test("Gate 9 preview exposes a fixed bounded plan without arbitrary provider input", async () => {
  const { dataRoot, store } = await disposableStore(); const jobs = new VoidCatJobManager({ now: () => NOW, minimumUpdateIntervalMs: 0 });
  try {
    const workspace = new OsintInvestigationWorkspace({ executeProvider: fixtureExecutor([]), store: async () => store, jobs, now: () => NOW });
    const preview = workspace.preview({ type: "domain", seed: "Example.COM", objective: "Review exact passive evidence.", authorizationMode: "public-research" });
    assert.equal(preview.policyDecision.outcome, "allow"); assert.deepEqual(preview.providerIds, ["opensquat-local", "searxng"]); assert.deepEqual(preview.availableProviderIds, ["opensquat-local", "searxng"]); assert.ok(preview.plan); assert.equal(preview.plan?.execution.followCandidateLeadsAutomatically, false);
    assert.ok(preview.plan!.reservations.providers <= preview.budget.maximumProviders); assert.ok(preview.plan!.reservations.externalCalls <= preview.budget.maximumExternalCalls); assert.equal(preview.budget.maximumDiscoveryDepth, 1);
    assert.throws(() => workspace.preview({ type: "authorized-exposure", seed: "person@example.com", objective: "Authorized exact exposure check.", authorizationMode: "exposure-check" }), /explicit authorization/);
  } finally { await cleanup(dataRoot, store); }
});

test("operator-edited plan accepts only a nonempty compatible provider subset", async () => {
  const { dataRoot, store } = await disposableStore(); const calls: string[] = []; const jobs = new VoidCatJobManager({ now: () => NOW, minimumUpdateIntervalMs: 0 });
  try {
    const workspace = new OsintInvestigationWorkspace({ executeProvider: fixtureExecutor(calls), store: async () => store, jobs, now: () => NOW });
    const input = { type: "domain" as const, seed: "example.com", objective: "Run the operator-approved local path only.", authorizationMode: "public-research" as const, approvedProviderIds: ["opensquat-local"] };
    const preview = workspace.preview(input); assert.deepEqual(preview.providerIds, ["opensquat-local"]); assert.deepEqual(preview.availableProviderIds, ["opensquat-local", "searxng"]); assert.equal(preview.plan?.steps.length, 1);
    const started = workspace.start(input); assert.equal((await waitForTerminal(jobs, started.jobId)).status, "completed"); assert.deepEqual(calls, ["opensquat-local"]);
    assert.throws(() => workspace.preview({ ...input, approvedProviderIds: [] }), /at least one/i); assert.throws(() => workspace.preview({ ...input, approvedProviderIds: ["shodan"] }), /outside the deterministic plan/i);
  } finally { await cleanup(dataRoot, store); }
});

test("managed investigation persists history, graph evidence, confidence, leads, and an exportable cited report", async () => {
  const { dataRoot, store } = await disposableStore(); const calls: string[] = []; const jobs = new VoidCatJobManager({ now: () => NOW, minimumUpdateIntervalMs: 0, maximumConcurrentJobs: 1 });
  try {
    const workspace = new OsintInvestigationWorkspace({ executeProvider: fixtureExecutor(calls), store: async () => store, jobs, now: () => NOW });
    const started = workspace.start({ type: "domain", seed: "example.com", objective: "Correlate exact passive evidence.", authorizationMode: "public-research" });
    const terminal = await waitForTerminal(jobs, started.jobId); assert.equal(terminal.status, "completed"); assert.deepEqual(calls, ["opensquat-local", "searxng"]); assert.ok(terminal.progress.message?.includes("complete"));
    const history = store.listInvestigations(); assert.equal(history.length, 1); assert.equal(history[0].id, started.investigationId); assert.equal(history[0].status, "completed");
    const view = store.getInvestigationView(started.investigationId)!; assert.ok(view.entities.length >= 2); assert.ok(view.evidence.length >= 2); assert.ok(view.relationships.length >= 1); assert.ok(view.leads.length >= 1); assert.ok(view.evidence.some(({ cache }) => cache.status === "cached" && cache.ageMs === 45_000));
    const report = renderStoredInvestigationReport(view); assert.match(report, /Evidence index/); assert.match(report, /\[EV:/); assert.match(report, /Candidate leads/);
    const approved = await store.setCandidateLeadStatus(started.investigationId, view.leads[0].id, "approved"); assert.equal(approved.providerRequestStarted, false); assert.equal(store.getInvestigationView(started.investigationId)!.leads[0].status, "approved"); assert.equal(store.checkConsistency().valid, true);
  } finally { await cleanup(dataRoot, store); }
});

test("hard cancellation aborts provider work and leaves no partial persisted graph", async () => {
  const { dataRoot, store } = await disposableStore(); const jobs = new VoidCatJobManager({ minimumUpdateIntervalMs: 0, maximumConcurrentJobs: 1 });
  try {
    const workspace = new OsintInvestigationWorkspace({ store: async () => store, jobs, executeProvider: (_body, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) });
    const started = workspace.start({ type: "ip-address", seed: "192.0.2.10", objective: "Cancellation test with no retained partial evidence.", authorizationMode: "public-research" });
    await new Promise((resolve) => setTimeout(resolve, 5)); assert.equal(jobs.cancel(started.jobId), true); const terminal = await waitForTerminal(jobs, started.jobId); assert.equal(terminal.status, "cancelled"); assert.equal(store.listInvestigations().length, 0); assert.equal(store.checkConsistency().valid, true);
  } finally { await cleanup(dataRoot, store); }
});
