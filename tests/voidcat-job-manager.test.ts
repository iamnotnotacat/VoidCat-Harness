import assert from "node:assert/strict";
import test from "node:test";
import { JobManagerError, VoidCatJobManager, type ManagedJobDefinition } from "../build/voidcat-job-manager.ts";

function definition<TResult>(run: ManagedJobDefinition<TResult>["run"], overrides: Partial<Omit<ManagedJobDefinition<TResult>, "run">> = {}): ManagedJobDefinition<TResult> {
  return {
    module: "test-module",
    name: "bounded-analysis",
    caps: { maxIterations: 5, timeoutMs: 2_000, maxExternalCalls: 2 },
    run,
    ...overrides,
  };
}

function nextTurn() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

test("managed jobs report lifecycle, progress, and bounded resources", async () => {
  const manager = new VoidCatJobManager({ minimumUpdateIntervalMs: 0 });
  const statuses: string[] = [];
  manager.subscribe((snapshot) => {
    statuses.push(snapshot.status);
    snapshot.progress.current = 999;
  });
  manager.subscribe(() => { throw new Error("faulty subscriber"); });
  const handle = manager.start(definition(async (context) => {
    context.consumeIteration(2);
    const first = await context.externalCall(async () => "A");
    const second = await context.externalCall(async () => "B");
    context.reportUsage({ inputTokens: 12, outputTokens: 4, units: 1.5 });
    context.reportProgress({ current: 2, total: 2, message: "Complete" });
    return first + second;
  }));

  assert.equal(await handle.result, "AB");
  const snapshot = handle.snapshot();
  assert.equal(snapshot.status, "completed");
  assert.deepEqual(snapshot.progress, { current: 2, total: 2, message: "Complete" });
  assert.deepEqual(snapshot.resources, { iterations: 2, externalCalls: 2, inputTokens: 12, outputTokens: 4, units: 1.5, wallClockMs: snapshot.resources.wallClockMs });
  assert.equal(snapshot.cleanupPending, false);
  assert.ok(statuses.includes("queued"));
  assert.ok(statuses.includes("running"));
  assert.ok(statuses.includes("completed"));
});

test("iteration and external-call caps cannot be bypassed by catching the limit error", async () => {
  const manager = new VoidCatJobManager({ minimumUpdateIntervalMs: 0 });
  const iterations = manager.start(definition(async (context) => {
    context.consumeIteration(5);
    try { context.consumeIteration(); } catch { /* a handler cannot convert a terminal cap into success */ }
    return "should-not-complete";
  }));
  await assert.rejects(iterations.result, (error: unknown) => error instanceof JobManagerError && error.code === "ITERATION_LIMIT");
  assert.equal(iterations.snapshot().status, "limit-exceeded");
  assert.equal(iterations.snapshot().resources.iterations, 5);

  const calls = manager.start(definition(async (context) => {
    await context.externalCall(async () => 1);
    await context.externalCall(async () => 2);
    try { await context.externalCall(async () => 3); } catch { /* terminal */ }
    return 3;
  }));
  await assert.rejects(calls.result, (error: unknown) => error instanceof JobManagerError && error.code === "EXTERNAL_CALL_LIMIT");
  assert.equal(calls.snapshot().status, "limit-exceeded");
  assert.equal(calls.snapshot().resources.externalCalls, 2);
});

test("wall-clock timeout aborts the job and reports a stable terminal state", async () => {
  const manager = new VoidCatJobManager({ minimumUpdateIntervalMs: 0 });
  let receivedAbort = false;
  const handle = manager.start(definition(async (context) => new Promise<string>((resolve) => {
    context.signal.addEventListener("abort", () => { receivedAbort = true; resolve("late"); }, { once: true });
  }), { caps: { maxIterations: 1, timeoutMs: 50, maxExternalCalls: 0 } }));
  await assert.rejects(handle.result, (error: unknown) => error instanceof JobManagerError && error.code === "TIMED_OUT");
  await nextTurn();
  assert.equal(receivedAbort, true);
  assert.equal(handle.snapshot().status, "timed-out");
  assert.equal(handle.snapshot().cleanupPending, false);
});

test("cancelled handlers keep their execution slot until cleanup actually finishes", async () => {
  const manager = new VoidCatJobManager({ maximumConcurrentJobs: 1, maximumQueuedJobs: 1, minimumUpdateIntervalMs: 0 });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let secondStarted = false;
  const first = manager.start(definition(async () => { await held; return "first"; }));
  const second = manager.start(definition(async () => { secondStarted = true; return "second"; }, { name: "second-analysis" }));
  assert.throws(() => manager.start(definition(async () => "third", { name: "third-analysis" })), (error: unknown) => error instanceof JobManagerError && error.code === "QUEUE_FULL");
  await nextTurn();

  assert.equal(first.cancel(), true);
  await assert.rejects(first.result, (error: unknown) => error instanceof JobManagerError && error.code === "CANCELLED");
  assert.equal(first.snapshot().cleanupPending, true);
  await nextTurn();
  assert.equal(secondStarted, false);

  release();
  await nextTurn();
  assert.equal(await second.result, "second");
  assert.equal(secondStarted, true);
  assert.equal(first.snapshot().cleanupPending, false);
});

test("queued jobs and entire modules can be cancelled programmatically", async () => {
  const manager = new VoidCatJobManager({ maximumConcurrentJobs: 1, maximumQueuedJobs: 2, minimumUpdateIntervalMs: 0 });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const first = manager.start(definition(async (context) => {
    await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
    await held;
    return "done";
  }, { module: "cancel-me" }));
  const queued = manager.start(definition(async () => "queued", { module: "cancel-me", name: "queued-analysis" }));
  await nextTurn();
  assert.equal(manager.cancelModule("cancel-me"), 2);
  await assert.rejects(first.result, (error: unknown) => error instanceof JobManagerError && error.code === "CANCELLED");
  await assert.rejects(queued.result, (error: unknown) => error instanceof JobManagerError && error.code === "CANCELLED");
  assert.equal(queued.snapshot().status, "cancelled");
  release();
  await nextTurn();
});

test("progress notifications are throttled and terminal history is bounded", async () => {
  const manager = new VoidCatJobManager({ maximumHistory: 2, minimumUpdateIntervalMs: 1_000 });
  let notifications = 0;
  manager.subscribe(() => { notifications += 1; });
  for (let jobIndex = 0; jobIndex < 3; jobIndex += 1) {
    const handle = manager.start(definition(async (context) => {
      for (let index = 0; index < 5; index += 1) context.reportProgress({ current: index, total: 5 });
      return jobIndex;
    }, { name: `history-${jobIndex}` }));
    await handle.result;
    await nextTurn();
  }
  assert.ok(notifications < 20);
  assert.equal(manager.list().length, 2);
  assert.equal(manager.list({ limit: 0 }).length, 0);
  assert.equal(manager.clearFinished(), 2);
  assert.equal(manager.list().length, 0);
});

test("invalid definitions and handler failures fail closed", async () => {
  const manager = new VoidCatJobManager({ minimumUpdateIntervalMs: 0 });
  assert.throws(() => manager.start(definition(async () => null, { caps: { maxIterations: 0, timeoutMs: 1, maxExternalCalls: -1 } })), (error: unknown) => error instanceof JobManagerError && error.code === "INVALID_DEFINITION");
  const failed = manager.start(definition(async () => { throw new Error("provider secret detail"); }));
  await assert.rejects(failed.result, (error: unknown) => error instanceof JobManagerError && error.code === "HANDLER_FAILED" && !error.message.includes("provider secret detail"));
  assert.equal(failed.snapshot().status, "failed");
  assert.equal(failed.snapshot().errorCode, "HANDLER_FAILED");
});
