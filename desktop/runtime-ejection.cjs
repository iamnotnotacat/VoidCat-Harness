/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
const fs = require("node:fs");
const path = require("node:path");

function readOwnershipMarker(markerPath) {
  try { const parsed = JSON.parse(fs.readFileSync(markerPath, "utf8")); return { ...parsed, identifiers: Array.isArray(parsed.identifiers) ? [...new Set(parsed.identifiers.filter((value) => value === "voidcat-core" || value === "voidcat-embed"))] : [] }; }
  catch { return { version: 2, identifiers: [] }; }
}

function writeOwnershipMarker(markerPath, marker, remaining) {
  if (!remaining.length) { fs.rmSync(markerPath, { force: true }); return; }
  const next = { ...marker, identifiers: remaining, core: remaining.includes("voidcat-core") ? marker.core : undefined, markedAt: new Date().toISOString() };
  const temporary = `${markerPath}.tmp-${process.pid}`; fs.mkdirSync(path.dirname(markerPath), { recursive: true }); fs.writeFileSync(temporary, JSON.stringify(next), { encoding: "utf8", flag: "wx" }); fs.renameSync(temporary, markerPath);
}

async function ejectOwnedRuntime({ markerPath, runUnload, listLoaded }) {
  if (!fs.existsSync(markerPath)) return { attempted: [], ejected: [], remaining: [], errors: [] };
  const marker = readOwnershipMarker(markerPath); const attempted = [...marker.identifiers]; const errors = [];
  for (const identifier of attempted) {
    try { await runUnload(identifier); }
    catch (error) { errors.push({ identifier, message: error instanceof Error ? error.message : String(error) }); }
  }
  let loaded;
  try { loaded = new Set(await listLoaded()); }
  catch (error) {
    errors.push({ identifier: "verification", message: error instanceof Error ? error.message : String(error) });
    writeOwnershipMarker(markerPath, marker, attempted); return { attempted, ejected: [], remaining: attempted, errors };
  }
  const remaining = attempted.filter((identifier) => loaded.has(identifier)); const ejected = attempted.filter((identifier) => !loaded.has(identifier));
  writeOwnershipMarker(markerPath, marker, remaining); return { attempted, ejected, remaining, errors };
}

module.exports = { ejectOwnedRuntime, readOwnershipMarker };
