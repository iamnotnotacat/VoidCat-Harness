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

const root = process.cwd();
const ui = readFileSync(join(root, "app", "OsintInvestigationPanel.tsx"), "utf8");
const providerUi = readFileSync(join(root, "app", "OsintProviderPanel.tsx"), "utf8");
const backend = readFileSync(join(root, "build", "voidcat-local-plugin.ts"), "utf8");
const workspace = readFileSync(join(root, "build", "osint", "osint-investigation-workspace.ts"), "utf8");
const store = readFileSync(join(root, "build", "osint", "osint-store.ts"), "utf8");
const css = readFileSync(join(root, "app", "globals.css"), "utf8");
const commandTools = readFileSync(join(root, "app", "command-tool-definitions.ts"), "utf8");
const unitTools = readFileSync(join(root, "build", "osint", "osint-unit-tools.ts"), "utf8");
const intelligenceDocumentation = readFileSync(join(root, "docs", "osint", "INTELLIGENCE_MODEL.md"), "utf8");

test("OSINT exposes separate investigation and provider-setup tabs", () => { assert.match(providerUi, /INVESTIGATIONS/); assert.match(providerUi, /PROVIDERS & API SETUP/); assert.match(providerUi, /OsintInvestigationPanel/); });

test("investigation builder requires budget and plan preview before execution", () => {
  for (const label of ["INVESTIGATION TYPE", "EXACT SEED", "AUTHORIZATION MODE", "OBJECTIVE", "PREVIEW BUDGET & PLAN", "START APPROVED PLAN"]) assert.match(ui, new RegExp(label));
  for (const field of ["maximumProviders", "maximumExternalCalls", "maximumRuntimeMs", "maximumEntities", "maximumEvidenceBytes", "maximumDiscoveryDepth"]) assert.match(ui, new RegExp(field));
  assert.match(workspace, /requestedProviderIds: normalized\.providerIds/); assert.doesNotMatch(ui, /SELECT PROVIDER FOR PLAN/);
});

test("job progress, cancellation, history, and persistent detail routes are complete", () => {
  for (const route of ["/api/osint/investigations/preview", "/api/osint/investigations/start", "/api/osint/investigations/jobs", "/api/osint/investigations/jobs/events", "/api/osint/investigations"]) assert.ok(backend.includes(route));
  assert.match(workspace, /module: "osint-investigation-ui"/); assert.match(workspace, /context\.externalCall/); assert.match(workspace, /saveInvestigationBundle/); assert.match(backend, /cancelModule\("osint-investigation-ui"\)/); assert.match(ui, />CANCEL</); assert.match(store, /listInvestigations/); assert.match(store, /getInvestigationView/);
});

test("the review surface includes graph, claims, contradictions, confidence, evidence attribution, and cache age", () => {
  for (const label of ["ENTITY / RELATIONSHIP GRAPH", "CLAIMS / CONFIDENCE", "EXPLICIT CONTRADICTION", "EVIDENCE INDEX", "ATTRIBUTION", "AGE"]) assert.ok(ui.includes(label));
  assert.match(ui, /<svg/); assert.match(ui, /detail\.relationships/); assert.match(ui, /conclusion\?\.confidence\.explanation/); assert.match(store, /cache_age_ms/); assert.match(store, /attribution_json/); assert.match(css, /osint-entity-graph/);
});

test("candidate approval cannot start expansion and reports are exportable", () => {
  assert.match(ui, /APPROVE CANDIDATE/); assert.match(ui, /NO AUTOMATIC EXPANSION/); assert.match(store, /providerRequestStarted: false/); assert.match(store, /automaticExpansion: false/); assert.match(backend, /\/report\$/); assert.match(ui, /EXPORT CITED REPORT/); assert.match(workspace, /\[EV:\$\{item\.id\}\]/);
});

test("sensitive and incomplete findings receive explicit warnings", () => {
  assert.match(ui, /SENSITIVE OR RESTRICTED FINDINGS/); assert.match(ui, /INCOMPLETE FINDINGS/); assert.match(ui, /ABSENCE OF EVIDENCE IS NOT EVIDENCE OF ABSENCE/); assert.match(workspace, /Sensitive exposure results require exact-target authorization/); assert.match(workspace, /Passive results may be incomplete, stale, cached, or unavailable/);
});

test("Gate 9 typography and layout stay screen-aware", () => {
  const gateNine = css.slice(css.indexOf("Gate 9:")); assert.ok(gateNine.length > 2_000); assert.doesNotMatch(gateNine, /font-size:\s*(?:[0-9]|[0-9]\.[0-9]+)px/); assert.match(gateNine, /@media\(max-width:1200px\)/); assert.match(gateNine, /@media\(max-width:800px\)/); assert.match(gateNine, /min-height:0/); assert.match(gateNine, /overflow-y:auto/);
});

test("persistent intelligence detail exposes a temporal ledger, explicit gaps, calibration, and archived evidence", () => {
  for (const label of ["INVESTIGATION SCOPE CONTRACT", "PROHIBITED ACTIONS", "TEMPORAL INTELLIGENCE LEDGER", "OBSERVATIONS ≠ CLAIMS ≠ HYPOTHESES", "UNANSWERED QUESTIONS / INFORMATION GAPS", "BRIER SCORE", "INSPECT ARCHIVE", "ARCHIVED PROVIDER RESPONSE", "REVERSIBLE ENTITY RESOLUTION", "SCORABLE FORECASTS"]) assert.ok(ui.includes(label), `${label} is missing`);
  assert.match(backend, /getEvidenceDetail/);
  assert.match(backend, /\/hypotheses\$/);
  assert.match(backend, /\/forecasts\$/);
  assert.ok(backend.includes("resolutions"));
  assert.match(css, /osint-intelligence-timeline/);
  assert.match(css, /osint-calibration-grid/);
});

test("each analytical UNIT capability is independently selectable and cannot execute a collection plan", () => {
  const tools = ["search-entities", "get-entity-profile", "get-entity-timeline", "find-paths-between-entities", "compare-entities", "retrieve-supporting-evidence", "retrieve-contradictions", "identify-information-gaps", "run-pattern-detector", "search-geospatial-observations", "run-quality-checks", "build-source-lineage", "create-hypothesis", "test-hypothesis", "generate-collection-plan", "calculate-confidence"];
  for (const tool of tools) {
    assert.ok(commandTools.includes(`osint-unit.${tool}`), `${tool} is not independently selectable`);
    assert.ok(unitTools.includes(`osint-unit.${tool}`), `${tool} is not registered`);
  }
  assert.match(unitTools, /none were executed/);
  assert.match(unitTools, /automaticExecution: false/);
  assert.doesNotMatch(unitTools, /SELECT \*|rawQuery|executeSql/i);
});

test("the operator contract documents the evidence-first architecture and safety boundary", () => {
  for (const concept of ["atomic normalized observations", "SQLite database is the durable source of truth", "POSSIBLY_SAME_AS", "MAGI analytical council", "Brier score", "no scanning, exploitation, credential guessing"]) assert.ok(intelligenceDocumentation.includes(concept), `${concept} is undocumented`);
});
