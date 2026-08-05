/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import type { IncomingMessage } from "node:http";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import Busboy from "busboy";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

export interface SpooledRagUpload { filename: string; mimeType: string; temporaryPath: string; sizeBytes: number }

export async function spoolReadableToFile(input: AsyncIterable<Uint8Array>, target: string, options: { memoryReserveBytes: number; diskReserveBytes: number; initialDiskFreeBytes?: number }) {
  const parent = path.dirname(target); await fs.mkdir(parent, { recursive: true });
  const available: number = typeof options.initialDiskFreeBytes === "number" ? options.initialDiskFreeBytes : await fs.statfs(parent).then((stats) => Number(stats.bavail) * Number(stats.bsize));
  const handle = await fs.open(target, "wx"); let sizeBytes = 0;
  try {
    for await (const value of input) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      sizeBytes += chunk.byteLength;
      if (os.freemem() < options.memoryReserveBytes) throw new Error("The document upload stopped to preserve a safe amount of free memory.");
      if (available - sizeBytes < options.diskReserveBytes) throw new Error("The document upload stopped to preserve the configured free-disk reserve.");
      await handle.write(chunk);
    }
    await handle.sync(); return sizeBytes;
  } catch (error) {
    await handle.close(); await fs.rm(target, { force: true }); throw error;
  } finally {
    try { await handle.close(); } catch { /* already closed after a failed stream */ }
  }
}

export async function spoolRagUpload(request: IncomingMessage, options: { temporaryRoot: string; memoryReserveBytes: number; diskReserveBytes: number }): Promise<SpooledRagUpload> {
  await fs.mkdir(options.temporaryRoot, { recursive: true });
  return new Promise((resolve, reject) => {
    let fileSeen = false; let settled = false;
    const finishReject = (error: unknown) => { if (!settled) { settled = true; reject(error); } };
    try {
      const parser = Busboy({ headers: request.headers, limits: { files: 1, fields: 2 } });
      parser.on("file", (_field, stream, info) => {
        if (fileSeen) { stream.resume(); return; }
        fileSeen = true;
        const temporaryPath = path.join(options.temporaryRoot, `${randomUUID()}.upload`);
        void spoolReadableToFile(stream, temporaryPath, options).then((sizeBytes) => {
          if (!settled) { settled = true; resolve({ filename: path.basename(info.filename), mimeType: info.mimeType, temporaryPath, sizeBytes }); }
        }).catch(finishReject);
      });
      parser.on("filesLimit", () => finishReject(new Error("Attach one document at a time.")));
      parser.on("error", finishReject);
      parser.on("finish", () => { if (!fileSeen) finishReject(new Error("No document was attached.")); });
      request.pipe(parser);
    } catch (error) { finishReject(error); }
  });
}

export async function extractRagText(filename: string, sourcePath: string) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".txt" || extension === ".md") return fs.readFile(sourcePath, "utf8");
  if (extension === ".docx") return (await mammoth.extractRawText({ path: sourcePath })).value;
  if (extension === ".pdf") {
    const buffer = await fs.readFile(sourcePath); const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength); const parser = new PDFParse({ data });
    try { return (await parser.getText()).text; } finally { await parser.destroy(); }
  }
  throw new Error("Unsupported document format. Use PDF, DOCX, TXT, or Markdown.");
}
