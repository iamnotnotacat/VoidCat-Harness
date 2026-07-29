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
const desktopMain = readFileSync(join(root, "desktop/main.cjs"), "utf8");
const preload = readFileSync(join(root, "desktop/preload.cjs"), "utf8");
const backend = readFileSync(join(root, "build/voidcat-local-plugin.ts"), "utf8");
const liveProviders = readFileSync(join(root, "build/osint/live-provider-adapters.ts"), "utf8");
const consoleSource = readFileSync(join(root, "app/VoidCatConsole.tsx"), "utf8");
const providerPanel = readFileSync(join(root, "app/OsintProviderPanel.tsx"), "utf8");
const hunterPanel = readFileSync(join(root, "app/HunterSeekerPanel.tsx"), "utf8");
const hunterMap = readFileSync(join(root, "app/HunterSeekerMap.tsx"), "utf8");

test("Gate 4 provider calls cross only the authenticated Electron broker", () => {
  assert.match(desktopMain, /startOsintProviderBroker/);
  assert.match(desktopMain, /randomUUID/);
  assert.match(preload, /osint:\s*\{/);
  assert.match(backend, /VOIDCAT_OSINT_BROKER_PORT/);
  assert.match(backend, /x-voidcat-desktop-token/);
  assert.match(backend, /\/api\/osint\/providers\/query/);
  assert.match(backend, /ensureOsintStore/);
  assert.match(backend, /putProviderCache/);
  assert.match(backend, /putRateLimitState/);
  assert.match(backend, /appendInvocationLog/);
  assert.match(backend, /appendDecisionLog/);
  assert.match(backend, /\/api\/osint\/store\/status/);
  assert.doesNotMatch(backend, /hibp-api-key/);
  assert.doesNotMatch(backend, /api\.shodan\.io/);
});

test("provider status screen exposes capability, cache, rate, credential, and HIBP approval controls", () => {
  assert.match(consoleSource, /OSINT PROVIDERS/);
  assert.match(consoleSource, /OsintProviderPanel/);
  for (const label of ["CAPABILITIES", "CACHE", "RATE", "AUTH", "SAVE PROTECTED VALUE", "TEST LIVE", "REMOVE"]) assert.match(providerPanel, new RegExp(label));
  assert.match(providerPanel, /I AM AUTHORIZED TO CHECK THIS EXACT TARGET/);
  assert.match(providerPanel, /NO DISCOVERED EMAIL EXPANSION/);
  assert.match(providerPanel, /HUNTER FORWARDING BLOCKED/);
  assert.match(providerPanel, /STORE V/);
  assert.match(providerPanel, /storeStatus\?\.consistency\.valid/);
  for (const label of ["CONNECTION GUIDE", "SETUP REQUIRED", "TEST LIVE"]) assert.match(providerPanel, new RegExp(label));
  for (const label of ["GET SHODAN API KEY", "CREATE CENSYS TOKEN", "GET HIBP API KEY", "SET UP SEARXNG"]) assert.match(liveProviders, new RegExp(label));
  assert.match(providerPanel, /selected\.setup\.acquisitionUrl/);
  assert.match(providerPanel, /target="_blank" rel="noreferrer"/);
  assert.match(desktopMain, /setWindowOpenHandler/);
  assert.match(desktopMain, /shell\.openExternal/);
});

test("DeFlock is a toggleable worldwide daily memory layer with exact source links", () => {
  assert.match(hunterPanel, /WORLD REGION INDEX/);
  assert.match(hunterPanel, /onDeflockRegionSelect/);
  assert.match(hunterPanel, /OSM CAMERA RECORD/);
  assert.match(hunterMap, /hunter-alpr-camera-points/);
  assert.match(hunterMap, /hunter-deflock-region-points/);
  assert.doesNotMatch(hunterMap, /onViewportChange/);
  assert.match(backend, /\/api\/hunter-seeker\/deflock\/viewport/);
  assert.match(backend, /\/api\/hunter-seeker\/deflock\/region/);
});

test("live provider failures retain actionable HTTP semantics", () => {
  assert.match(backend, /is not configured\\\.\$\/i\.test\(error\.message\)\) return 409/);
  assert.match(backend, /request guard is active until/);
  assert.match(backend, /return 429/);
  assert.match(backend, /requires fresh exact-target exposure authorization/);
  assert.match(backend, /return 403/);
  assert.match(backend, /response exceeded the 2 MB safety limit/);
  assert.match(backend, /return 502/);
});
