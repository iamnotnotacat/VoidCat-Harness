import { readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..", "release", "VoidCat Harness-win32-x64", "resources", "app");
const nodeModulesRoot = join(packageRoot, "node_modules");
let removedBytes = 0;
let removedFiles = 0;

function shouldRemove(name) {
  return name.endsWith(".map") || /\.d\.(?:ts|cts|mts)$/i.test(name);
}

function trim(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const candidate = join(directory, entry.name);
    if (entry.isDirectory()) trim(candidate);
    else if (entry.isFile() && shouldRemove(entry.name)) {
      removedBytes += statSync(candidate).size;
      removedFiles += 1;
      rmSync(candidate, { force: true });
    }
  }
}

trim(nodeModulesRoot);
console.log(`Removed ${removedFiles} packaged development-only files (${(removedBytes / 1024 ** 2).toFixed(2)} MiB).`);
