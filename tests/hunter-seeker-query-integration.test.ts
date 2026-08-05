/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0.
 * See LICENSE and NOTICE for attribution requirements. Original Code: VoidCat Harness.
 * Initial Developer: iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { HunterSeekerService } from "../build/hunter-seeker/hunter-seeker-service.ts";
import { HunterSeekerToolRuntime } from "../build/hunter-seeker/hunter-seeker-tools.ts";
import { openMeteoProvider } from "../build/hunter-seeker/query-providers/weather-query-providers.ts";
import { HunterSourceQueryRegistry } from "../build/hunter-seeker/source-query.ts";
import { VoidCatJobManager } from "../build/voidcat-job-manager.ts";
import { VoidCatToolRegistry } from "../build/voidcat-tool-registry.ts";

test("a bounded provider query reaches the map snapshot, refresh path, persistence subscriber, and active UNIT with citations", async () => {
  let now = Date.now(); const nowIso = new Date(now).toISOString(); let fetchCount = 0;
  const queryRegistry = new HunterSourceQueryRegistry({
    providers: [openMeteoProvider],
    now: () => now,
    fetchImplementation: async () => { fetchCount += 1; return new Response(JSON.stringify({
      latitude: 35.4676, longitude: -97.5164, elevation: 367, timezone: "UTC",
      current: { time: nowIso, temperature_2m: 34.2, wind_speed_10m: 21, weather_code: 3 },
      current_units: { temperature_2m: "°C", wind_speed_10m: "km/h" },
    }), { status: 200, headers: { "content-type": "application/json" } }); },
  });
  const service = new HunterSeekerService([], { queryRegistry });
  const published: string[] = [];
  const unsubscribe = service.subscribeObservations((_sourceId, observations) => published.push(...observations.map((observation) => observation.observationId)));
  const toolRegistry = new VoidCatToolRegistry();
  const jobs = new VoidCatJobManager({ maximumConcurrentJobs: 1, minimumUpdateIntervalMs: 0 });
  const runtime = new HunterSeekerToolRuntime(service, toolRegistry, jobs);
  runtime.register();
  try {
    const output = await service.querySource({ sourceId: "openmeteo.weather", point: { latitude: 35.4676, longitude: -97.5164, radiusKm: 25 }, limit: 10 });
    const observation = output.result.observations[0];
    assert.ok(observation);
    assert.equal(output.snapshot.sourceQueries[0]?.sourceId, "openmeteo.weather");
    assert.equal(output.snapshot.observations[0]?.commonEvent?.source, "openmeteo.weather");
    assert.deepEqual(published, [observation.observationId]);
    now += 5_001;
    const refreshed = await service.refreshSource("openmeteo.weather");
    assert.equal(fetchCount, 2);
    assert.equal(refreshed.sourceQueries[0]?.sourceId, "openmeteo.weather");

    const result = await toolRegistry.invoke<{ observationIds: string[]; observations: Array<{ observationId: string; citation: string }> }>("hunter-seeker.events-in-bbox", {
      south: 35, west: -98, north: 36, east: -97, sourceIds: ["openmeteo.weather"], maxAgeMinutes: 60, limit: 10,
    });
    assert.deepEqual(result.observationIds, [observation.observationId]);
    assert.equal(result.observations[0]?.observationId, observation.observationId);
    assert.equal(result.observations[0]?.citation, `[HS:${observation.observationId}]`);
  } finally {
    runtime.unregister(); unsubscribe(); await service.stop();
  }
});
