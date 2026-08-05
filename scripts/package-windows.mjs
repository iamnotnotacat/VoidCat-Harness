/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import { packager } from "@electron/packager";
import { listPackage } from "@electron/asar";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const workspace = resolve(import.meta.dirname, ".."); const releaseRoot = join(workspace, "release"); const expectedPackage = join(releaseRoot, "VoidCat Harness-win32-x64");
if (dirname(expectedPackage) !== releaseRoot) throw new Error("Refusing to clean an unexpected package path.");
rmSync(expectedPackage, { recursive: true, force: true });

function stripOptionalReleasePayload({ buildPath }) {
  const packageRoot = resolve(buildPath); const modulesRoot = resolve(packageRoot, "node_modules");
  const targets = [
    join(modulesRoot, "pdfjs-dist"),
    join(modulesRoot, "pdf-parse", "dist", "pdf-parse", "cjs"),
    join(modulesRoot, "pdf-parse", "dist", "pdf-parse", "web"),
    join(modulesRoot, "pdf-parse", "dist", "worker"),
    join(modulesRoot, "pdf-parse", "dist", "node"),
    join(modulesRoot, "pdf-parse", "bin"),
  ];
  for (const target of targets) {
    const resolved = resolve(target);
    if (resolved === modulesRoot || !resolved.startsWith(`${modulesRoot}\\`)) throw new Error(`Refusing to trim an unsafe package path: ${resolved}`);
    rmSync(resolved, { recursive: true, force: true });
  }
}

const output = await packager({
  dir: workspace, name: "VoidCat Harness", platform: "win32", arch: "x64", out: releaseRoot, overwrite: true, prune: true,
  icon: join(workspace, "assets", "voidcat.ico"), asar: { unpack: "**/*.{node,dll,exe,bin}" },
  ignore: [
    /^\/(?:release|tests|docs|examples|scripts|src|\.github|\.git|\.voidcat|\.electron-cache|\.npm-cache|\.wrangler|outputs|work)(?:\/|$)/,
    /^\/node_modules\/(?:\.vite|\.vite-temp)(?:\/|$)/,
    /^\/node_modules\/(?:@[^/]+\/)?[^/]+\/(?:docs?|examples?|benchmarks?|tests?)(?:\/|$)/,
    /^\/(?:vite\.config\.ts|eslint\.config\.js|postcss\.config\.mjs|tsconfig\.json|tsconfig\.tsbuildinfo)$/,
  ],
  afterPrune: [stripOptionalReleasePayload],
  win32metadata: { CompanyName: "iamnotnotacat", FileDescription: "VoidCat Harness", ProductName: "VoidCat Harness", InternalName: "VoidCat Harness", OriginalFilename: "VoidCat Harness.exe" },
});
if (output.length !== 1 || resolve(output[0]) !== expectedPackage) throw new Error(`Unexpected package output: ${output.join(", ")}`);

const localeRoot = join(expectedPackage, "locales");
for (const entry of readdirSync(localeRoot, { withFileTypes: true })) if (entry.name.toLowerCase() !== "en-us.pak") rmSync(join(localeRoot, entry.name), { recursive: entry.isDirectory(), force: false });
const asarPath = join(expectedPackage, "resources", "app.asar"); const archiveEntries = listPackage(asarPath, { isPack: true });
const archivePaths = archiveEntries.map((entry) => entry.replace(/^pack\s*:\s*/i, "").replaceAll("\\", "/").replace(/^\/+/, ""));
for (const forbidden of ["tests", "docs", "release", ".git", ".voidcat"]) if (archivePaths.some((entry) => entry === forbidden || entry.startsWith(`${forbidden}/`))) throw new Error(`Packaged archive retained forbidden development content: ${forbidden}`);
if (archivePaths.some((entry) => entry === "node_modules/pdfjs-dist" || entry.startsWith("node_modules/pdfjs-dist/"))) throw new Error("The redundant standalone PDF.js distribution was retained.");
if (!archivePaths.includes("node_modules/pdf-parse/dist/pdf-parse/esm/index.js")) throw new Error("The packaged RAG PDF text extractor is missing.");
const bundledEngine = join(expectedPackage, "resources", "app.asar.unpacked", "vendor", "whisper", "windows-x64", "Release", "whisper-cli.exe"); const bundledModel = join(expectedPackage, "resources", "app.asar.unpacked", "vendor", "whisper", "windows-x64", "models", "ggml-tiny.en-q5_1.bin");
for (const required of [join(expectedPackage, "VoidCat Harness.exe"), asarPath, bundledEngine, bundledModel, join(localeRoot, "en-US.pak")]) if (!existsSync(required)) throw new Error(`Packaged runtime is incomplete: ${required}`);
function totalBytes(directory) { return readdirSync(directory, { withFileTypes: true }).reduce((sum, entry) => { const target = join(directory, entry.name); return sum + (entry.isDirectory() ? totalBytes(target) : statSync(target).size); }, 0); }
const sizeBytes = totalBytes(expectedPackage); if (sizeBytes > 425 * 1024 ** 2) throw new Error(`Package size budget exceeded: ${(sizeBytes / 1024 ** 2).toFixed(1)} MiB.`);
console.log(`Verified Windows package: ${(sizeBytes / 1024 ** 2).toFixed(1)} MiB, ASAR enabled, one locale, bundled local voice runtime.`);
