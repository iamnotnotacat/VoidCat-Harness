/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractRagText, spoolReadableToFile } from "../build/voidcat-rag-ingestion.ts";

async function temporaryRoot() { return fs.mkdtemp(path.join(os.tmpdir(), "voidcat-rag-upload-test-")); }
async function removeTemporaryRoot(root: string) { assert.ok(path.basename(root).startsWith("voidcat-rag-upload-test-")); await fs.rm(root, { recursive: true, force: true }); }

async function *chunks(count: number, size: number) { for (let index = 0; index < count; index += 1) yield Buffer.alloc(size, index % 251); }

test("RAG uploads spool incrementally to disk and preserve exact byte length", async () => {
  const root = await temporaryRoot(); const target = path.join(root, "upload.tmp");
  try {
    const size = await spoolReadableToFile(chunks(64, 128 * 1024), target, { memoryReserveBytes: 0, diskReserveBytes: 1024, initialDiskFreeBytes: 16 * 1024 * 1024 });
    assert.equal(size, 8 * 1024 * 1024); assert.equal((await fs.stat(target)).size, size);
  } finally { await removeTemporaryRoot(root); }
});

test("RAG spooling enforces the free-disk reserve and removes every partial upload", async () => {
  const root = await temporaryRoot(); const target = path.join(root, "partial.tmp");
  try {
    await assert.rejects(spoolReadableToFile(chunks(3, 2_048), target, { memoryReserveBytes: 0, diskReserveBytes: 2_048, initialDiskFreeBytes: 5_120 }), /free-disk reserve/);
    await assert.rejects(fs.stat(target), { code: "ENOENT" });
  } finally { await removeTemporaryRoot(root); }
});

test("text extraction reads the spooled source path without rebuilding an upload buffer", async () => {
  const root = await temporaryRoot(); const target = path.join(root, "notes.md");
  try { await fs.writeFile(target, "# Local evidence\n\nA bounded passage."); assert.match(await extractRagText("notes.md", target), /bounded passage/); }
  finally { await removeTemporaryRoot(root); }
});
