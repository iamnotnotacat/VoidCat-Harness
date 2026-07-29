import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

const coveredExtensions = new Set([".cjs", ".cmd", ".css", ".html", ".js", ".jsx", ".mjs", ".ps1", ".sql", ".ts", ".tsx", ".yaml", ".yml"]);
const marker = "Common Public Attribution License Version 1.0";
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", windowsHide: true })
  .split(/\r?\n/)
  .filter((file) => file && coveredExtensions.has(extname(file).toLowerCase()));
const missing = files.filter((file) => !readFileSync(file, "utf8").slice(0, 2_500).includes(marker));

if (missing.length) {
  console.error(`CPAL Exhibit A notice is missing from ${missing.length} source file(s):\n${missing.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`CPAL notices verified in ${files.length} source files.`);
}
