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
const backend = readFileSync(join(root, "build", "voidcat-local-plugin.ts"), "utf8");
const hunterPanel = readFileSync(join(root, "app", "HunterSeekerPanel.tsx"), "utf8");
const providerPanel = readFileSync(join(root, "app", "OsintProviderPanel.tsx"), "utf8");
const consoleSource = readFileSync(join(root, "app", "VoidCatConsole.tsx"), "utf8");
const adapters = readFileSync(join(root, "build", "osint", "live-provider-adapters.ts"), "utf8");

test("Hunter contact and map-region actions create drafts without starting a provider", () => {
  assert.match(hunterPanel, /INVESTIGATE IN OSINT/);
  assert.match(hunterPanel, /\/api\/osint\/hunter\/intake/);
  assert.match(hunterPanel, /observationId: observation\.observationId, observation/);
  assert.match(hunterPanel, /latitude: target\.latitude, longitude: target\.longitude, radiusKm: 25/);
  assert.match(consoleSource, /onInvestigateOsint=\{\(draft\) => \{ setHunterOsintDraft\(draft\); setView\("osint"\); \}\}/);
  assert.match(providerPanel, /AWAITING PROVIDER SELECTION/);
  assert.match(providerPanel, /DRAFT ONLY \/\/ NO PROVIDER REQUEST \/\/ NO WATCHLIST \/\/ NO TRIGGER/);
  const intake = backend.slice(backend.indexOf("async function createHunterOsintDraft"), backend.indexOf("function submitLiveOsintCandidate"));
  assert.doesNotMatch(intake, /runLiveProviderQuery|osintBrokerRequest|addWatchlist|evaluate\(/);
});

test("the backend preserves the original observation contract and accepts a bounded volatile region", () => {
  assert.match(backend, /createHunterOsintInvestigationDraft\(\{ observation \}/);
  assert.match(backend, /observation\.observationId !== observationId/);
  assert.match(backend, /hunterRegionAroundPoint\(latitude, longitude, radiusKm\)/);
  assert.match(backend, /exactGeographicBounds\(target\)/);
  assert.match(backend, /setDeflockViewport\(\{ \.\.\.bounds, zoom: 10 \}, \{ refresh: true \}\)/);
  assert.match(backend, /OSINT_HUNTER_HANDOFF_TTL_MS = 30 \* 60_000/);
  assert.match(backend, /OSINT_HUNTER_HANDOFF_LIMIT = 100/);
});

test("OSINT can submit one named candidate to a review-only Hunter inbox", () => {
  assert.match(providerPanel, /SUBMIT CANDIDATE TO HUNTER/);
  assert.match(providerPanel, /investigationId: queryResult\.investigationId, leadId/);
  assert.match(backend, /source\.leads\.find\(\(item\) => item\.id === leadId\)/);
  assert.match(backend, /submitOsintCandidateLeadToHunter/);
  assert.match(hunterPanel, /OSINT CANDIDATE INBOX/);
  assert.match(hunterPanel, /NO WATCHLIST \/\/ NO TRIGGER \/\/ NO PROVIDER REQUEST/);
  for (const route of ["/api/osint/hunter/candidates", "/api/hunter-seeker/osint-candidates"]) assert.match(backend, new RegExp(route.replaceAll("/", "\\/")));
  const submit = backend.slice(backend.indexOf("function submitLiveOsintCandidate"), backend.indexOf("const osintUnitToolRuntime"));
  assert.doesNotMatch(submit, /addWatchlist|createTrigger|runLiveProviderQuery|osintBrokerRequest|enqueueHistoricalObservations|protectObservation/);
});

test("sensitive HIBP evidence cannot enter the Hunter candidate handoff", () => {
  assert.match(backend, /if \(providerId === "hibp" \|\| !leads\.length\) return/);
  assert.match(providerPanel, /hunterForwarding === "blocked-pending-approval"/);
});

test("an explicitly prepared Hunter seed has passive provider coverage without automatic execution", () => {
  for (const seedType of ["aircraft", "vessel", "satellite", "event", "geographic-area", "unknown"]) assert.match(adapters, new RegExp(`"${seedType}"`));
  assert.match(adapters, /explicitly submitted Hunter-Seeker identifiers and regions/);
  assert.match(adapters, /Passive search result submitted as a candidate only/);
});
