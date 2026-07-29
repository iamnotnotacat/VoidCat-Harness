/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_INVESTIGATION_BUDGET, type InvestigationSeed } from "../build/osint/contracts.ts";
import { LIVE_OSINT_PROVIDER_ADAPTERS, LIVE_OSINT_PROVIDER_DESCRIPTORS, generateOpenSquatStyleCandidates, normalizeLiveProviderResult, type LiveOsintProviderId } from "../build/osint/live-provider-adapters.ts";
import { OsintInvestigationWorkspace } from "../build/osint/osint-investigation-workspace.ts";
import { markUncitedOsintConclusions, validateOsintCitations } from "../build/osint/osint-unit-chat-tools.ts";
import type { OsintStore } from "../build/osint/osint-store.ts";
import { osintStableId } from "../build/osint/provider-contracts.ts";
import { VoidCatJobManager } from "../build/voidcat-job-manager.ts";

const root = process.cwd();
const at = "2026-07-28T20:00:00.000Z";
const domainSeed: InvestigationSeed = { type: "domain", value: "example.com", label: "example.com", attributes: {}, source: { kind: "operator", id: "gate-ten" } };
const input = { type: "domain" as const, seed: "example.com", objective: "Gate 10 bounded cancellation acceptance check.", authorizationMode: "public-research" as const };

async function terminal(jobs: VoidCatJobManager, id: string, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = jobs.snapshot(id);
    if (["completed", "failed", "cancelled", "timed-out"].includes(snapshot.status)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Managed job did not reach a terminal state in the acceptance-test window.");
}

function normalized(providerId: LiveOsintProviderId, investigationId: string) {
  const adapter = LIVE_OSINT_PROVIDER_ADAPTERS.find(({ descriptor }) => descriptor.id === providerId)!;
  const query = adapter.plan(domainSeed, { investigationId, objective: input.objective, authorizationMode: "public-research", budget: DEFAULT_INVESTIGATION_BUDGET })[0];
  const raw = providerId === "opensquat-local"
    ? generateOpenSquatStyleCandidates(domainSeed.value, 8)
    : { results: [{ title: "Gate 10 fixture", url: "https://example.test/evidence", content: "Passive fixture evidence.", engine: "fixture" }] };
  return normalizeLiveProviderResult(providerId, raw, { investigationId, query, provider: adapter.descriptor, retrievedAt: at, budget: DEFAULT_INVESTIGATION_BUDGET, cache: { status: "fixture", ageMs: 0 } });
}

function waitForSignal(start: (ready: () => void) => void) {
  return new Promise<void>((resolve) => start(resolve));
}

test("cancellation during a live provider stage reaches the provider and prevents persistence", async () => {
  const jobs = new VoidCatJobManager({ maximumConcurrentJobs: 1, maximumQueuedJobs: 1, minimumUpdateIntervalMs: 0 });
  let providerAborted = false; let storeCalls = 0; let ready!: () => void;
  const providerStarted = waitForSignal((resolve) => { ready = resolve; });
  const workspace = new OsintInvestigationWorkspace({ jobs, executeProvider: async (_body, options) => new Promise((_resolve, reject) => { ready(); options.signal.addEventListener("abort", () => { providerAborted = true; reject(options.signal.reason ?? new Error("cancelled")); }, { once: true }); }), store: async () => ({ saveInvestigationBundle: async () => { storeCalls += 1; } } as unknown as OsintStore) });
  const started = workspace.start(input); await providerStarted; assert.equal(jobs.cancel(started.jobId), true);
  const snapshot = await terminal(jobs, started.jobId); assert.equal(snapshot.status, "cancelled"); assert.equal(providerAborted, true); assert.equal(storeCalls, 0);
});

test("cancellation during the persistence stage reaches the isolated store without reporting completion", async () => {
  const jobs = new VoidCatJobManager({ maximumConcurrentJobs: 1, maximumQueuedJobs: 1, minimumUpdateIntervalMs: 0 });
  let persistenceAborted = false; let committed = false; let ready!: () => void;
  const persistenceStarted = waitForSignal((resolve) => { ready = resolve; });
  const workspace = new OsintInvestigationWorkspace({ jobs, executeProvider: async (body, options) => ({ result: normalized(String(body.providerId) as LiveOsintProviderId, options.investigationId) }), store: async () => ({ saveInvestigationBundle: async (_result: unknown, options: { signal?: AbortSignal }) => new Promise((_resolve, reject) => { ready(); options.signal?.addEventListener("abort", () => { persistenceAborted = true; reject(options.signal?.reason ?? new Error("cancelled")); }, { once: true }); }) } as unknown as OsintStore) });
  const started = workspace.start(input); await persistenceStarted; assert.equal(jobs.cancel(started.jobId), true);
  const snapshot = await terminal(jobs, started.jobId); committed = snapshot.status === "completed"; assert.equal(snapshot.status, "cancelled"); assert.equal(persistenceAborted, true); assert.equal(committed, false);
});

test("unsupported OSINT conclusions are marked and invented evidence identifiers fail closed", () => {
  const evidenceId = osintStableId("ev", { gate: 10 }); const results = [{ evidence: [{ id: evidenceId }] }];
  const marked = markUncitedOsintConclusions(`Observed service [EV:${evidenceId}]. A different owner controls it.`, results);
  assert.match(marked, /different owner controls it\. \[UNSUPPORTED/); assert.equal(validateOsintCitations(marked, results).valid, true);
  const invented = validateOsintCitations("Unsupported statement [EV:invented-evidence]", results); assert.equal(invented.valid, false); assert.deepEqual(invented.unknownEvidenceIds, ["invented-evidence"]);
});

test("the complete Gate 10 acceptance suite remains part of the default regression command", () => {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const command = packageJson.scripts["test:unit"];
  const required = [
    "tests/osint-gate-ten-acceptance.test.ts", "tests/osint-live-providers.test.ts", "tests/osint-provider-broker.test.cjs", "tests/osint-store.test.ts",
    "tests/voidcat-storage-budget-manager.test.ts", "tests/voidcat-job-manager.test.ts", "tests/osint-unit-tools.test.ts", "tests/osint-controlled-expansion.test.ts",
    "tests/hunter-seeker-source-registry.test.ts", "tests/hunter-seeker-frontend-integration.test.ts", "tests/osint-gate-nine-integration.test.ts", "tests/typography-floor.test.ts",
  ];
  for (const path of required) assert.ok(command.includes(path), `${path} must remain in the default suite`);
  assert.ok(packageJson.scripts["test:gate10"].includes("osint-gate-ten-acceptance.test.ts"));
});

test("acceptance and operator documentation cover configuration, safety, recovery, and every provider", () => {
  const acceptance = readFileSync(join(root, "docs", "osint", "OSINT_GATE_10_HARDENING_ACCEPTANCE.md"), "utf8"); const operator = readFileSync(join(root, "docs", "osint", "OSINT_OPERATOR_GUIDE.md"), "utf8");
  for (const heading of ["Regression suite", "Provider fixtures", "Disposable databases", "Cancellation", "Rate limits and cache", "Network and malformed responses", "Secret-leak prevention", "Unsupported claims", "Controlled expansion", "Hunter-Seeker recovery", "Screen-aware interface"]) assert.match(acceptance, new RegExp(heading, "i"));
  for (const provider of LIVE_OSINT_PROVIDER_DESCRIPTORS) assert.match(operator, new RegExp(provider.id.replace("-", "[- ]"), "i"));
  for (const topic of ["Configure providers", "Run an investigation", "Authorization", "Budgets", "Cancel", "Cache", "Export", "Troubleshooting", "Data and cleanup"]) assert.match(operator, new RegExp(topic, "i"));
});

test("Gate 9 and Hunter-Seeker layouts retain responsive recovery contracts", () => {
  const css = readFileSync(join(root, "app", "globals.css"), "utf8"); const investigationUi = readFileSync(join(root, "app", "OsintInvestigationPanel.tsx"), "utf8"); const boundary = readFileSync(join(root, "app", "HunterErrorBoundary.tsx"), "utf8");
  const gateNine = css.slice(css.indexOf("Gate 9:")); assert.match(gateNine, /@media\(max-width:1200px\)/); assert.match(gateNine, /@media\(max-width:800px\)/); assert.match(gateNine, /overflow-y:auto/); assert.match(gateNine, /min-height:0/);
  assert.match(investigationUi, /CANCEL/); assert.match(investigationUi, /INCOMPLETE FINDINGS/); assert.match(boundary, /RESTORE BOARD|RETRY|RETURN/);
});
