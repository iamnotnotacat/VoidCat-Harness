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
const panel = readFileSync(join(root, "app/HunterSeekerPanel.tsx"), "utf8");
const setup = readFileSync(join(root, "app/HunterSeekerSetupGuide.tsx"), "utf8");
const boundary = readFileSync(join(root, "app/HunterErrorBoundary.tsx"), "utf8");
const backend = readFileSync(join(root, "build/voidcat-local-plugin.ts"), "utf8");
const stageFive = readFileSync(join(root, "app/HunterStageFivePanel.tsx"), "utf8");
const map = readFileSync(join(root, "app/HunterSeekerMap.tsx"), "utf8");
const consoleSource = readFileSync(join(root, "app/VoidCatConsole.tsx"), "utf8");
const styles = readFileSync(join(root, "app/globals.css"), "utf8");
const explorer = readFileSync(join(root, "app/HunterSourceExplorer.tsx"), "utf8");
const sourceSettings = readFileSync(join(root, "app/HunterSourceSettingsDialog.tsx"), "utf8");
const layerControl = readFileSync(join(root, "app/HunterLayerControl.tsx"), "utf8");

test("frontend source controls wire toggles, cadence, request budgets, refresh, and cached restoration", () => {
  assert.match(explorer, /TriStateCheckbox/);
  assert.match(explorer, /ENABLE MATCHES/);
  assert.match(explorer, /REFRESH ACTIVE/);
  assert.match(sourceSettings, /requestBudgetPercent/);
  assert.match(sourceSettings, /Provider minimum/);
  assert.match(panel, /refreshWorkspaceSources/);
  assert.match(panel, /setSnapshot\(data\)/);
  assert.match(setup, /Re-enabling inside the selected cadence restores the last valid snapshot/i);
});

test("frontend exposes source failure, freshness, empty-state, and map recovery contracts", () => {
  for (const state of ["LIVE", "CACHED", "STALE", "DEGRADED"]) assert.match(panel, new RegExp(state));
  assert.match(panel, /health\.message/);
  assert.match(panel, /NO LIVE CONTACTS/);
  assert.match(boundary, /componentDidCatch|componentDidUpdate/);
  assert.match(boundary, /RETRY|RETURN/i);
});

test("geospatial workspace gives Source Explorer, map, and intelligence panel explicit responsive columns", () => {
  assert.match(styles, /\.hunter-board\{[^}]*grid-template-rows:repeat\(12,minmax\(0,1fr\)\)/);
  assert.match(styles, /\.hunter-source-explorer\{[^}]*grid-column:1;grid-row:1\/13/);
  assert.match(styles, /\.hunter-map-shell\{grid-column:2;grid-row:1\/9/);
  assert.match(styles, /\.hunter-event-deck\{grid-column:3;grid-row:1\/13/);
  assert.match(explorer, /explorerCollapsed/);
  assert.match(explorer, /hunter-explorer-resize/);
  assert.match(styles, /content-visibility:auto/);
});

test("source retrieval, map visibility, credentials, saved views, and map layers remain separate controls", () => {
  assert.match(explorer, /retrieval/);
  assert.match(explorer, /without changing retrieval/);
  assert.match(explorer, /SAVE VIEW/);
  assert.match(explorer, /IMPORT/);
  assert.match(layerControl, /LAYER MANAGER/);
  assert.match(layerControl, /OPACITY/);
  assert.match(layerControl, /onZoom/);
  assert.match(sourceSettings, /VALUE NEVER RETURNED TO UI/);
  assert.match(sourceSettings, /TEST CONNECTION/);
  assert.match(sourceSettings, /REMOVE/);
  assert.match(panel, /displayBySource=\{mapDisplayBySource\}/);
  assert.match(panel, /mapDataSearch/);
  assert.match(explorer, /LIVE SOURCE MATRIX/);
  assert.match(explorer, /INTEGRATED CATALOG/);
  assert.match(explorer, /QUERY SCOPE REQUIRED/);
  assert.match(panel, /BOUNDED QUERY REQUIRED/);
  assert.match(panel, /workspaceDefinitionBySourceId/);
  assert.match(panel, /requiresInitialQuery/);
  assert.match(panel, /completeDefinitionQuery/);
  assert.match(panel, /visibleMapOverlays/);
  assert.match(panel, /hunter-query-results-dialog/);
  assert.match(panel, /automaticQueryRefreshInFlight/);
  assert.match(panel, /requestBudgetPercent/);
  assert.match(sourceSettings, /draft\.automaticRefresh/);
  assert.match(styles, /\.hunter-query-results-dialog/);
});

test("every primary screen consumes the full desktop content area without clipping scrollbars", () => {
  assert.match(styles, /\.console \{[^}]*padding:0;/);
  assert.match(styles, /\.desktop-titlebar\{[^}]*margin:0;/);
  assert.match(styles, /\.command-grid>:not\(\.rail\):not\(\.inspector\)\{[^}]*padding:0;[^}]*scrollbar-gutter:stable/);
  assert.doesNotMatch(styles, /\.console:has\(\.command-grid\.view-hunter\)/);
  assert.match(styles, /\.hunter-panel\{[^}]*scrollbar-gutter:stable/);
  assert.match(styles, /\.hunter-history-console\{[^}]*margin:6px 0 0/);
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
  assert.ok(panel.lastIndexOf("hunter-history-console") > panel.indexOf("hunter-board"), "history controls must render after the live board");
  assert.match(panel, /aria-expanded=\{historyExpanded\}/);
  assert.match(panel, /setHistoryExpanded\(true\)/);
  assert.match(styles, /\.hunter-history-console\{[^}]*flex:0 0 auto[^}]*grid-template-rows:40px auto[^}]*min-height:40px/);
  assert.match(styles, /\.hunter-history-controls\{[^}]*overflow/);
  assert.match(styles, /\.hunter-history-expanded\{[^}]*overflow-y:auto/);
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

test("DeFlock is an operator-controlled daily worldwide memory layer with a dedicated camera marker", () => {
  assert.match(panel, /DEFLOCK_ALPR_SOURCE_ID/);
  assert.match(panel, /lightweight worldwide hubs/);
  assert.match(panel, /onDeflockRegionSelect/);
  assert.match(panel, /\/api\/hunter-seeker\/deflock\/region/);
  assert.match(map, /hunter-deflock-region-points/);
  assert.match(sourceSettings, /Provider minimum/);
  assert.match(panel, /onViewportChange=\{setMapViewport\}/);
  assert.match(map, /hunter-alpr-camera-points/);
  assert.match(map, /createMapIcon\("alpr-camera"/);
  assert.match(map, /map\.on\("moveend", publishViewport\)/);
  assert.doesNotMatch(map, /moveend.*setDeflockViewport/);
});
