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
const { ejectOwnedRuntime, readOwnershipMarker } = require("../desktop/runtime-ejection.cjs");

function root() { return fs.mkdtempSync(path.join(os.tmpdir(), "voidcat-ejection-test-")); }
function markerAt(directory) { const marker = path.join(directory, "runtime-owned.json"); fs.writeFileSync(marker, JSON.stringify({ version: 2, identifiers: ["voidcat-core", "voidcat-embed"], core: { catalogModelKey: "fixture" } })); return marker; }

test("verified shutdown ejection removes ownership only after every runtime is absent", async () => {
  const directory = root(); const markerPath = markerAt(directory); const calls = [];
  try {
    const result = await ejectOwnedRuntime({ markerPath, runUnload: async (identifier) => { calls.push(identifier); }, listLoaded: async () => [] });
    assert.deepEqual(calls, ["voidcat-core", "voidcat-embed"]); assert.deepEqual(result.ejected, calls); assert.equal(fs.existsSync(markerPath), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("failed verification retains the complete ownership marker for the next safe retry", async () => {
  const directory = root(); const markerPath = markerAt(directory);
  try {
    const result = await ejectOwnedRuntime({ markerPath, runUnload: async () => {}, listLoaded: async () => { throw new Error("runtime unavailable"); } });
    assert.deepEqual(result.remaining, ["voidcat-core", "voidcat-embed"]); assert.deepEqual(readOwnershipMarker(markerPath).identifiers, result.remaining);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("partial ejection keeps only the model that is still confirmed loaded", async () => {
  const directory = root(); const markerPath = markerAt(directory);
  try {
    const result = await ejectOwnedRuntime({ markerPath, runUnload: async (identifier) => { if (identifier === "voidcat-core") throw new Error("held"); }, listLoaded: async () => ["voidcat-core"] });
    assert.deepEqual(result.ejected, ["voidcat-embed"]); assert.deepEqual(result.remaining, ["voidcat-core"]); assert.deepEqual(readOwnershipMarker(markerPath).identifiers, ["voidcat-core"]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
