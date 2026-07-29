const fs = require("node:fs");
const path = require("node:path");

const SETTINGS_VERSION = 1;
const DEFAULT_LIMITS = Object.freeze({ maximumDirectories: 100_000, maximumFiles: 1_000_000, maximumModels: 5_000, maximumDurationMs: 15 * 60_000 });
const IGNORED_DIRECTORY_NAMES = new Set(["$recycle.bin", "system volume information", "windows", "program files", "program files (x86)", "node_modules", ".git"]);

function inside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function compatibleModelFile(name) {
  if (!name.toLowerCase().endsWith(".gguf")) return false;
  const shard = name.match(/-(\d{5})-of-\d{5}\.gguf$/i);
  return !shard || shard[1] === "00001";
}

class ModelLibraryManager {
  constructor({ runtimeDirectory, homeDirectory, limits = {} }) {
    this.runtimeDirectory = path.resolve(runtimeDirectory);
    this.homeDirectory = path.resolve(homeDirectory);
    this.settingsPath = path.join(this.runtimeDirectory, "model-library.json");
    this.catalogPath = path.join(this.runtimeDirectory, "model-library-catalog.json");
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.active = null;
    this.lastResult = null;
    fs.mkdirSync(this.runtimeDirectory, { recursive: true });
  }

  defaultSettings() {
    return { version: SETTINGS_VERSION, primaryFolder: path.join(this.homeDirectory, ".lmstudio", "hub", "models"), scanFolders: [] };
  }

  readSettings() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.settingsPath, "utf8"));
      const primaryFolder = path.isAbsolute(parsed.primaryFolder || "") ? path.resolve(parsed.primaryFolder) : this.defaultSettings().primaryFolder;
      const scanFolders = Array.isArray(parsed.scanFolders) ? [...new Set(parsed.scanFolders.filter((value) => typeof value === "string" && path.isAbsolute(value)).map((value) => path.resolve(value)))].slice(0, 32) : [];
      return { version: SETTINGS_VERSION, primaryFolder, scanFolders };
    } catch { return this.defaultSettings(); }
  }

  writeJson(target, value) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", flag: "wx" });
    try { fs.renameSync(temporary, target); }
    catch { fs.rmSync(target, { force: true }); fs.renameSync(temporary, target); }
  }

  saveSettings(settings) {
    this.writeJson(this.settingsPath, settings);
    return this.status();
  }

  setPrimaryFolder(folder) {
    const resolved = path.resolve(folder);
    fs.mkdirSync(resolved, { recursive: true });
    const stat = fs.statSync(resolved); if (!stat.isDirectory()) throw new Error("The selected model storage location is not a folder.");
    const settings = this.readSettings(); settings.primaryFolder = resolved;
    settings.scanFolders = settings.scanFolders.filter((value) => path.resolve(value) !== resolved);
    return this.saveSettings(settings);
  }

  addScanFolder(folder) {
    const resolved = path.resolve(folder); const stat = fs.statSync(resolved); if (!stat.isDirectory()) throw new Error("The selected scan target is not a folder.");
    const settings = this.readSettings(); if (resolved !== settings.primaryFolder) settings.scanFolders = [...new Set([...settings.scanFolders, resolved])].slice(0, 32);
    return this.saveSettings(settings);
  }

  removeScanFolder(folder) {
    const resolved = path.resolve(folder); const settings = this.readSettings(); settings.scanFolders = settings.scanFolders.filter((value) => path.resolve(value) !== resolved);
    return this.saveSettings(settings);
  }

  readCatalog() {
    try { const parsed = JSON.parse(fs.readFileSync(this.catalogPath, "utf8")); return Array.isArray(parsed.models) ? parsed : { version: 1, models: [] }; }
    catch { return { version: 1, models: [] }; }
  }

  status() {
    const settings = this.readSettings(); const catalog = this.readCatalog();
    return { ...settings, catalogPath: this.catalogPath, compatibleModels: catalog.models.length, scan: this.active ? { ...this.active.public } : { active: false, ...(this.lastResult || {}) } };
  }

  fullScanRoots() {
    const roots = [];
    for (let code = 65; code <= 90; code += 1) { const root = `${String.fromCharCode(code)}:\\`; try { if (fs.statSync(root).isDirectory()) roots.push(root); } catch { /* unavailable drive */ } }
    return roots;
  }

  async scan({ mode, root }) {
    if (this.active) throw new Error("A model discovery scan is already running.");
    const settings = this.readSettings();
    let roots;
    if (mode === "targeted") {
      const resolved = path.resolve(root || ""); const allowed = [settings.primaryFolder, ...settings.scanFolders].some((folder) => path.resolve(folder) === resolved);
      if (!allowed) throw new Error("Targeted scans are restricted to folders selected in App Settings.");
      roots = [resolved];
    } else if (mode === "full") roots = this.fullScanRoots();
    else throw new Error("Choose a targeted or full model scan.");
    if (!roots.length) throw new Error("No accessible local drives were found for the full scan.");

    const controller = new AbortController(); const startedAt = Date.now();
    const publicState = { active: true, mode, roots, currentPath: roots[0], directoriesScanned: 0, filesScanned: 0, modelsFound: 0, startedAt: new Date(startedAt).toISOString(), cancellable: true };
    this.active = { controller, public: publicState };
    const discovered = [];
    try {
      for (const scanRoot of roots) await this.walk(scanRoot, discovered, publicState, controller.signal, startedAt);
      const previous = this.readCatalog();
      const models = mode === "full" ? discovered : [...previous.models.filter((model) => !inside(roots[0], model.path)), ...discovered];
      const unique = [...new Map(models.map((model) => [path.resolve(model.path).toLowerCase(), model])).values()].slice(0, this.limits.maximumModels);
      const completedAt = new Date().toISOString();
      this.writeJson(this.catalogPath, { version: 1, scannedAt: completedAt, mode, roots, models: unique });
      this.lastResult = { mode, roots, completedAt, cancelled: false, directoriesScanned: publicState.directoriesScanned, filesScanned: publicState.filesScanned, modelsFound: discovered.length, compatibleModels: unique.length };
      this.active = null;
      return this.status();
    } catch (error) {
      const cancelled = controller.signal.aborted;
      this.lastResult = { mode, roots, completedAt: new Date().toISOString(), cancelled, directoriesScanned: publicState.directoriesScanned, filesScanned: publicState.filesScanned, modelsFound: discovered.length, error: cancelled ? "Scan cancelled." : error instanceof Error ? error.message : "Model scan failed." };
      if (!cancelled) throw error;
      this.active = null;
      return this.status();
    } finally { this.active = null; }
  }

  cancel() { if (!this.active) return false; this.active.controller.abort(new Error("Model scan cancelled.")); return true; }

  async walk(root, discovered, progress, signal, startedAt) {
    const stack = [path.resolve(root)]; const driveRoot = path.parse(path.resolve(root)).root.toLowerCase();
    while (stack.length) {
      if (signal.aborted) throw signal.reason;
      if (Date.now() - startedAt > this.limits.maximumDurationMs) throw new Error("The bounded model scan reached its time limit. Use a targeted folder scan for remaining locations.");
      if (progress.directoriesScanned >= this.limits.maximumDirectories || progress.filesScanned >= this.limits.maximumFiles || discovered.length >= this.limits.maximumModels) throw new Error("The bounded model scan reached its safety limit. Use a targeted folder scan to narrow the search.");
      const directory = stack.pop(); progress.currentPath = directory; progress.directoriesScanned += 1;
      let entries; try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (signal.aborted) throw signal.reason;
        const entryPath = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          const atDriveRoot = directory.toLowerCase() === driveRoot;
          if ((atDriveRoot && IGNORED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) || ["node_modules", ".git", "$recycle.bin", "system volume information"].includes(entry.name.toLowerCase())) continue;
          stack.push(entryPath); continue;
        }
        if (!entry.isFile()) continue;
        progress.filesScanned += 1;
        if (!compatibleModelFile(entry.name)) continue;
        try { const stat = await fs.promises.stat(entryPath); if (stat.size < 64 * 1024) continue; discovered.push({ path: path.resolve(entryPath), sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString(), root: path.resolve(root) }); progress.modelsFound = discovered.length; }
        catch { /* file changed during scan */ }
      }
      if (progress.directoriesScanned % 32 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
  }
}

module.exports = { ModelLibraryManager, compatibleModelFile, inside };
