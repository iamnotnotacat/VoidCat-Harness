/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
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
