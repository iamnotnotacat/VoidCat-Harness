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

test("desktop bridge and settings UI expose storage, targeted/full scans, progress, and cancellation", () => {
  const root = process.cwd(); const main = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf8"); const preload = fs.readFileSync(path.join(root, "desktop", "preload.cjs"), "utf8"); const panel = fs.readFileSync(path.join(root, "app", "AppSettingsPanel.tsx"), "utf8"); const backend = fs.readFileSync(path.join(root, "build", "voidcat-local-plugin.ts"), "utf8");
  for (const contract of ["models:choose-primary-folder", "models:choose-scan-folder", "models:scan", "models:cancel-scan"]) assert.match(main, new RegExp(contract));
  assert.match(preload, /choosePrimaryFolder/); assert.match(preload, /cancelScan/); assert.match(panel, /FULL SYSTEM SCAN/); assert.match(panel, /SCAN PRIMARY/); assert.match(panel, /ADD TARGET FOLDER/); assert.match(panel, /aria-live="polite"/); assert.match(backend, /resolveLoadableModelKey/); assert.match(backend, /--symbolic-link/); assert.match(backend, /--hard-link/);
  const unitSettings = fs.readFileSync(path.join(root, "app", "UnitSettingsPanel.tsx"), "utf8"); assert.match(unitSettings, /CHOOSE GGUF/); assert.match(unitSettings, /bundle\.files/); assert.match(backend, /modelStorageFolder/); assert.match(backend, /model-download-catalog\.json/); assert.match(backend, /100 \* 1024 \*\* 3/); assert.match(backend, /selected model folder must retain 10 GB/i);
});
