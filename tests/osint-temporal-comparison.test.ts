/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { compareInvestigations, type TemporalInvestigationView } from "../build/osint/temporal-comparison.ts";

function view(id: string, value: string, confidence: number, providerId: string): TemporalInvestigationView {
  return { investigation: { id, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: id === "baseline-001" ? "2026-08-01T00:00:00.000Z" : "2026-08-02T00:00:00.000Z", seed: { type: "domain", value: "example.com" } }, entities: [{ id: `${id}-entity`, type: "domain", displayName: "Example", identifiers: [{ type: "domain", normalizedValue: "example.com" }] }], claims: [{ id: `${id}-claim`, subjectEntityId: `${id}-entity`, predicate: "service", value, status: "supported", confidence, confidenceCategory: confidence >= .8 ? "high" : "medium", evidenceIds: [`${id}-evidence`] }], relationships: [], evidence: [{ id: `${id}-evidence`, providerId }] };
}

test("temporal comparison matches aliases and records claim, confidence, and provider changes", () => {
  const result = compareInvestigations(view("baseline-001", "old-service", .7, "searxng"), view("current-002", "new-service", .9, "shodan"));
  assert.equal(result.sameSeed, true); assert.equal(result.summary.changed, 1); assert.equal(result.changes[0].kind, "claim-changed"); assert.equal(result.changes[0].before, "old-service"); assert.equal(result.changes[0].after, "new-service");
  assert.deepEqual(result.summary.providersAdded, ["shodan"]); assert.deepEqual(result.summary.providersRemoved, ["searxng"]); assert.deepEqual(result.changes[0].baselineEvidenceIds, ["baseline-001-evidence"]); assert.deepEqual(result.changes[0].currentEvidenceIds, ["current-002-evidence"]);
});

test("temporal comparison keeps removals explicit and rejects self-comparison", () => {
  const baseline = view("baseline-001", "present", .8, "searxng"); const current = { ...view("current-002", "present", .8, "searxng"), claims: [] };
  const result = compareInvestigations(baseline, current); assert.equal(result.changes.some((item) => item.kind === "claim-removed"), true); assert.throws(() => compareInvestigations(baseline, baseline), /different investigations/);
});

test("synchronized cockpit and comparison API remain wired", async () => {
  const [ui, backend] = await Promise.all([readFile("app/OsintInvestigationPanel.tsx", "utf8"), readFile("build/voidcat-local-plugin.ts", "utf8")]);
  for (const text of ["SYNCHRONIZED ENTITY FOCUS", "ANALYZE WITH ACTIVE UNIT", "WHY THIS RECORD MATTERS", "COMPARE SNAPSHOTS", "approvedProviderIds", "ENTITY REVIEW QUEUE"]) assert.ok(ui.includes(text), text);
  assert.ok(backend.includes("/compare")); assert.ok(backend.includes("compareInvestigations")); assert.ok(backend.includes("/api/osint/resolution-queue"));
});
