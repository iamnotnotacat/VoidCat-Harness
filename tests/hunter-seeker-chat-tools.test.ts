import assert from "node:assert/strict";
import test from "node:test";
import type { DiscoveredTool } from "../build/voidcat-tool-registry.ts";
import { boundHunterToolResult, fitMessagesToContext, hunterToolAlias, hunterToolSystemBoundary, hunterToolsForModel, markUncitedHunterFindings, registryNameForHunterAlias, renderHunterEvidenceFallback, safeHunterCitationFailure, validateHunterCitations } from "../build/hunter-seeker/hunter-seeker-chat-tools.ts";

const tool: DiscoveredTool = {
  name: "hunter-seeker.aircraft-in-bbox",
  module: "hunter-seeker",
  description: "A sufficiently descriptive bounded live-only test tool.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  rateLimit: { invocations: 30, windowMs: 60_000 },
  maxInputBytes: 1_024,
  maxOutputBytes: 1_024,
  enabled: true,
};

test("model aliases are provider-safe and reverse only through discovery", () => {
  assert.equal(hunterToolAlias(tool.name), "hunter-seeker_aircraft-in-bbox");
  assert.equal(hunterToolsForModel([tool])[0].function.name, "hunter-seeker_aircraft-in-bbox");
  assert.equal(registryNameForHunterAlias("hunter-seeker_aircraft-in-bbox", [tool]), tool.name);
  assert.equal(registryNameForHunterAlias("unregistered_tool", [tool]), undefined);
});

test("the UNIT boundary names exact approved functions without duplicating input schemas", () => {
  const boundary = hunterToolSystemBoundary([tool]);
  assert.match(boundary, /hunter-seeker_aircraft-in-bbox/);
  assert.doesNotMatch(boundary, /Input JSON/);
  assert.match(boundary, /never request a generic 'Hunter-Seeker' tool/);
});

test("citation validation accepts exact observation ids and rejects invented ids", () => {
  const results = [{ observations: [{ observationId: "air:one" }, { observationId: "air:two" }] }];
  assert.equal(validateHunterCitations("Current contact [HS:air:one].", results).valid, true);
  const invalid = validateHunterCitations("Invented contact [HS:air:three].", results);
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join(" "), /air:three/);
  assert.match(safeHunterCitationFailure(invalid.errors), /withheld/i);
});

test("citation validation requires grounding when a tool returned observations", () => {
  assert.equal(validateHunterCitations("A contact exists.", [{ observations: [{ observationId: "air:one" }] }]).valid, false);
  assert.equal(validateHunterCitations("No result in this bounded pull.", [{ observations: [] }]).valid, true);
});

test("each uncited factual sentence is explicitly marked unsupported", () => {
  const results = [{ observations: [{ observationId: "air:one" }] }];
  const marked = markUncitedHunterFindings("Contact one is current [HS:air:one]. A second contact is nearby.\nOperational summary", results);
  assert.match(marked, /current \[HS:air:one\]\./);
  assert.match(marked, /second contact is nearby \[UNSUPPORTED\]\./);
  assert.match(marked, /Operational summary \[UNSUPPORTED\]/);
  assert.equal(validateHunterCitations(marked, results).valid, true);
});

test("tool evidence and conversation history are bounded to the active context window", () => {
  const observationIds = Array.from({ length: 100 }, (_, index) => `air:${index}`);
  const bounded = boundHunterToolResult({ observationIds, observations: observationIds.map((observationId) => ({ observationId, detail: "x".repeat(200) })), truncated: false }, 2_000) as { observationIds: string[]; observations: Array<{ observationId: string }>; truncated: boolean };
  assert.ok(bounded.observations.length < 100);
  assert.deepEqual(bounded.observationIds, bounded.observations.map((observation) => observation.observationId));
  assert.equal(bounded.truncated, true);
  const messages = fitMessagesToContext([
    { role: "system", content: "boundary" },
    { role: "user", content: "old".repeat(5_000) },
    { role: "user", content: "latest request" },
  ], 2_048, 512);
  assert.equal(messages[0].role, "system");
  assert.equal(messages.at(-1)?.content, "latest request");
  assert.ok(JSON.stringify(messages).length < 6_500);
});

test("feed-health evidence has exact citations and a safe deterministic UNIT fallback", () => {
  const result = {
    observationIds: ["feed-health:test:2026-07-27T00:00:00.000Z"],
    sources: [{
      observationId: "feed-health:test:2026-07-27T00:00:00.000Z",
      citation: "[HS:feed-health:test:2026-07-27T00:00:00.000Z]",
      id: "test",
      name: "Test Feed",
      status: "healthy",
      cachedObservations: 12,
    }],
  };
  const fallback = renderHunterEvidenceFallback([result]);
  assert.match(fallback, /Test Feed is HEALTHY with 12 volatile records/);
  assert.equal(validateHunterCitations(fallback, [result]).valid, true);
  const bounded = boundHunterToolResult({ ...result, observationIds: Array.from({ length: 200 }, (_, index) => `feed:${index}`) }, 500) as { observationIds: string[]; truncated: boolean };
  assert.ok(bounded.observationIds.length < 200);
  assert.equal(bounded.truncated, true);
});
