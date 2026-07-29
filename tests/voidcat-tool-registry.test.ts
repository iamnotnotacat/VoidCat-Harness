/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  ToolRegistryError,
  VoidCatToolRegistry,
  type ToolDefinition,
} from "../build/voidcat-tool-registry.ts";

function definition(name = "test.echo", overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name,
    module: "test-module",
    description: "Returns a bounded echo for shared registry verification.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", minLength: 1, maxLength: 100 } },
      required: ["message"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { echo: { type: "string", maxLength: 100 } },
      required: ["echo"],
      additionalProperties: false,
    },
    rateLimit: { invocations: 3, windowMs: 60_000, maxConcurrent: 1 },
    tags: ["read-only"],
    handler(argumentsValue, context) {
      context.reportCost({ units: 1 });
      return { echo: String(argumentsValue.message) };
    },
    ...overrides,
  };
}

test("registry discovers immutable metadata without exposing handlers", () => {
  const registry = new VoidCatToolRegistry();
  registry.register(definition());
  const discovered = registry.discover();
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].name, "test.echo");
  assert.equal(discovered[0].enabled, true);
  assert.deepEqual(discovered[0].tags, ["read-only"]);
  assert.equal("handler" in discovered[0], false);
  discovered[0].inputSchema.properties!.message.maxLength = 1;
  assert.equal(registry.discover()[0].inputSchema.properties!.message.maxLength, 100);
  assert.deepEqual(registry.discover({ tags: ["read-only"] }).map(({ name }) => name), ["test.echo"]);
  assert.deepEqual(registry.discover({ module: "missing" }), []);
});

test("registration requires namespaced names, closed object inputs, and bounded arrays", () => {
  const registry = new VoidCatToolRegistry();
  assert.throws(() => registry.register(definition("echo")), /dot-namespaced/i);
  assert.throws(() => registry.register(definition("test.open", {
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
  })), /additionalProperties to false/i);
  assert.throws(() => registry.register(definition("test.array", {
    inputSchema: {
      type: "object",
      properties: { values: { type: "array", items: { type: "integer" } } },
      required: ["values"],
      additionalProperties: false,
    },
  })), /maxItems/i);
  assert.throws(() => registry.register(definition("test.unbounded-output", { maxOutputBytes: 8 * 1024 * 1024 + 1 })), /maxOutputBytes/i);
  registry.register(definition());
  assert.throws(() => registry.register(definition()), /already registered/i);
});

test("invocation validates closed arguments, records cost, and never records values", async () => {
  let handlerCalls = 0;
  const registry = new VoidCatToolRegistry();
  registry.register(definition("test.secure-echo", {
    handler(argumentsValue, context) {
      handlerCalls += 1;
      assert.equal(Object.isFrozen(argumentsValue), true);
      context.reportCost({ externalCalls: 1, inputTokens: 4, outputTokens: 2, units: 0.5 });
      return { echo: String(argumentsValue.message) };
    },
  }));

  await assert.rejects(
    registry.invoke("test.secure-echo", { message: "secret-value", extra: true }),
    (error: unknown) => error instanceof ToolRegistryError && error.code === "INVALID_ARGUMENTS",
  );
  assert.equal(handlerCalls, 0);

  const result = await registry.invoke<{ echo: string }>("test.secure-echo", { message: "secret-value" }, { caller: { kind: "agent", id: "unit-7", modelLane: "local" } });
  assert.deepEqual(result, { echo: "secret-value" });
  assert.equal(handlerCalls, 1);
  const records = registry.invocationRecords({ toolName: "test.secure-echo" });
  assert.equal(records.length, 2);
  assert.equal(records[1].status, "success");
  assert.equal(records[1].caller.modelLane, "local");
  assert.deepEqual(records[1].cost, { externalCalls: 1, inputTokens: 4, outputTokens: 2, units: 0.5 });
  assert.ok(records[1].inputBytes > 0);
  assert.ok(records[1].outputBytes > 0);
  assert.equal(JSON.stringify(records).includes("secret-value"), false);
});

test("per-tool sliding-window and concurrency limits are isolated", async () => {
  let currentTime = Date.parse("2026-07-27T12:00:00.000Z");
  const registry = new VoidCatToolRegistry({ now: () => currentTime });
  registry.register(definition("test.one", { rateLimit: { invocations: 1, windowMs: 60_000, maxConcurrent: 1 } }));
  registry.register(definition("test.two", { rateLimit: { invocations: 1, windowMs: 60_000, maxConcurrent: 1 } }));
  await registry.invoke("test.one", { message: "first" });
  await assert.rejects(
    registry.invoke("test.one", { message: "second" }),
    (error: unknown) => error instanceof ToolRegistryError && error.code === "RATE_LIMITED" && error.retryAt === "2026-07-27T12:01:00.000Z",
  );
  assert.deepEqual(await registry.invoke("test.two", { message: "independent" }), { echo: "independent" });
  currentTime += 60_001;
  assert.deepEqual(await registry.invoke("test.one", { message: "after-window" }), { echo: "after-window" });

  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  registry.register(definition("test.concurrent", {
    rateLimit: { invocations: 10, windowMs: 60_000, maxConcurrent: 1 },
    async handler(argumentsValue) { await waiting; return { echo: String(argumentsValue.message) }; },
  }));
  const first = registry.invoke("test.concurrent", { message: "held" });
  await assert.rejects(
    registry.invoke("test.concurrent", { message: "blocked" }),
    (error: unknown) => error instanceof ToolRegistryError && error.code === "CONCURRENCY_LIMITED",
  );
  release();
  await first;
});

test("disabled, cancelled, invalid, and oversized results fail closed", async () => {
  const registry = new VoidCatToolRegistry({ defaultMaxOutputBytes: 1_024 });
  registry.register(definition("test.controlled"));
  registry.setEnabled("test.controlled", false);
  assert.equal(registry.discover().length, 0);
  assert.equal(registry.discover({ includeDisabled: true })[0].enabled, false);
  await assert.rejects(registry.invoke("test.controlled", { message: "no" }), (error: unknown) => error instanceof ToolRegistryError && error.code === "TOOL_DISABLED");

  registry.register(definition("test.cancelled"));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(registry.invoke("test.cancelled", { message: "no" }, { signal: controller.signal }), (error: unknown) => error instanceof ToolRegistryError && error.code === "CANCELLED");

  registry.register(definition("test.invalid-result", { handler() { return { wrong: true }; } }));
  await assert.rejects(registry.invoke("test.invalid-result", { message: "x" }), (error: unknown) => error instanceof ToolRegistryError && error.code === "INVALID_RESULT");

  registry.register(definition("test.large-result", {
    outputSchema: undefined,
    handler() { return { text: "x".repeat(2_000) }; },
  }));
  await assert.rejects(registry.invoke("test.large-result", { message: "x" }), (error: unknown) => error instanceof ToolRegistryError && error.code === "OUTPUT_TOO_LARGE");
});

test("invocation history is bounded and unregister refuses active handlers", async () => {
  const registry = new VoidCatToolRegistry({ maximumRecords: 2 });
  registry.register(definition("test.bounded", { rateLimit: { invocations: 10, windowMs: 60_000 } }));
  await registry.invoke("test.bounded", { message: "one" });
  await registry.invoke("test.bounded", { message: "two" });
  await registry.invoke("test.bounded", { message: "three" });
  assert.equal(registry.invocationRecords().length, 2);
  assert.equal(registry.invocationRecords({ limit: 1 }).length, 1);
  assert.equal(registry.invocationRecords({ limit: 0 }).length, 0);
  registry.clearInvocationRecords();
  assert.equal(registry.invocationRecords().length, 0);

  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  registry.register(definition("test.active", { async handler() { await waiting; return { echo: "done" }; } }));
  const running = registry.invoke("test.active", { message: "x" });
  assert.throws(() => registry.unregister("test.active"), /while it is running/i);
  release();
  await running;
  assert.equal(registry.unregister("test.active"), true);
});
