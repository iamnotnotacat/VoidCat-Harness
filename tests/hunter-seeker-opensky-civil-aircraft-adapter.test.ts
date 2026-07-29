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
  OPENSKY_CIVIL_AIRCRAFT_URL,
  OpenSkyCivilAircraftAdapter,
  calculateOpenSkyCreditCadence,
} from "../build/hunter-seeker/adapters/opensky-civil-aircraft-adapter.ts";

const epoch = Date.parse("2026-07-27T12:00:00.000Z") / 1_000;
const airborne = ["abc123", "DAL123 ", "United States", epoch, epoch, -90, 35, 10_000, false, 250, 90, 5, null, 10_500, "1234", false, 0, 4];
const grounded = ["def456", "GROUND1", "Finland", epoch, epoch, 25, 60, 0, true, 0, 0, 0, null, 0, null, false, 0, 4];
const surfaceVehicle = ["fed321", "SERVICE", "Finland", epoch, epoch, 24, 61, 0, false, 5, 0, 0, null, 0, null, false, 0, 18];

function fetchContext(requestedAt = "2026-07-27T12:01:00.000Z") {
  return { signal: new AbortController().signal, requestedAt };
}

test("OpenSky anonymous adapter normalizes fresh airborne civil-airspace state vectors", async () => {
  let requests = 0;
  const adapter = new OpenSkyCivilAircraftAdapter({
    fetchImplementation: async (input, init) => {
      requests += 1;
      assert.equal(String(input), OPENSKY_CIVIL_AIRCRAFT_URL);
      assert.equal(init?.credentials, "omit");
      assert.equal(new Headers(init?.headers).has("Authorization"), false);
      return new Response(JSON.stringify({ time: epoch, states: [airborne, grounded, surfaceVehicle] }), {
        status: 200,
        headers: { "Content-Type": "application/json", "X-Rate-Limit-Remaining": "396" },
      });
    },
  });

  const payload = await adapter.fetch(fetchContext());
  const observations = adapter.normalize(payload, {
    fetchedAt: "2026-07-27T12:01:00.000Z",
    receivedAt: "2026-07-27T12:01:01.000Z",
  });

  assert.equal(requests, 1);
  assert.equal(payload.remainingCredits, 396);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].observationId, "opensky-aircraft:abc123");
  assert.equal(observations[0].entityId, "aircraft:abc123");
  assert.equal(observations[0].entityType, "civilian-aircraft");
  assert.equal(observations[0].attributes.callsign, "DAL123");
  assert.equal(observations[0].attributes.aircraftCategory, "large-aircraft");
  assert.equal(observations[0].attributes.sourceType, "ads-b");
  assert.equal(observations[0].attributes.remainingAnonymousCredits, 396);
  assert.equal(observations[0].position.altitudeMeters, 10_500);
  assert.ok(Number(observations[0].attributes.groundspeedKnots) > 485);
  assert.equal(observations[0].provenance.stalenessMs, 61_000);
});

test("OpenSky anonymous adapter reuses its snapshot inside the 20-minute provider guard", async () => {
  let requests = 0;
  const adapter = new OpenSkyCivilAircraftAdapter({
    fetchImplementation: async () => {
      requests += 1;
      return new Response(JSON.stringify({ time: epoch, states: [airborne] }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  const first = await adapter.fetch(fetchContext("2026-07-27T12:01:00.000Z"));
  const cached = await adapter.fetch(fetchContext("2026-07-27T12:03:00.000Z"));
  assert.equal(requests, 1);
  assert.equal(cached, first);
  assert.match((await adapter.health()).message ?? "", /snapshot cache/i);
});

test("OpenSky credit guard spreads usable credits across its conservative refill horizon", () => {
  const nowMs = Date.parse("2026-07-27T12:00:00.000Z");
  const full = calculateOpenSkyCreditCadence({ nowMs, remainingCredits: 396 });
  const low = calculateOpenSkyCreditCadence({ nowMs, remainingCredits: 44 });
  const reserved = calculateOpenSkyCreditCadence({ nowMs, remainingCredits: 40 });

  assert.equal(full.requestCostCredits, 4);
  assert.equal(full.reserveCredits, 40);
  assert.equal(full.effectiveRefreshMs, Math.ceil((24 * 60 * 60_000) / 89));
  assert.ok(low.effectiveRefreshMs > full.effectiveRefreshMs);
  assert.equal(reserved.effectiveRefreshMs, 24 * 60 * 60_000);
  assert.equal(full.basis, "rolling-24-hour-estimate");
});

test("OpenSky adapter applies its calculated credit cadence to real network pulls", async () => {
  let requests = 0;
  const adapter = new OpenSkyCivilAircraftAdapter({
    fetchImplementation: async () => {
      requests += 1;
      return new Response(JSON.stringify({ time: epoch, states: [airborne] }), {
        status: 200,
        headers: { "Content-Type": "application/json", "X-Rate-Limit-Remaining": String(400 - requests * 4) },
      });
    },
  });

  await adapter.fetch(fetchContext("2026-07-27T12:00:00.000Z"));
  await adapter.fetch(fetchContext("2026-07-27T12:16:00.000Z"));
  assert.equal(requests, 1);
  await adapter.fetch(fetchContext("2026-07-27T12:17:00.000Z"));
  assert.equal(requests, 2);
});

test("OpenSky exact retry-after overrides the estimated anonymous credit window", () => {
  const cadence = calculateOpenSkyCreditCadence({
    nowMs: Date.parse("2026-07-27T12:00:00.000Z"),
    remainingCredits: 0,
    retryAfterMs: 3_600_000,
  });
  assert.equal(cadence.effectiveRefreshMs, 3_600_000);
  assert.equal(cadence.timeUntilEstimatedRefillMs, 3_600_000);
  assert.equal(cadence.basis, "provider-retry-after");
});

test("OpenSky anonymous adapter honors credit retry headers and response size limits", async () => {
  const rateLimited = new OpenSkyCivilAircraftAdapter({
    fetchImplementation: async () => new Response("{}", { status: 429, headers: { "X-Rate-Limit-Retry-After-Seconds": "3600" } }),
  });
  await assert.rejects(
    () => rateLimited.fetch(fetchContext()),
    (error: unknown) => error instanceof Error && /HTTP 429/.test(error.message) && "retryAfterMs" in error && error.retryAfterMs === 3_600_000,
  );

  const oversized = new OpenSkyCivilAircraftAdapter({
    fetchImplementation: async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json", "Content-Length": "12000001" } }),
  });
  await assert.rejects(() => oversized.fetch(fetchContext()), /byte safety limit/i);
});
