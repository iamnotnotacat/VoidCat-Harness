/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("source enabled state, cadence, and local budget survive a backend restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "voidcat-hunter-settings-"));
  const databaseModule = pathToFileURL(join(process.cwd(), "build", "voidcat-database.ts")).href;
  const nodeArguments = ["--experimental-strip-types", "--input-type=module", "--eval"];
  try {
    execFileSync(process.execPath, [...nodeArguments, `import { saveSettings } from ${JSON.stringify(databaseModule)}; saveSettings({ hunterSourceSettings: { "test.seismic": { enabled: false, pollCadenceMs: 720000, requestBudgetPercent: 40 }, "adsb.lol.military": { enabled: true, pollCadenceMs: 120000, requestBudgetPercent: 100 } }, hunterWorkspace: { explorerCollapsed: true, explorerWidth: 410, sourcePreferences: { "adsb.lol": { enabled: true, layerVisible: false, opacity: 0.6 } } }, hunterHistory: { enabled: true, retentionDays: 180, selectedLibraryIds: ["123e4567-e89b-12d3-a456-426614174000"], includeUploads: true } });`], { cwd: directory });
    const serialized = execFileSync(process.execPath, [...nodeArguments, `import { getSettings } from ${JSON.stringify(databaseModule)}; const settings = getSettings(); process.stdout.write(JSON.stringify({ sources: settings.hunterSourceSettings, history: settings.hunterHistory, workspace: { version: settings.hunterWorkspace.version, explorerCollapsed: settings.hunterWorkspace.explorerCollapsed, explorerWidth: settings.hunterWorkspace.explorerWidth, aviation: settings.hunterWorkspace.sourcePreferences["adsb.lol"] } }));`], { cwd: directory, encoding: "utf8" });
    const parsed = JSON.parse(serialized); assert.deepEqual(parsed.sources, { "test.seismic": { enabled: false, pollCadenceMs: 720000, requestBudgetPercent: 40 }, "adsb.lol.military": { enabled: true, pollCadenceMs: 120000, requestBudgetPercent: 100 } }); assert.deepEqual(parsed.history, { enabled: true, retentionDays: 180, selectedLibraryIds: ["123e4567-e89b-12d3-a456-426614174000"], includeUploads: true }); assert.equal(parsed.workspace.version, 2); assert.equal(parsed.workspace.explorerCollapsed, true); assert.equal(parsed.workspace.explorerWidth, 410); assert.equal(parsed.workspace.aviation.enabled, true); assert.equal(parsed.workspace.aviation.layerVisible, false); assert.equal(parsed.workspace.aviation.opacity, .6);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
