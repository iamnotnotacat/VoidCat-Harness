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
