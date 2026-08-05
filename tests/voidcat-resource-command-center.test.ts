/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { VoidCatJobManager } from "../build/voidcat-job-manager.ts";
import { VoidCatResourceCommandCenter } from "../build/voidcat-resource-command-center.ts";

const caps = { maxIterations: 4, timeoutMs: 5_000, maxExternalCalls: 2 };

test("resource command center reports bounded telemetry and applies profiles", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voidcat-resource-"));
  try {
    const jobs = new VoidCatJobManager({ maximumConcurrentJobs: 4, minimumUpdateIntervalMs: 0 });
    const center = new VoidCatResourceCommandCenter({ jobs, dataRoot: root, profile: "normal", unitSnapshot: async () => ({ online: true, loaded: [{ modelKey: "fixture" }], contextLength: 4_096 }), ragSnapshot: () => ({ documents: 2, folders: 1, chunks: 8, vectors: 7, pending: 1, activeScans: 0 }), storageSnapshot: async () => ({ budgets: {}, components: {} }) });
    assert.equal(jobs.controlSnapshot().concurrencyLimit, 2);
    const snapshot = await center.collect();
    assert.equal(snapshot.profile.id, "normal"); assert.equal(snapshot.unit.contextLength, 4_096); assert.equal(snapshot.rag.vectors, 7);
    assert.ok(snapshot.cpu.cores >= 1); assert.ok(snapshot.memory.totalBytes > 0); assert.ok(snapshot.disk.totalBytes > 0);
    center.setProfile("quiet"); assert.equal(jobs.controlSnapshot().concurrencyLimit, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("module pause blocks dispatch until resume", async () => {
  const jobs = new VoidCatJobManager({ maximumConcurrentJobs: 2, minimumUpdateIntervalMs: 0 });
  jobs.pauseModule("fixture-module");
  const handle = jobs.start({ module: "fixture-module", name: "paused-work", caps, run: async () => "done" });
  await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(handle.snapshot().status, "queued");
  jobs.resumeModule("fixture-module"); assert.equal(await handle.result, "done"); assert.equal(handle.snapshot().status, "completed");
});

test("emergency stop hard-cancels work and holds new dispatch", async () => {
  const jobs = new VoidCatJobManager({ maximumConcurrentJobs: 2, minimumUpdateIntervalMs: 0 });
  const handle = jobs.start({ module: "fixture-module", name: "long-work", caps, run: ({ signal }) => new Promise<string>((resolve, reject) => { const timer = setTimeout(() => resolve("late"), 2_000); signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); }) });
  const rejection = assert.rejects(handle.result, /cancel/i); await new Promise((resolve) => setTimeout(resolve, 5));
  const stopped = jobs.emergencyStop(); assert.equal(stopped.cancelled, 1); await rejection; assert.equal(handle.snapshot().status, "cancelled"); assert.equal(jobs.controlSnapshot().globallyPaused, true);
  const queued = jobs.start({ module: "fixture-module", name: "held-work", caps, run: async () => "done" });
  await new Promise((resolve) => setTimeout(resolve, 5)); assert.equal(queued.snapshot().status, "queued"); jobs.resumeAll(); assert.equal(await queued.result, "done");
});

test("resource command center routes and controls remain registered", async () => {
  const [backend, panel] = await Promise.all([import("node:fs/promises").then(({ readFile }) => readFile("build/voidcat-local-plugin.ts", "utf8")), import("node:fs/promises").then(({ readFile }) => readFile("app/DiagnosticsPanel.tsx", "utf8"))]);
  for (const route of ["/api/resource-command", "/api/resource-command/events", "/api/resource-command/profile", "/api/resource-command/emergency-stop", "/api/resource-command/resume"]) assert.ok(backend.includes(route), route);
  for (const affordance of ["EMERGENCY STOP", "AUTO THROTTLE ACTIVE", "MANAGED TRAFFIC", "UNIT + CONTEXT", "RAG INDEX", "CANCEL ACTIVE"]) assert.ok(panel.includes(affordance), affordance);
});
