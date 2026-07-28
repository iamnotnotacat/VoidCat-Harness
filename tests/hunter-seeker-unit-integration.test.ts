import assert from "node:assert/strict";
import test from "node:test";
import type { NormalizedObservation, SourceAdapter } from "../build/hunter-seeker/source-adapter.ts";
import { HunterSeekerService } from "../build/hunter-seeker/hunter-seeker-service.ts";
import { HunterSeekerToolRuntime } from "../build/hunter-seeker/hunter-seeker-tools.ts";
import { fitMessagesToContext, hunterToolAlias, markUncitedHunterFindings, registryNameForHunterAlias, validateHunterCitations } from "../build/hunter-seeker/hunter-seeker-chat-tools.ts";
import { VoidCatJobManager } from "../build/voidcat-job-manager.ts";
import { VoidCatToolRegistry } from "../build/voidcat-tool-registry.ts";

test("a managed UNIT-style loop discovers a live tool and returns verifiable evidence", async () => {
  const timestamp = new Date().toISOString();
  const observation: NormalizedObservation = {
    observationId: "integration:aircraft:one", entityId: "aircraft:abc123", entityType: "civilian-aircraft",
    position: { latitude: 30, longitude: -90, altitudeMeters: 9_000 }, timestamp,
    provenance: { sourceFeedId: "test.integration", fetchedAt: timestamp, receivedAt: timestamp, upstreamTimestamp: timestamp, stalenessMs: 0 },
    confidence: 0.9, basis: "measured", retentionClass: "bulk", attributes: { callsign: "VC101", transponderHex: "ABC123" },
  };
  const adapter: SourceAdapter = {
    descriptor: { id: "test.integration", displayName: "Integration Feed", category: "aviation", authTier: "tier-1", credentialType: "none", pollCadenceMs: 120_000, rateLimit: { requestsPerWindow: 10, windowMs: 60_000, hardHourlyBudget: 60 }, providerDocsUrl: "https://example.test", cache: { ttlMs: 600_000, maxObservations: 10 }, retentionPolicy: { mode: "live-only" }, estimatedBytesPerDay: 1_000 },
    async fetch() { return {}; }, normalize() { return [observation]; }, health() { return { status: "healthy" }; },
  };
  const service = new HunterSeekerService([adapter]);
  const registry = new VoidCatToolRegistry();
  const jobs = new VoidCatJobManager({ maximumConcurrentJobs: 1, minimumUpdateIntervalMs: 0 });
  const runtime = new HunterSeekerToolRuntime(service, registry, jobs);
  runtime.register();
  try {
    await service.start();
    const discovered = runtime.discover();
    const alias = hunterToolAlias("hunter-seeker.aircraft-in-bbox");
    assert.equal(registryNameForHunterAlias(alias, discovered), "hunter-seeker.aircraft-in-bbox");
    const handle = jobs.start({
      module: "hunter-seeker", name: "unit-integration", caps: { maxIterations: 4, timeoutMs: 2_000, maxExternalCalls: 2 },
      run: async (context) => {
        context.consumeIteration();
        const result = await context.externalCall(() => runtime.invokeInManagedContext("hunter-seeker.aircraft-in-bbox", { south: 20, west: -100, north: 40, east: -80 }, context, { kind: "agent", id: context.jobId, modelLane: "test-unit-under-7gb" }));
        for (const contextWindow of [4_096, 32_768]) {
          const messages = fitMessagesToContext([{ role: "system", content: "Use exact citations." }, { role: "tool", content: JSON.stringify(result) }], contextWindow, 512);
          assert.ok(Buffer.byteLength(JSON.stringify(messages), "utf8") <= contextWindow);
        }
        const answer = markUncitedHunterFindings("VC101 is in the requested area [HS:integration:aircraft:one]. Another aircraft is nearby.", [result]);
        assert.equal(validateHunterCitations(answer, [result]).valid, true);
        return answer;
      },
    });
    const answer = await handle.result;
    assert.match(answer, /\[HS:integration:aircraft:one\]/);
    assert.match(answer, /Another aircraft is nearby \[UNSUPPORTED\]\./);
    assert.equal(handle.snapshot().status, "completed");
  } finally {
    runtime.unregister();
    await service.stop();
  }
});
