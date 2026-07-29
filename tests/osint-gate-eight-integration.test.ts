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
const runtime = readFileSync(join(root, "build", "osint", "osint-unit-tools.ts"), "utf8");
const chat = readFileSync(join(root, "build", "osint", "osint-unit-chat-tools.ts"), "utf8");
const backend = readFileSync(join(root, "build", "voidcat-local-plugin.ts"), "utf8");
const consoleSource = readFileSync(join(root, "app", "VoidCatConsole.tsx"), "utf8");
const providerPanel = readFileSync(join(root, "app", "OsintProviderPanel.tsx"), "utf8");

test("Gate 8 exposes every requested high-level tool and no raw provider argument", () => {
  for (const name of ["investigate-domain", "investigate-ip", "investigate-username", "investigate-organization", "investigate-infrastructure", "authorized-exposure-check", "investigate-hunter-event", "search-passive-web-sources", "expand-entity", "retrieve-evidence", "explain-claim-or-confidence", "list-candidate-leads"]) assert.match(runtime, new RegExp(`osint-unit\\.${name}`));
  assert.doesNotMatch(runtime, /properties:\s*\{[^}]*providerId/);
  assert.match(runtime, /providerIds\.slice\(0, DEFAULT_INVESTIGATION_BUDGET\.maximumProviders\)/);
  assert.match(backend, /providerSelection: "server-policy-only"/);
});

test("every UNIT invocation crosses the shared registry and shared managed-job boundary", () => {
  assert.match(runtime, /this\.jobs\.start<OsintUnitToolResult>/);
  assert.match(runtime, /this\.registry\.invoke<OsintUnitToolResult>/);
  assert.match(runtime, /module: "osint-unit"/);
  assert.match(runtime, /maxExternalCalls: 3/);
  assert.match(runtime, /scope\.job\.externalCall/);
  assert.match(runtime, /executeProvider\(body, \{ investigationId, signal \}\)/);
  assert.match(backend, /voidcatJobManager\.cancelModule\("osint-unit"\)/);
});

test("selected context, exact citations, and unsupported-conclusion marking are enforced", () => {
  assert.match(backend, /proxyOsintToolChat\(body, request, response, selectedContextWindow\)/);
  assert.match(backend, /fitMessagesToContext\(messages, contextWindow, reservedOutputTokens\)/);
  assert.match(backend, /maximumOutputTokens: Math\.max\(2_000, Math\.floor\(contextWindow \/ 2\)\)/);
  assert.match(runtime, /boundResult\(result, options\.maximumOutputTokens\)/);
  assert.match(chat, /\[EV:\$\{id\}\]/);
  assert.match(chat, /UNSUPPORTED — NO EVIDENCE ID/);
  assert.match(backend, /markUncitedOsintConclusions/);
  assert.match(backend, /validateOsintCitations/);
  assert.match(backend, /citations\.citedEvidenceIds\.length > 0/);
  assert.match(backend, /if \(toolResults\.length\) return renderOsintEvidenceFallback\(toolResults\)/);
});

test("progress and hard cancellation are exposed in the command interface", () => {
  for (const route of ["/api/osint/unit/jobs", "/api/osint/unit/jobs/events"]) assert.match(backend, new RegExp(route.replaceAll("/", "\\/")));
  assert.match(consoleSource, /new EventSource\("\/api\/osint\/unit\/jobs\/events"\)/);
  assert.match(consoleSource, /Managed OSINT UNIT jobs/);
  assert.match(consoleSource, /cancelOsintJob/);
  assert.match(consoleSource, /CommandToolSelector/);
  assert.match(consoleSource, /enabledToolNames: loadedModel\?\.toolUse \? enabledToolNames : \[\]/);
  assert.match(backend, /requestedToolNames/);
  assert.match(backend, /requested\.has\(tool\.name\)/);
  assert.match(backend, /function that is disabled in the Command interface/);
  assert.match(backend, /response\.once\("close", \(\) => \{ if \(!responseFinished\) handle\.cancel\(\); \}\)/);
});

test("exposure authorization is one-time, exact-target, expiring, and impossible for the UNIT to mint", () => {
  assert.match(runtime, /expiresAt: new Date\(now \+ 5 \* 60_000\)/);
  assert.match(runtime, /this\.approvals\.delete\(`\$\{targetType\}:\$\{exactTarget\}`\)/);
  assert.match(runtime, /one-time operator authorization/);
  assert.doesNotMatch(runtime, /confirmed:\s*\{\s*type:/);
  assert.match(providerPanel, /AUTHORIZE NEXT UNIT CHECK/);
  assert.match(providerPanel, /THE UNIT CANNOT CREATE THIS APPROVAL/);
  assert.match(backend, /body\.confirmed !== true/);
});

test("candidate expansion stays unexecuted and arbitrary providers stay inaccessible", () => {
  assert.match(runtime, /evaluateControlledExpansion/);
  assert.match(runtime, /candidate-awaiting-operator-approval/);
  assert.match(runtime, /A UNIT cannot approve its own expansion/);
  const expandStart = runtime.indexOf("private expandEntity"); const retrieveStart = runtime.indexOf("private retrieveEvidence"); const expandBody = runtime.slice(expandStart, retrieveStart);
  assert.doesNotMatch(expandBody, /this\.callProvider|this\.executeProvider|\.externalCall\(/);
  assert.match(chat, /Never request, name, or choose a raw provider or API/);
});

test("model integration is explicitly constrained to a sub-7-GB test UNIT", () => {
  assert.match(consoleSource, /selected\.size/);
  assert.match(backend, /modelLane: "voidcat-core"/);
  assert.doesNotMatch(runtime, /loadModel|lms\.exe|\.lmstudio/);
});
