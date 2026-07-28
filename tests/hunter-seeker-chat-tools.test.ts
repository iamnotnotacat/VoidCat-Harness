import assert from "node:assert/strict";
import test from "node:test";
import type { DiscoveredTool } from "../build/voidcat-tool-registry.ts";
import { boundHunterToolResult, fitMessagesToContext, hunterToolAlias, hunterToolsForModel, registryNameForHunterAlias, safeHunterCitationFailure, validateHunterCitations } from "../build/hunter-seeker/hunter-seeker-chat-tools.ts";

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

test("tool evidence and conversation history are bounded to the active context window", () => {
  const bounded = boundHunterToolResult({ observations: Array.from({ length: 100 }, (_, index) => ({ observationId: `air:${index}`, detail: "x".repeat(200) })), truncated: false }, 2_000) as { observations: unknown[]; truncated: boolean };
  assert.ok(bounded.observations.length < 100);
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
