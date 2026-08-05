/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import { gzipSync } from "node:zlib";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const assets = resolve("dist", "assets"); const entries = readdirSync(assets);
function only(pattern, label) { const matches = entries.filter((name) => pattern.test(name)); if (matches.length !== 1) throw new Error(`Expected one ${label} bundle, found ${matches.length}.`); return matches[0]; }
function verify(name, maximumGzipBytes, label) { const bytes = gzipSync(readFileSync(join(assets, name))).byteLength; if (bytes > maximumGzipBytes) throw new Error(`${label} gzip budget exceeded: ${(bytes / 1024).toFixed(1)} KiB > ${(maximumGzipBytes / 1024).toFixed(1)} KiB.`); return bytes; }
const initial = only(/^index-[^.]+\.js$/, "initial application"); const map = only(/^HunterSeekerMap-[^.]+\.js$/, "lazy map");
const initialBytes = verify(initial, 100 * 1024, "Initial application"); const mapBytes = verify(map, 300 * 1024, "Lazy Hunter map");
console.log(`Build budgets nominal: initial ${(initialBytes / 1024).toFixed(1)} KiB gzip; lazy map ${(mapBytes / 1024).toFixed(1)} KiB gzip.`);
