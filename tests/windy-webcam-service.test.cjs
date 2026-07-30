/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const { WindyWebcamService } = require("../desktop/windy-webcam-service.cjs");

function store() {
  const values = new Map();
  return { get: (n, k) => values.get(`${n}:${k}`) ?? null, set: (n, k, v) => values.set(`${n}:${k}`, v), delete: (n, k) => values.delete(`${n}:${k}`), describe: (n, k) => ({ stored: values.has(`${n}:${k}`), fingerprint: values.has(`${n}:${k}`) ? "WINDYSAFE1" : null, updatedAt: null }) };
}

test("Windy remains an independent protected regional webcam layer", async () => {
  const requests = [];
  const camera = { webcamId: "windy-7", title: "Harbor Camera", location: { latitude: 33.75, longitude: -118.2, city: "Long Beach", country: "United States" }, player: { day: "https://webcams.windy.com/webcams/public/embed/player/windy-7/day" }, urls: { detail: "https://www.windy.com/webcams/windy-7" } };
  const service = new WindyWebcamService({ credentialStore: store(), now: () => Date.parse("2026-07-30T12:00:00Z"), fetchImpl: async (url, init) => {
    requests.push({ url: String(url), key: init.headers["X-Windy-API-Key"] });
    return new Response(JSON.stringify({ total: 1, webcams: [camera] }), { status: 200 });
  } });
  await service.configure("windy-secret-key");
  const first = await service.loadRegion("30/-120");
  const second = await service.loadRegion("30/-120");
  assert.equal(first.observations.length, 1);
  assert.equal(first.observations[0].provenance.sourceFeedId, "windy.public-webcams");
  assert.equal(first.observations[0].attributes.playerMode, "timelapse-day");
  assert.equal(second.cacheState, "cached");
  assert.ok(requests.every((request) => request.key === "windy-secret-key" && !request.url.includes("windy-secret-key")));
  assert.equal(requests.length, 2, "credential verification and one regional fetch; cached reload makes no request");
});
