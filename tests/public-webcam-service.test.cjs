/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const { PublicWebcamService, regionFromId, regionFromCoordinates, normalizeLiveVideo } = require("../desktop/public-webcam-service.cjs");

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

test("global discovery publishes only sectors backed by located, active live cameras and reuses its bounded cache", async () => {
  const store = credentialStore();
  store.set("vc-hunter-seeker.youtube-live", "api-key", "youtube-secret-key");
  const requests = [];
  const unlocated = { ...liveVideo, id: "NoLocation1", recordingDetails: {} };
  const nullLocation = { ...liveVideo, id: "NullCoords1", recordingDetails: { location: { latitude: null, longitude: null } } };
  const secondInSameSector = { ...liveVideo, id: "SecondCam_1", recordingDetails: { location: { latitude: 39.1, longitude: -105.2 } } };
  const differentSector = { ...liveVideo, id: "EuropeCam_1", recordingDetails: { location: { latitude: 48.8, longitude: 2.3 } } };
  const ended = { ...liveVideo, id: "EndedVideo1", snippet: { ...liveVideo.snippet, liveBroadcastContent: "none" }, liveStreamingDetails: { ...liveVideo.liveStreamingDetails, actualEndTime: "2026-07-30T11:00:00Z" } };
  const candidates = [liveVideo, unlocated, nullLocation, secondInSameSector, differentSector, ended];
  const service = new PublicWebcamService({ credentialStore: store, now: () => Date.parse("2026-07-30T12:00:00Z"), fetchImpl: async (url) => {
    requests.push(String(url));
    if (url.pathname.endsWith("/search")) {
      assert.equal(url.searchParams.has("location"), false, "discovery must be one bounded global search, not a worldwide sector crawl");
      return new Response(JSON.stringify({ pageInfo: { totalResults: 6 }, items: candidates.map((item) => ({ id: { videoId: item.id }, snippet: item.snippet })) }), { status: 200 });
    }
    return new Response(JSON.stringify({ items: candidates }), { status: 200 });
  } });

  const first = await service.discoverRegions();
  const second = await service.discoverRegions();
  assert.equal(first.cacheState, "live");
  assert.equal(second.cacheState, "cached");
  assert.equal(first.confirmedLiveStreams, 3, "unlocated, null-coordinate, and ended broadcasts cannot support a sector");
  assert.equal(first.returned, 2, "multiple live cameras in one sector produce one sector hub");
  assert.equal(first.observations.length, 2);
  assert.ok(first.observations.every((observation) => observation.entityType === "imagery.public-webcam-region"));
  assert.ok(first.observations.every((observation) => observation.attributes.confirmedLiveStreams >= 1));
  assert.equal(Math.max(...first.observations.map((observation) => observation.attributes.confirmedLiveStreams)), 2);
  assert.equal(requests.length, 2, "one search and one details request; cached discovery performs no request");
});

test("public live-video sectors cannot become arbitrary requests", () => {
  assert.deepEqual(regionFromId("30/-120"), { id: "30/-120", south: 30, west: -120, north: 50, east: -100, latitude: 40, longitude: -110 });
  assert.equal(regionFromCoordinates(90, 180).id, "70/160");
  assert.equal(regionFromCoordinates(-90, -180).id, "-90/-180");
  assert.equal(regionFromCoordinates(Number.NaN, 0), null);
  assert.throws(() => regionFromId("31/-120"), /fixed worldwide index/i);
  assert.throws(() => regionFromId("30/https://example.com"), /valid public-video sector/i);
});
