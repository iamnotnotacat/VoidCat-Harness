/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
const { createHash } = require("node:crypto");

const API_ORIGIN = "https://www.googleapis.com";
const SEARCH_PATH = "/youtube/v3/search";
const VIDEOS_PATH = "/youtube/v3/videos";
const CREDENTIAL_NAMESPACE = "vc-hunter-seeker.youtube-live";
const CREDENTIAL_KEY = "api-key";
const SOURCE_ID = "youtube.live-webcams";
const MAX_RESULTS = 50;
const MAX_RESPONSE_BYTES = 4_000_000;
const CACHE_MS = 15 * 60_000;
const DISCOVERY_CACHE_MS = 15 * 60_000;
const REGION_DEGREES = 20;
const SEARCH_RADIUS = "1000km";
const MAX_REGION_SEARCHES_PER_DAY = 50;
const CAMERA_TERMS = /\b(webcam|web cam|live cam|camera|traffic cam|weather cam|beach cam|harbor cam|harbour cam)\b/i;

function credentialFingerprint(value) {
  return value ? createHash("sha256").update(value).digest("hex").slice(0, 10).toUpperCase() : null;
}

function regionFromId(id) {
  if (typeof id !== "string" || !/^-?\d+\/-?\d+$/.test(id)) throw new Error("A valid public-video sector is required.");
  const [south, west] = id.split("/").map(Number);
  if (!Number.isInteger(south) || !Number.isInteger(west) || south < -90 || south >= 90 || west < -180 || west >= 180 || (south + 90) % REGION_DEGREES || (west + 180) % REGION_DEGREES) throw new Error("The public-video sector is outside the fixed worldwide index.");
  const north = Math.min(90, south + REGION_DEGREES);
  const east = Math.min(180, west + REGION_DEGREES);
  return { id, south, west, north, east, latitude: (south + north) / 2, longitude: (west + east) / 2 };
}

function regionFromCoordinates(latitude, longitude) {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
  const latitudeBand = Math.min(8, Math.floor((latitude + 90) / REGION_DEGREES));
  const longitudeBand = Math.min(17, Math.floor((longitude + 180) / REGION_DEGREES));
  return regionFromId(`${-90 + latitudeBand * REGION_DEGREES}/${-180 + longitudeBand * REGION_DEGREES}`);
}

function regionLabel(region) {
  const latitude = region.latitude;
  const longitude = region.longitude;
  const lat = `${Math.abs(latitude).toFixed(0)}°${latitude < 0 ? "S" : "N"}`;
  const lon = `${Math.abs(longitude).toFixed(0)}°${longitude < 0 ? "W" : "E"}`;
  return `YOUTUBE LIVE SECTOR ${lat} ${lon}`;
}

function boundedText(value, limit = 500) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim().slice(0, limit) : "";
}

function coordinateNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
}

function redactSecret(text, credential) {
  const value = boundedText(text, 500);
  return credential ? value.split(credential).join("[REDACTED]") : value;
}

function safeThumbnail(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && (url.hostname === "i.ytimg.com" || url.hostname.endsWith(".ytimg.com")) ? url.toString() : "";
  } catch { return ""; }
}

function normalizeLiveVideo(item, region, fetchedAt, { requireExactLocation = false } = {}) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const id = boundedText(item.id, 20);
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
  const snippet = item.snippet && typeof item.snippet === "object" ? item.snippet : {};
  const live = item.liveStreamingDetails && typeof item.liveStreamingDetails === "object" ? item.liveStreamingDetails : {};
  const status = item.status && typeof item.status === "object" ? item.status : {};
  const title = boundedText(snippet.title, 180);
  const description = boundedText(snippet.description, 600);
  const startedAt = boundedText(live.actualStartTime, 80);
  if (snippet.liveBroadcastContent !== "live" || !startedAt || live.actualEndTime || status.embeddable !== true || status.privacyStatus !== "public" || !CAMERA_TERMS.test(`${title} ${description}`)) return null;
  const recorded = item.recordingDetails && typeof item.recordingDetails === "object" ? item.recordingDetails : {};
  const location = recorded.location && typeof recorded.location === "object" ? recorded.location : {};
  const latitude = coordinateNumber(location.latitude);
  const longitude = coordinateNumber(location.longitude);
  // The search endpoint guarantees that a result is located within the requested
  // radius. Exact uploader coordinates are preferred; a sector-center fallback is
  // explicitly marked approximate so it is never mistaken for a surveyed camera.
  const hasExactLocation = Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
  if (requireExactLocation && !hasExactLocation) return null;
  const position = hasExactLocation ? { latitude, longitude } : { latitude: region.latitude, longitude: region.longitude };
  const thumbnails = snippet.thumbnails && typeof snippet.thumbnails === "object" ? snippet.thumbnails : {};
  const thumbnail = thumbnails.high ?? thumbnails.medium ?? thumbnails.default ?? {};
  return {
    observationId: `${SOURCE_ID}:broadcast:${id}`,
    entityId: `public-webcam:youtube:${id}`,
    entityType: "imagery.public-webcam",
    position,
    timestamp: fetchedAt,
    provenance: { sourceFeedId: SOURCE_ID, fetchedAt, receivedAt: fetchedAt, stalenessMs: 0 },
    confidence: hasExactLocation ? 0.9 : 0.68,
    basis: hasExactLocation ? "measured" : "inferred",
    retentionClass: "bulk",
    attributes: {
      title: title || `LIVE PUBLIC VIDEO ${id}`,
      webcamId: id,
      regionId: region.id,
      channelTitle: boundedText(snippet.channelTitle, 120),
      actualStartTime: startedAt,
      concurrentViewers: Number(live.concurrentViewers) || null,
      liveAvailable: true,
      playerUrl: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=1&playsinline=1&rel=0`,
      playerMode: "continuous-live-broadcast",
      imageUrl: safeThumbnail(thumbnail.url),
      eventUrl: `https://www.youtube.com/watch?v=${id}`,
      sourceName: "YouTube Data API",
      positionAccuracy: hasExactLocation ? "uploader-supplied" : "regional-search-center",
      coverageLimitation: `Only public, embeddable, currently active YouTube broadcasts matching camera terms and associated with the selected ${SEARCH_RADIUS} search radius are shown. Approximate markers represent a regional match when the broadcaster does not expose exact coordinates. Absence is not evidence that no public camera exists.`,
    },
  };
}

class PublicWebcamService {
  constructor({ credentialStore, fetchImpl = fetch, now = Date.now } = {}) {
    if (!credentialStore) throw new Error("Public webcam service requires protected credential storage.");
    this.credentialStore = credentialStore;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.cache = new Map();
    this.discoveryCache = null;
    this.regionSearchTimes = [];
  }

  credential() { return this.credentialStore.get(CREDENTIAL_NAMESPACE, CREDENTIAL_KEY); }

  status() {
    const credential = this.credential();
    const description = this.credentialStore.describe(CREDENTIAL_NAMESPACE, CREDENTIAL_KEY);
    this.pruneRequestTimes();
    return { configured: Boolean(credential), fingerprint: description.fingerprint ?? credentialFingerprint(credential), updatedAt: description.updatedAt ?? null, cachedRegions: this.cache.size, discoveryCached: Boolean(this.discoveryCache && this.discoveryCache.expiresAt > this.now()), regionSearchesRemaining: Math.max(0, MAX_REGION_SEARCHES_PER_DAY - this.regionSearchTimes.length) };
  }

  pruneRequestTimes() {
    const cutoff = this.now() - 24 * 60 * 60_000;
    this.regionSearchTimes = this.regionSearchTimes.filter((value) => value > cutoff);
  }

  async request(url, credential, signal) {
    if (url.origin !== API_ORIGIN || (url.pathname !== SEARCH_PATH && url.pathname !== VIDEOS_PATH)) throw new Error("Public live-video request attempted to leave the fixed YouTube Data API endpoints.");
    const response = await this.fetchImpl(url, { method: "GET", redirect: "error", credentials: "omit", headers: { Accept: "application/json", "X-Goog-Api-Key": credential, "User-Agent": "VoidCat-Harness/1.0 (operator-selected public live-video sector)" }, signal });
    if (!response.ok) {
      const raw = redactSecret(await response.text().catch(() => ""), credential);
      if (response.status === 400 || response.status === 401 || response.status === 403) throw new Error(`YouTube rejected the API key or request${raw ? `: ${raw.slice(0, 160)}` : "."}`);
      throw new Error(`YouTube Data API returned HTTP ${response.status}.`);
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("YouTube Data API response exceeded the safety limit.");
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) throw new Error("YouTube Data API response exceeded the safety limit.");
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.items)) throw new Error("YouTube Data API returned a malformed response.");
    return parsed;
  }

  async testCredential(value) {
    const credential = boundedText(value, 512);
    if (!/^[\x21-\x7e]{8,512}$/.test(credential) || /[\s?#]/.test(credential)) throw new Error("YouTube Data API key format is invalid.");
    const url = new URL(VIDEOS_PATH, API_ORIGIN);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("id", "jNQXAC9IVRw");
    await this.request(url, credential, AbortSignal.timeout(20_000));
    return { valid: true, verifiedBy: "YouTube Data API", fingerprint: credentialFingerprint(credential) };
  }

  async configure(value) {
    const tested = await this.testCredential(value);
    this.cache.clear();
    this.discoveryCache = null;
    this.credentialStore.set(CREDENTIAL_NAMESPACE, CREDENTIAL_KEY, boundedText(value, 512));
    return { ...this.status(), valid: true, verifiedBy: tested.verifiedBy };
  }

  remove() {
    this.cache.clear();
    this.discoveryCache = null;
    this.regionSearchTimes = [];
    this.credentialStore.delete(CREDENTIAL_NAMESPACE, CREDENTIAL_KEY);
    return this.status();
  }

  async discoverRegions() {
    if (this.discoveryCache && this.discoveryCache.expiresAt > this.now()) {
      return { ...this.discoveryCache.value, cacheState: "cached", regionSearchesRemaining: this.status().regionSearchesRemaining };
    }
    const credential = this.credential();
    if (!credential) throw new Error("Connect a YouTube Data API key before discovering public live-video sectors.");
    this.pruneRequestTimes();
    if (this.regionSearchTimes.length >= MAX_REGION_SEARCHES_PER_DAY) throw new Error("The local 24-hour public-video search budget is exhausted. Cached sectors remain available.");

    const fetchedAt = new Date(this.now()).toISOString();
    const searchUrl = new URL(SEARCH_PATH, API_ORIGIN);
    searchUrl.searchParams.set("part", "snippet");
    searchUrl.searchParams.set("type", "video");
    searchUrl.searchParams.set("eventType", "live");
    searchUrl.searchParams.set("videoEmbeddable", "true");
    searchUrl.searchParams.set("videoSyndicated", "true");
    searchUrl.searchParams.set("q", "webcam|live camera|traffic camera|weather camera|beach camera|harbor camera");
    searchUrl.searchParams.set("maxResults", String(MAX_RESULTS));
    this.regionSearchTimes.push(this.now());
    const search = await this.request(searchUrl, credential, AbortSignal.timeout(25_000));
    const ids = [...new Set(search.items.map((item) => boundedText(item?.id?.videoId, 20)).filter((id) => /^[A-Za-z0-9_-]{11}$/.test(id)))];
    let details = [];
    if (ids.length) {
      const videosUrl = new URL(VIDEOS_PATH, API_ORIGIN);
      videosUrl.searchParams.set("part", "snippet,liveStreamingDetails,recordingDetails,status");
      videosUrl.searchParams.set("id", ids.join(","));
      const response = await this.request(videosUrl, credential, AbortSignal.timeout(25_000));
      details = response.items;
    }

    const liveStreams = details.map((item) => {
      const latitude = coordinateNumber(item?.recordingDetails?.location?.latitude);
      const longitude = coordinateNumber(item?.recordingDetails?.location?.longitude);
      const region = regionFromCoordinates(latitude, longitude);
      return region ? normalizeLiveVideo(item, region, fetchedAt, { requireExactLocation: true }) : null;
    }).filter(Boolean);
    const streamsByRegion = new Map();
    liveStreams.forEach((observation) => {
      const regionId = observation.attributes.regionId;
      const group = streamsByRegion.get(regionId) ?? [];
      group.push(observation);
      streamsByRegion.set(regionId, group);
    });
    const observations = [...streamsByRegion.entries()].map(([regionId, streams]) => {
      const region = regionFromId(regionId);
      return {
        observationId: `${SOURCE_ID}:region:${region.id}`,
        entityId: `public-webcam-region:${region.id}`,
        entityType: "imagery.public-webcam-region",
        position: { latitude: region.latitude, longitude: region.longitude },
        timestamp: fetchedAt,
        provenance: { sourceFeedId: SOURCE_ID, fetchedAt, receivedAt: fetchedAt, stalenessMs: 0 },
        confidence: 0.9,
        basis: "derived",
        retentionClass: "bulk",
        attributes: {
          title: regionLabel(region),
          regionId: region.id,
          regionLabel: regionLabel(region),
          regionBounds: { south: region.south, west: region.west, north: region.north, east: region.east },
          confirmedLiveStreams: streams.length,
          sourceName: "YouTube Live discovery",
          coverageLimitation: `This sector is shown because the bounded discovery sample contained ${streams.length} public, embeddable, actively live camera broadcast${streams.length === 1 ? "" : "s"} with uploader-supplied coordinates in it. Discovery inspects at most ${MAX_RESULTS} candidates and is not a complete census.`,
        },
      };
    });
    const value = {
      fetchedAt,
      providerCandidates: ids.length,
      confirmedLiveStreams: liveStreams.length,
      returned: observations.length,
      truncated: Number(search.pageInfo?.totalResults) > MAX_RESULTS,
      observations,
      provider: "YouTube Live",
      coverageLimitation: `Only sectors supported by an actively live, public, embeddable camera broadcast with uploader-supplied coordinates in the bounded ${MAX_RESULTS}-candidate discovery sample are shown. Missing sectors may still contain cameras outside this sample.`,
    };
    this.discoveryCache = { expiresAt: this.now() + DISCOVERY_CACHE_MS, value };
    return { ...value, cacheState: "live", regionSearchesRemaining: Math.max(0, MAX_REGION_SEARCHES_PER_DAY - this.regionSearchTimes.length) };
  }

  async loadRegion(regionId) {
    const region = regionFromId(regionId);
    const cached = this.cache.get(region.id);
    if (cached && cached.expiresAt > this.now()) return { ...cached.value, cacheState: "cached", regionSearchesRemaining: this.status().regionSearchesRemaining };
    const credential = this.credential();
    if (!credential) throw new Error("Connect a YouTube Data API key before loading public live video.");
    this.pruneRequestTimes();
    if (this.regionSearchTimes.length >= MAX_REGION_SEARCHES_PER_DAY) throw new Error("The local 24-hour public-video search budget is exhausted. Cached sectors remain available.");
    const fetchedAt = new Date(this.now()).toISOString();
    const searchUrl = new URL(SEARCH_PATH, API_ORIGIN);
    searchUrl.searchParams.set("part", "snippet");
    searchUrl.searchParams.set("type", "video");
    searchUrl.searchParams.set("eventType", "live");
    searchUrl.searchParams.set("videoEmbeddable", "true");
    searchUrl.searchParams.set("videoSyndicated", "true");
    searchUrl.searchParams.set("q", "webcam OR live camera");
    searchUrl.searchParams.set("location", `${region.latitude},${region.longitude}`);
    searchUrl.searchParams.set("locationRadius", SEARCH_RADIUS);
    searchUrl.searchParams.set("maxResults", String(MAX_RESULTS));
    this.regionSearchTimes.push(this.now());
    const search = await this.request(searchUrl, credential, AbortSignal.timeout(25_000));
    const ids = [...new Set(search.items.map((item) => boundedText(item?.id?.videoId, 20)).filter((id) => /^[A-Za-z0-9_-]{11}$/.test(id)))];
    let details = [];
    if (ids.length) {
      const videosUrl = new URL(VIDEOS_PATH, API_ORIGIN);
      videosUrl.searchParams.set("part", "snippet,liveStreamingDetails,recordingDetails,status");
      videosUrl.searchParams.set("id", ids.join(","));
      const response = await this.request(videosUrl, credential, AbortSignal.timeout(25_000));
      details = response.items;
    }
    const observations = [...new Map(details.map((item) => {
      const observation = normalizeLiveVideo(item, region, fetchedAt);
      return observation ? [observation.observationId, observation] : ["", null];
    }).filter(([id, observation]) => id && observation)).values()];
    const value = { regionId: region.id, fetchedAt, totalAvailable: observations.length, providerCandidates: ids.length, returned: observations.length, truncated: Number(search.pageInfo?.totalResults) > MAX_RESULTS, observations, provider: "YouTube Live", courtesyUrl: "https://www.youtube.com/", addCameraUrl: "https://support.google.com/youtube/answer/2474026" };
    this.cache.set(region.id, { expiresAt: this.now() + CACHE_MS, value });
    return { ...value, cacheState: "live", regionSearchesRemaining: Math.max(0, MAX_REGION_SEARCHES_PER_DAY - this.regionSearchTimes.length) };
  }
}

module.exports = { PublicWebcamService, CREDENTIAL_NAMESPACE, CREDENTIAL_KEY, SOURCE_ID, regionFromId, regionFromCoordinates, normalizeLiveVideo };
