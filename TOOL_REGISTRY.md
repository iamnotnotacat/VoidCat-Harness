# VoidCat shared Tool Registry

Status: P4 approved and in use by the bounded Hunter-Seeker integration.

The shared registry is a process-local, protocol-neutral core primitive. Modules register bounded in-process handlers once; any VoidCat model lane can discover and invoke those handlers through the same interface. It contains no AI client, model routing, shell execution, MCP transport, background jobs, or Hunter-Seeker-specific behavior.

Implementation: `build/voidcat-tool-registry.ts`

## Contract

Each tool declares:

- A lowercase dot-namespaced name such as `documents.search`.
- Owning module, plain-language description, and optional tags.
- A closed JSON input schema and optional output schema.
- A sliding-window invocation limit and maximum concurrency.
- Explicit input and output byte ceilings.
- An in-process handler receiving immutable cloned arguments, caller metadata, an `AbortSignal`, and a cost-reporting callback.

`voidcatToolRegistry` is the shared singleton. `VoidCatToolRegistry` remains exportable for isolated tests or deliberately separate processes.

## Supported schema subset

The validator supports JSON-compatible object, array, string, number, integer, boolean, and null types; required properties; enums and constants; `anyOf` and `oneOf`; numeric limits; string length and pattern limits; and array length limits.

Every object schema must set `additionalProperties: false`. Every array schema must declare `items` and `maxItems`. Registration fails before a handler becomes discoverable when its schema is open, unbounded, malformed, or excessively deep.

This intentionally bounded subset can be extended centrally when a real tool needs another JSON Schema feature. Modules must not add parallel validators.

## Invocation lifecycle

`discover -> validate size -> validate schema -> rate/concurrency gate -> invoke -> validate result -> record cost`

Failures are represented by `ToolRegistryError` codes. Provider or handler exceptions are wrapped as `HANDLER_FAILED`, preventing internal details from being accidentally exposed to a UNIT. A caller-supplied abort signal is checked before and after the handler; enforceable wall-clock and external-call caps remain the separately gated P5 Job Manager's responsibility.

Per-tool rate state is isolated. Exhausting one tool never blocks another tool. Disabled tools are omitted from ordinary discovery and fail closed if invoked directly.

## Cost and privacy

The registry keeps a bounded volatile history, 1,000 records by default and never more than 10,000. Each record contains:

- Invocation ID, tool name, module, caller kind/ID/lane, status, and timestamps.
- Duration and serialized input/output byte counts.
- Handler-reported external calls, input tokens, output tokens, and generic cost units.
- A stable error code when an invocation fails.

Arguments, results, credentials, provider payloads, exception messages, and model context are never stored in invocation records. The registry performs no persistent writes. Persistent audit storage, if ever required, must pass the storage-budget gate separately.

## Usage example

```ts
import { voidcatToolRegistry } from "./build/voidcat-tool-registry";

const unregister = voidcatToolRegistry.register({
  name: "documents.lookup",
  module: "documents",
  description: "Finds a document by its stable local identifier.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1, maxLength: 128 },
    },
    required: ["id"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      found: { type: "boolean" },
      title: { type: "string", maxLength: 300 },
    },
    required: ["found", "title"],
    additionalProperties: false,
  },
  rateLimit: { invocations: 30, windowMs: 60_000, maxConcurrent: 2 },
  tags: ["read-only"],
  async handler({ id }, context) {
    context.reportCost({ units: 1 });
    return { found: true, title: String(id) };
  },
});

const tools = voidcatToolRegistry.discover({ tags: ["read-only"] });
const result = await voidcatToolRegistry.invoke("documents.lookup", { id: "doc-01" }, {
  caller: { kind: "agent", id: "voidcat-core", modelLane: "local" },
});

unregister();
```

## Hunter-Seeker consumer

`build/hunter-seeker/hunter-seeker-tools.ts` registers exactly six passive, read-only, live-only tools:

- Aircraft inside a bounding box.
- Aircraft by exact callsign or ICAO transponder address.
- Vessels inside a bounding box from the operator-selected AIS region.
- Estimated satellite passes over a bounded area from cached CelesTrak orbital elements.
- Recent seismic events by magnitude and age.
- Current feed health and scheduling state.

Every observation carries its exact `[HS:observation-id]` citation, source, freshness, confidence, and measured/derived/estimated basis. Outputs explicitly state that the board is volatile and an empty result is not evidence of absence. Inputs and outputs are closed and bounded; antimeridian bounding boxes are supported.

The aisstream vessel feed remains owned by Electron's protected main process. Electron publishes a size-limited, credential-free volatile snapshot to the local tool process every five seconds through a token-authenticated loopback route. The bridge never transmits the API key, never persists observations, rejects malformed/non-maritime records, expires after fifteen seconds, and reports the selected-region limitation with every vessel result.

Local discovery, two-step invocation, result polling, and cancellation are exposed only on VoidCat's loopback middleware under `/api/hunter-seeker`. No MCP socket or external listener is opened.

## Deliberate exclusions

- No shell, PTY, scanner, arbitrary URL fetch, dynamic binary, or command-defined tool exists.
- No MCP server or external socket is opened.
- No historical observation or persistent tool-result store exists.
- No AIS credential crosses the protected-process boundary.
