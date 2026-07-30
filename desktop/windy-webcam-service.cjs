/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
const { createHash } = require("node:crypto");

const API_ORIGIN = "https://api.windy.com";
const API_PATH = "/webcams/api/v3/webcams";
const CREDENTIAL_NAMESPACE = "vc-hunter-seeker.windy-webcams";
const CREDENTIAL_KEY = "api-key";
const SOURCE_ID = "windy.public-webcams";
const PAGE_SIZE = 50;
const MAX_OFFSET = 1_000;
const MAX_RESPONSE_BYTES = 8_000_000;
const CACHE_MS = 15 * 60_000;
const REGION_DEGREES = 20;

function credentialFingerprint(value) { return value ? createHash("sha256").update(value).digest("hex").slice(0, 10).toUpperCase() : null; }
function boundedText(value, limit = 500) { return typeof value === "string" || typeof value === "number" ? String(value).trim().slice(0, limit) : ""; }

function regionFromId(id) {
  if (typeof id !== "string" || !/^-?\d+\/-?\d+$/.test(id)) throw new Error("A valid Windy webcam sector is required.");
  const [south, west] = id.split("/").map(Number);
  if (!Number.isInteger(south) || !Number.isInteger(west) || south < -90 || south >= 90 || west < -180 || west >= 180 || (south + 90) % REGION_DEGREES || (west + 180) % REGION_DEGREES) throw new Error("The Windy webcam sector is outside the fixed worldwide index.");
  return { id, south, west, north: Math.min(90, south + REGION_DEGREES), east: Math.min(180, west + REGION_DEGREES) };
}

function safeWindyUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && !url.username && !url.password && (url.hostname === "windy.com" || url.hostname.endsWith(".windy.com")) ? url.toString() : "";
  } catch { return ""; }
}

function normalizeWindyWebcam(item, regionId, fetchedAt) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const id = boundedText(item.webcamId ?? item.id, 100);
  const location = item.location && typeof item.location === "object" ? item.location : {};
  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  if (!id || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
  const player = item.player && typeof item.player === "object" ? item.player : {};
  const images = item.images && typeof item.images === "object" ? item.images : {};
  const current = images.current && typeof images.current === "object" ? images.current : {};
  const urls = item.urls && typeof item.urls === "object" ? item.urls : {};
  const playerUrl = safeWindyUrl(player.live ?? player.day ?? player.month ?? player.year);
  if (!playerUrl) return null;
  const playerMode = safeWindyUrl(player.live) ? "provider-live" : safeWindyUrl(player.day) ? "timelapse-day" : safeWindyUrl(player.month) ? "timelapse-month" : "timelapse-year";
  return {
    observationId: `${SOURCE_ID}:camera:${id}`,
    entityId: `public-webcam:windy:${id}`,
    entityType: "imagery.public-webcam",
    position: { latitude, longitude },
    timestamp: fetchedAt,
    provenance: { sourceFeedId: SOURCE_ID, fetchedAt, receivedAt: fetchedAt, stalenessMs: 0 },
    confidence: 0.9,
    basis: "measured",
    retentionClass: "bulk",
    attributes: {
      title: boundedText(item.title, 180) || `WINDY WEBCAM ${id}`,
      webcamId: id,
      regionId,
      city: boundedText(location.city, 120),
      region: boundedText(location.region, 120),
      country: boundedText(location.country, 120),
      liveAvailable: playerMode === "provider-live",
      playerUrl,
      playerMode,
      imageUrl: safeWindyUrl(current.preview ?? current.icon ?? current.thumbnail),
      eventUrl: safeWindyUrl(urls.detail),
      sourceName: "Windy Webcams API",
      coverageLimitation: "Public, Windy-indexed webcams only. Windy's provider player may be continuous video or an updated/timelapse image sequence; the mode is labeled in VoidCat. Absence is not evidence that no camera exists.",
    },
  };
}

class WindyWebcamService {
  constructor({ credentialStore, fetchImpl = fetch, now = Date.now } = {}) {
    if (!credentialStore) throw new Error("Windy webcam service requires protected credential storage.");
    this.credentialStore = credentialStore;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.cache = new Map();
  }
  credential() { return this.credentialStore.get(CREDENTIAL_NAMESPACE, CREDENTIAL_KEY); }
  status() {
    const credential = this.credential();
    const description = this.credentialStore.describe(CREDENTIAL_NAMESPACE, CREDENTIAL_KEY);
    return { configured: Boolean(credential), fingerprint: description.fingerprint ?? credentialFingerprint(credential), updatedAt: description.updatedAt ?? null, cachedRegions: this.cache.size };
  }
  async request(url, credential, signal) {
    if (url.origin !== API_ORIGIN || url.pathname !== API_PATH) throw new Error("Windy webcam request attempted to leave the fixed API endpoint.");
    const response = await this.fetchImpl(url, { method: "GET", redirect: "error", credentials: "omit", headers: { Accept: "application/json", "X-Windy-API-Key": credential, "User-Agent": "VoidCat-Harness/1.0 (operator-selected Windy webcam sector)" }, signal });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "Windy rejected the API key." : `Windy Webcams returned HTTP ${response.status}.`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("Windy Webcams response exceeded the safety limit.");
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) throw new Error("Windy Webcams response exceeded the safety limit.");
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.webcams)) throw new Error("Windy Webcams returned a malformed response.");
    return parsed;
  }
  async testCredential(value) {
    const credential = boundedText(value, 512);
    if (!/^[\x21-\x7e]{8,512}$/.test(credential) || /[\s?#]/.test(credential)) throw new Error("Windy API key format is invalid.");
    const url = new URL(API_PATH, API_ORIGIN);
    url.searchParams.set("limit", "1");
    url.searchParams.set("include", "location");
    await this.request(url, credential, AbortSignal.timeout(20_000));
    return { valid: true, verifiedBy: "Windy Webcams API", fingerprint: credentialFingerprint(credential) };
  }
  async configure(value) {
    const tested = await this.testCredential(value);
    this.credentialStore.set(CREDENTIAL_NAMESPACE, CREDENTIAL_KEY, boundedText(value, 512));
    return { ...this.status(), valid: true, verifiedBy: tested.verifiedBy };
  }
  remove() { this.cache.clear(); this.credentialStore.delete(CREDENTIAL_NAMESPACE, CREDENTIAL_KEY); return this.status(); }
  async loadRegion(regionId) {
    const region = regionFromId(regionId);
    const cached = this.cache.get(region.id);
    if (cached && cached.expiresAt > this.now()) return { ...cached.value, cacheState: "cached" };
    const credential = this.credential();
    if (!credential) throw new Error("Connect a Windy Webcams API key before loading its camera layer.");
    const fetchedAt = new Date(this.now()).toISOString();
    const all = [];
    let total = 0;
    for (let offset = 0; offset < MAX_OFFSET; offset += PAGE_SIZE) {
      const url = new URL(API_PATH, API_ORIGIN);
      url.searchParams.set("bbox", `${region.north},${region.east},${region.south},${region.west}`);
      url.searchParams.set("include", "images,location,player,urls");
      url.searchParams.set("lang", "en");
      url.searchParams.set("limit", String(PAGE_SIZE));
      url.searchParams.set("offset", String(offset));
      const page = await this.request(url, credential, AbortSignal.timeout(25_000));
      total = Math.max(total, Number(page.total) || 0);
      all.push(...page.webcams);
      if (page.webcams.length < PAGE_SIZE || all.length >= total) break;
    }
    const observations = [...new Map(all.map((item) => {
      const observation = normalizeWindyWebcam(item, region.id, fetchedAt);
      return observation ? [observation.observationId, observation] : ["", null];
    }).filter(([id, observation]) => id && observation)).values()];
    const value = { regionId: region.id, fetchedAt, totalAvailable: observations.length, providerCandidates: total, returned: observations.length, truncated: total > MAX_OFFSET, observations, provider: "Windy Webcams", courtesyUrl: "https://www.windy.com/", addCameraUrl: "https://www.windy.com/webcams/add" };
    this.cache.set(region.id, { expiresAt: this.now() + CACHE_MS, value });
    return { ...value, cacheState: "live" };
  }
}

module.exports = { WindyWebcamService, CREDENTIAL_NAMESPACE, CREDENTIAL_KEY, SOURCE_ID, regionFromId, normalizeWindyWebcam };
