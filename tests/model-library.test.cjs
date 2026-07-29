/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ModelLibraryManager, compatibleModelFile, inside } = require("../desktop/model-library.cjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voidcat-model-library-test-"));
  const runtimeDirectory = path.join(root, ".voidcat"); const homeDirectory = path.join(root, "home"); const models = path.join(root, "models");
  fs.mkdirSync(models, { recursive: true }); fs.mkdirSync(homeDirectory, { recursive: true });
  return { root, models, manager: new ModelLibraryManager({ runtimeDirectory, homeDirectory, limits: { maximumDurationMs: 5_000 } }) };
}

test("model folder settings persist and targeted scans index only compatible GGUF roots", async (context) => {
  const { root, models, manager } = fixture(); context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(models, "unit-q4_k_m.gguf"), Buffer.alloc(70 * 1024));
  fs.writeFileSync(path.join(models, "notes.txt"), Buffer.alloc(70 * 1024));
  fs.writeFileSync(path.join(models, "split-00002-of-00002.gguf"), Buffer.alloc(70 * 1024));
  manager.setPrimaryFolder(models); const result = await manager.scan({ mode: "targeted", root: models });
  assert.equal(result.scan.active, false); assert.equal(result.scan.cancelled, false); assert.equal(result.compatibleModels, 1); assert.equal(result.primaryFolder, path.resolve(models));
  const catalog = JSON.parse(fs.readFileSync(manager.catalogPath, "utf8")); assert.equal(catalog.models.length, 1); assert.equal(path.basename(catalog.models[0].path), "unit-q4_k_m.gguf");
  const reopened = new ModelLibraryManager({ runtimeDirectory: path.dirname(manager.settingsPath), homeDirectory: path.join(root, "other-home") }); assert.equal(reopened.status().primaryFolder, path.resolve(models));
});

test("target validation, split-file filtering, and bounded cancellation fail safely", async (context) => {
  const { root, models, manager } = fixture(); context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(compatibleModelFile("model.gguf"), true); assert.equal(compatibleModelFile("model-00001-of-00003.gguf"), true); assert.equal(compatibleModelFile("model-00002-of-00003.gguf"), false); assert.equal(inside(root, models), true); assert.equal(inside(models, root), false);
  await assert.rejects(manager.scan({ mode: "targeted", root: path.join(root, "not-approved") }), /restricted/);
  manager.setPrimaryFolder(models); for (let index = 0; index < 80; index += 1) fs.mkdirSync(path.join(models, `folder-${index}`));
  const operation = manager.scan({ mode: "targeted", root: models }); assert.equal(manager.status().scan.active, true); assert.equal(manager.cancel(), true); const result = await operation; assert.equal(result.scan.cancelled, true); assert.equal(manager.status().scan.active, false);
});

test("startup restores the saved catalog and refreshes only registered model folders", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voidcat-model-library-startup-test-")); context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homeDirectory = path.join(root, "home"); const runtimeDirectory = path.join(root, ".voidcat"); const currentLmStudio = path.join(homeDirectory, ".lmstudio", "models"); const extraModels = path.join(root, "extra-models");
  fs.mkdirSync(currentLmStudio, { recursive: true }); fs.mkdirSync(extraModels, { recursive: true });
  fs.writeFileSync(path.join(currentLmStudio, "current-q4_k_m.gguf"), Buffer.alloc(70 * 1024)); fs.writeFileSync(path.join(extraModels, "registered-q5_k_m.gguf"), Buffer.alloc(70 * 1024));
  const manager = new ModelLibraryManager({ runtimeDirectory, homeDirectory, limits: { maximumDurationMs: 5_000 } });
  assert.equal(manager.status().primaryFolder, path.resolve(currentLmStudio)); manager.addScanFolder(extraModels);
  const refreshed = await manager.refreshRegisteredFolders(); assert.equal(refreshed.compatibleModels, 2); assert.equal(refreshed.scan.mode, "registered"); assert.deepEqual(refreshed.scan.roots.sort(), [path.resolve(currentLmStudio), path.resolve(extraModels)].sort());
  const reopened = new ModelLibraryManager({ runtimeDirectory, homeDirectory: path.join(root, "different-home") });
  assert.equal(reopened.status().compatibleModels, 2); assert.equal(reopened.status().primaryFolder, path.resolve(currentLmStudio));
});

test("desktop bridge and settings UI expose storage, targeted/full scans, progress, and cancellation", () => {
  const root = process.cwd(); const main = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf8"); const preload = fs.readFileSync(path.join(root, "desktop", "preload.cjs"), "utf8"); const panel = fs.readFileSync(path.join(root, "app", "AppSettingsPanel.tsx"), "utf8"); const backend = fs.readFileSync(path.join(root, "build", "voidcat-local-plugin.ts"), "utf8");
  for (const contract of ["models:choose-primary-folder", "models:choose-scan-folder", "models:scan", "models:cancel-scan"]) assert.match(main, new RegExp(contract));
  assert.match(preload, /choosePrimaryFolder/); assert.match(preload, /cancelScan/); assert.match(panel, /FULL SYSTEM SCAN/); assert.match(panel, /SCAN PRIMARY/); assert.match(panel, /ADD TARGET FOLDER/); assert.match(panel, /aria-live="polite"/); assert.match(backend, /resolveLoadableModelKey/); assert.match(backend, /--symbolic-link/); assert.match(backend, /--hard-link/);
  assert.match(main, /refreshRegisteredFolders/); const startupCatalog = backend.slice(backend.indexOf("async function scanModels()"), backend.indexOf("type ExternalModelRecord")); assert.doesNotMatch(startupCatalog, /lmsJson|\["ls", "--json"\]/); assert.match(startupCatalog, /readExternalModelCatalog/); const runtimeRoute = backend.match(/url === "\/api\/runtime\/status"[^\n]+/)?.[0] ?? ""; assert.match(runtimeRoute, /passiveRuntimeStatus/); assert.doesNotMatch(runtimeRoute, /runtimeStatus\(\)/); assert.match(main, /runtime-owned\.json/); assert.match(main, /!fs\.existsSync\(ownershipMarker\)/); assert.match(backend, /markVoidCatRuntimeOwned\("voidcat-core"\)/); assert.match(backend, /markVoidCatRuntimeOwned\("voidcat-embed"\)/);
  const unitSettings = fs.readFileSync(path.join(root, "app", "UnitSettingsPanel.tsx"), "utf8"); assert.match(unitSettings, /CHOOSE GGUF/); assert.match(unitSettings, /bundle\.files/); assert.match(backend, /modelStorageFolder/); assert.match(backend, /model-download-catalog\.json/); assert.match(backend, /100 \* 1024 \*\* 3/); assert.match(backend, /selected model folder must retain 10 GB/i);
});
