import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const panel = readFileSync(join(root, "app/HunterSeekerPanel.tsx"), "utf8");
const setup = readFileSync(join(root, "app/HunterSeekerSetupGuide.tsx"), "utf8");
const boundary = readFileSync(join(root, "app/HunterErrorBoundary.tsx"), "utf8");
const backend = readFileSync(join(root, "build/voidcat-local-plugin.ts"), "utf8");
const stageFive = readFileSync(join(root, "app/HunterStageFivePanel.tsx"), "utf8");
const map = readFileSync(join(root, "app/HunterSeekerMap.tsx"), "utf8");
const consoleSource = readFileSync(join(root, "app/VoidCatConsole.tsx"), "utf8");

test("frontend source controls wire toggles, cadence, request budgets, refresh, and cached restoration", () => {
  assert.match(panel, /aria-pressed=\{enabled\}/);
  assert.match(panel, /requestBudgetPercent/);
  assert.match(panel, /onPointerUp=.*commitPullRate/);
  assert.match(panel, /runAction\("refresh"\)/);
  assert.match(panel, /setSnapshot\(data\)/);
  assert.match(setup, /Re-enabling inside the selected cadence restores the last valid snapshot/i);
});

test("frontend exposes source failure, freshness, empty-state, and map recovery contracts", () => {
  for (const state of ["LIVE", "CACHED", "STALE", "DEGRADED"]) assert.match(panel, new RegExp(state));
  assert.match(panel, /source\.health\.message/);
  assert.match(panel, /NO LIVE CONTACTS/);
  assert.match(boundary, /componentDidCatch|componentDidUpdate/);
  assert.match(boundary, /RETRY|RETURN/i);
});

test("onboarding genuinely skips, summarizes current state, and exposes the full credential lifecycle", () => {
  assert.match(setup, /SKIP FOR NOW/);
  assert.match(setup, /currentStep === 4 \? void advance\(\) : void onSkip\(\)/);
  assert.match(panel, /onSkip=\{async \(\) =>/);
  assert.match(panel, /hunterSetupCompleted: true, hunterSetupStep: setupStep/);
  assert.match(panel, /setSetupStep\(0\); setShowSetup\(true\)/);
  assert.match(setup, /activePublicSources/);
  assert.match(setup, /REPLACE KEY \/ REGION/);
  assert.match(setup, /RETEST SAVED KEY/);
  assert.match(setup, /REMOVE SAVED KEY/);
});

test("managed-job status is pushed to the UI through a live subscription with polling recovery", () => {
  assert.match(panel, /new EventSource\("\/api\/hunter-seeker\/jobs\/events"\)/);
  assert.match(panel, /events\.onmessage = refresh/);
  assert.match(panel, /events\?\.close\(\)/);
  assert.match(backend, /"\/api\/hunter-seeker\/jobs\/events"/);
  assert.match(backend, /voidcatJobManager\.subscribe/);
  assert.match(backend, /text\/event-stream/);
});

test("history is explicit opt-in, visually distinct, natural-language searchable, and library-selectable", () => {
  assert.match(panel, /ENABLE RECORDING/);
  assert.match(panel, /PAUSE RECORDING/);
  assert.match(panel, /HISTORICAL QUESTION/);
  assert.match(panel, /HISTORICAL data is opt-in/);
  assert.match(panel, /selectedLibraryIds/);
  assert.match(panel, /sourceObservationIds/);
  assert.match(backend, /\/api\/hunter-seeker\/history\/search/);
  assert.match(backend, /rawPositionsIndexed: false/);
});

test("Stage 5 exposes persistent targeting, protected triggers, health history, and offline replay controls", () => {
  for (const value of ["AIRCRAFT ICAO", "AIRCRAFT CALLSIGN", "AIRCRAFT TAIL NUMBER", "VESSEL MMSI", "SATELLITE NORAD ID", "GEOGRAPHIC AREA", "EXPORT JSON", "IMPORT JSON"]) assert.match(stageFive, new RegExp(value));
  assert.match(consoleSource, /new EventSource\("\/api\/hunter-seeker\/triggers\/events"\)/);
  assert.match(consoleSource, /emergency-squawk/);
  assert.match(stageFive, /ERROR RATE/); assert.match(stageFive, /RECORDS \/ HR/); assert.match(stageFive, /SILENT ZERO/); assert.match(stageFive, /AI ELIGIBLE/);
  assert.match(stageFive, /30-DAY HEALTH HISTORY/); assert.match(stageFive, /healthTimeline/); assert.match(stageFive, /ALL SOURCES/);
  assert.match(stageFive, /RECORD LIVE WINDOW/); assert.match(stageFive, /PLAY OFFLINE/); assert.match(stageFive, /RETURN TO LIVE/);
  assert.match(backend, /protectedObservationIds/); assert.match(backend, /protectObservation\(observationId, "trigger"\)/);
});

test("map right-click actions require an operator gesture and support web research, UNIT analysis, and region watches", () => {
  assert.match(map, /map\.on\("contextmenu"/); assert.match(map, /queryRenderedFeatures/); assert.match(map, /preventDefault/);
  for (const action of ["SEARCH WEB", "PULL INFO / RESEARCH", "ANALYZE WITH ACTIVE UNIT", "WATCH CONTACT", "WATCH 25 KM REGION"]) assert.match(panel, new RegExp(action));
  assert.match(panel, /\/api\/web\/discover/); assert.match(panel, /\/api\/web\/search/); assert.match(panel, /onAnalyzeObservation/);
});
