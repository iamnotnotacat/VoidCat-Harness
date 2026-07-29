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
    execFileSync(process.execPath, [...nodeArguments, `import { saveSettings } from ${JSON.stringify(databaseModule)}; saveSettings({ hunterSourceSettings: { "test.seismic": { enabled: false, pollCadenceMs: 720000, requestBudgetPercent: 40 } }, hunterHistory: { enabled: true, retentionDays: 180, selectedLibraryIds: ["123e4567-e89b-12d3-a456-426614174000"], includeUploads: true } });`], { cwd: directory });
    const serialized = execFileSync(process.execPath, [...nodeArguments, `import { getSettings } from ${JSON.stringify(databaseModule)}; process.stdout.write(JSON.stringify({ sources: getSettings().hunterSourceSettings, history: getSettings().hunterHistory }));`], { cwd: directory, encoding: "utf8" });
    assert.deepEqual(JSON.parse(serialized), { sources: { "test.seismic": { enabled: false, pollCadenceMs: 720000, requestBudgetPercent: 40 } }, history: { enabled: true, retentionDays: 180, selectedLibraryIds: ["123e4567-e89b-12d3-a456-426614174000"], includeUploads: true } });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
