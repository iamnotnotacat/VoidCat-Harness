/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const { PublicWebcamService, regionFromId, normalizeLiveVideo } = require("../desktop/public-webcam-service.cjs");

function credentialStore() {
  const values = new Map();
  return {
    get(namespace, key) { return values.get(`${namespace}:${key}`) ?? null; },
    set(namespace, key, value) { values.set(`${namespace}:${key}`, value); },
    delete(namespace, key) { return values.delete(`${namespace}:${key}`); },
    describe(namespace, key) { return { stored: values.has(`${namespace}:${key}`), fingerprint: values.has(`${namespace}:${key}`) ? "SAFE123456" : null, updatedAt: null }; },
  };
}

const liveVideo = {
  id: "AbCdEfGhI_1",
  snippet: { title: "Harbor Live Webcam", description: "Continuous public camera", channelTitle: "Port Authority", liveBroadcastContent: "live", thumbnails: { high: { url: "https://i.ytimg.com/vi/AbCdEfGhI_1/hqdefault_live.jpg" } } },
  status: { embeddable: true, privacyStatus: "public" },
  liveStreamingDetails: { actualStartTime: "2026-07-30T10:00:00Z", concurrentViewers: "42" },
  recordingDetails: { location: { latitude: 33.75, longitude: -118.2 } },
};

test("public live-video credentials stay in a header and verified broadcasts are normalized and cached", async () => {
  const store = credentialStore();
  const requests = [];
  const ended = { ...liveVideo, id: "EndedVideo1", liveStreamingDetails: { actualStartTime: "2026-07-29T10:00:00Z", actualEndTime: "2026-07-29T11:00:00Z" }, snippet: { ...liveVideo.snippet, title: "Ended Harbor Webcam", liveBroadcastContent: "none" } };
  const stillFrame = { ...liveVideo, id: "StillFrame1", snippet: { ...liveVideo.snippet, title: "Harbor image", description: "periodic still image", liveBroadcastContent: "none" }, liveStreamingDetails: {} };
  const service = new PublicWebcamService({ credentialStore: store, now: () => Date.parse("2026-07-30T12:00:00Z"), fetchImpl: async (url, init) => {
    requests.push({ url: String(url), key: init.headers["X-Goog-Api-Key"] });
    if (url.pathname.endsWith("/search")) return new Response(JSON.stringify({ pageInfo: { totalResults: 3 }, items: [liveVideo, ended, stillFrame].map((item) => ({ id: { videoId: item.id }, snippet: item.snippet })) }), { status: 200 });
    const ids = url.searchParams.get("id");
    const items = ids === "jNQXAC9IVRw" ? [{ id: "jNQXAC9IVRw" }] : [liveVideo, ended, stillFrame];
    return new Response(JSON.stringify({ items }), { status: 200 });
  } });
  await service.configure("youtube-secret-key");
  const first = await service.loadRegion("30/-120");
  const second = await service.loadRegion("30/-120");
  assert.equal(first.cacheState, "live");
  assert.equal(second.cacheState, "cached");
  assert.equal(first.observations.length, 1);
  assert.equal(first.providerCandidates, 3);
  assert.equal(first.observations[0].attributes.playerMode, "continuous-live-broadcast");
  assert.equal(first.observations[0].attributes.playerUrl, "https://www.youtube-nocookie.com/embed/AbCdEfGhI_1?autoplay=1&mute=1&playsinline=1&rel=0");
  assert.ok(requests.every((request) => request.key === "youtube-secret-key"));
  assert.ok(requests.every((request) => !request.url.includes("youtube-secret-key")));
  assert.doesNotMatch(JSON.stringify(first), /youtube-secret-key/);
  assert.equal(requests.length, 3, "one key test plus search and details; cached reload performs no request");
});

test("still-frame, ended, private, and non-embeddable candidates never enter the continuous-video layer", () => {
  const region = regionFromId("30/-120");
  assert.equal(normalizeLiveVideo({ ...liveVideo, snippet: { ...liveVideo.snippet, liveBroadcastContent: "none" } }, region, "2026-07-30T12:00:00Z"), null);
  assert.equal(normalizeLiveVideo({ ...liveVideo, liveStreamingDetails: { ...liveVideo.liveStreamingDetails, actualEndTime: "2026-07-30T11:00:00Z" } }, region, "2026-07-30T12:00:00Z"), null);
  assert.equal(normalizeLiveVideo({ ...liveVideo, status: { ...liveVideo.status, privacyStatus: "private" } }, region, "2026-07-30T12:00:00Z"), null);
  assert.equal(normalizeLiveVideo({ ...liveVideo, status: { ...liveVideo.status, embeddable: false } }, region, "2026-07-30T12:00:00Z"), null);
});

test("public live-video sectors cannot become arbitrary requests", () => {
  assert.deepEqual(regionFromId("30/-120"), { id: "30/-120", south: 30, west: -120, north: 50, east: -100, latitude: 40, longitude: -110 });
  assert.throws(() => regionFromId("31/-120"), /fixed worldwide index/i);
  assert.throws(() => regionFromId("30/https://example.com"), /valid public-video sector/i);
});
