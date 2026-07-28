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
    execFileSync(process.execPath, [...nodeArguments, `import { saveSettings } from ${JSON.stringify(databaseModule)}; saveSettings({ hunterSourceSettings: { "test.seismic": { enabled: false, pollCadenceMs: 720000, requestBudgetPercent: 40 } } });`], { cwd: directory });
    const serialized = execFileSync(process.execPath, [...nodeArguments, `import { getSettings } from ${JSON.stringify(databaseModule)}; process.stdout.write(JSON.stringify(getSettings().hunterSourceSettings));`], { cwd: directory, encoding: "utf8" });
    assert.deepEqual(JSON.parse(serialized), { "test.seismic": { enabled: false, pollCadenceMs: 720000, requestBudgetPercent: 40 } });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
