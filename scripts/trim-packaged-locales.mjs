import fs from "node:fs";
import path from "node:path";

const packageRoot = path.resolve(process.cwd(), "release", "VoidCat Harness-win32-x64");
const localeRoot = path.join(packageRoot, "locales");
if (!fs.existsSync(path.join(packageRoot, "VoidCat Harness.exe")) || !fs.existsSync(localeRoot)) throw new Error("The expected VoidCat portable package was not found.");

for (const entry of fs.readdirSync(localeRoot, { withFileTypes: true })) {
  const resolved = path.resolve(localeRoot, entry.name);
  if (path.dirname(resolved) !== localeRoot || entry.name.toLowerCase() === "en-us.pak") continue;
  fs.rmSync(resolved, { recursive: entry.isDirectory(), force: false });
}

if (!fs.existsSync(path.join(localeRoot, "en-US.pak"))) throw new Error("The required English Electron locale is missing.");
