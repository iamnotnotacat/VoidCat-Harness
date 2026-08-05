/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
const http = require("node:http");
const { createHash } = require("node:crypto");

const PROVIDERS = Object.freeze({
  deflock: { label: "DeFlock Camera Registry", namespace: null, secretKey: null, minimumIntervalMs: 30_000, cacheTtlMs: 15 * 60_000 },
  searxng: { label: "SearXNG", namespace: "vc-osint.searxng", secretKey: null, minimumIntervalMs: 6_000, cacheTtlMs: 15 * 60_000 },
  "opensquat-local": { label: "OpenSquat-style Local Similarity", namespace: null, secretKey: null, minimumIntervalMs: 0, cacheTtlMs: 24 * 60 * 60_000 },
  shodan: { label: "Shodan", namespace: "vc-osint.shodan", secretKey: "api-key", minimumIntervalMs: 1_000, cacheTtlMs: 60 * 60_000 },
  censys: { label: "Censys", namespace: "vc-osint.censys", secretKey: "personal-access-token", minimumIntervalMs: 1_000, cacheTtlMs: 60 * 60_000 },
  hibp: { label: "Have I Been Pwned", namespace: "vc-osint.hibp", secretKey: "api-key", minimumIntervalMs: 1_600, cacheTtlMs: 5 * 60_000 },
  "gdelt.events": { label: "GDELT Event Database via Google BigQuery", namespace: "vc-hunter-seeker.gdelt-bigquery", secretKey: "access-token", secretKeys: ["project-id", "access-token"], minimumIntervalMs: 15 * 60_000, cacheTtlMs: 15 * 60_000 },
  "acled.events": { label: "ACLED", namespace: "vc-hunter-seeker.acled", secretKey: "access-token", minimumIntervalMs: 15 * 60_000, cacheTtlMs: 60 * 60_000 },
  "ucdp.ged": { label: "UCDP GED", namespace: "vc-hunter-seeker.ucdp", secretKey: "api-token", minimumIntervalMs: 15 * 60_000, cacheTtlMs: 60 * 60_000 },
  "reliefweb.reports": { label: "ReliefWeb", namespace: "vc-hunter-seeker.reliefweb", secretKey: "app-name", minimumIntervalMs: 5 * 60_000, cacheTtlMs: 30 * 60_000 },
  "noaa.cdo": { label: "NOAA Climate Data Online", namespace: "vc-hunter-seeker.noaa-cdo", secretKey: "api-token", minimumIntervalMs: 1_000, cacheTtlMs: 24 * 60 * 60_000 },
  "openaq.measurements": { label: "OpenAQ", namespace: "vc-hunter-seeker.openaq", secretKey: "api-key", minimumIntervalMs: 60_000, cacheTtlMs: 30 * 60_000 },
  "epa.airnow": { label: "EPA AirNow", namespace: "vc-hunter-seeker.airnow", secretKey: "api-key", minimumIntervalMs: 60 * 60_000, cacheTtlMs: 60 * 60_000 },
  "gfw.alerts": { label: "Global Forest Watch", namespace: "vc-hunter-seeker.global-forest-watch", secretKey: "access-token", minimumIntervalMs: 60 * 60_000, cacheTtlMs: 24 * 60 * 60_000 },
  "copernicus.dataspace": { label: "Copernicus Data Space", namespace: "vc-hunter-seeker.copernicus-data-space", secretKey: "access-token", minimumIntervalMs: 60 * 60_000, cacheTtlMs: 60 * 60_000 },
  "gfw.fishing": { label: "Global Fishing Watch", namespace: "vc-hunter-seeker.global-fishing-watch", secretKey: "access-token", minimumIntervalMs: 60 * 60_000, cacheTtlMs: 60 * 60_000 },
  "mobility.database": { label: "Mobility Database", namespace: "vc-hunter-seeker.mobility-database", secretKey: "api-key", minimumIntervalMs: 5 * 60_000, cacheTtlMs: 24 * 60 * 60_000 },
});

const HUNTER_PROVIDER_IDS = new Set(["gdelt.events", "acled.events", "ucdp.ged", "reliefweb.reports", "noaa.cdo", "openaq.measurements", "epa.airnow", "gfw.alerts", "copernicus.dataspace", "gfw.fishing", "mobility.database"]);

const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_CACHE_ENTRIES = 200;
const MAX_LOG_ENTRIES = 200;

function hash(value) { return createHash("sha256").update(String(value)).digest("hex").slice(0, 16); }
function isExactIp(value) {
  if (typeof value !== "string" || value.length > 64 || !value.trim()) return false;
  if (value.includes(":")) return /^[0-9a-f:]+$/i.test(value);
  const parts = value.split("."); return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
function isExactDomain(value) { return typeof value === "string" && value.length <= 253 && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value); }
function isExactEmail(value) { return typeof value === "string" && value.length <= 254 && /^[^\s@]{1,64}@[a-z0-9.-]+\.[a-z]{2,63}$/i.test(value); }
function redactEmail(value) { const [local, domain] = String(value).split("@"); return domain ? `${local.slice(0, 1)}***@${domain}` : "[redacted]"; }
function redactSecretText(value, secrets = []) {
  let text = String(value ?? "");
  for (const secret of secrets) if (typeof secret === "string" && secret.length >= 4) text = text.split(secret).join("[REDACTED]");
  return text
    .replace(/([?&](?:key|api[_-]?key|token|access[_-]?token|password|secret)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/(bearer\s+)[^\s,;]+/gi, "$1[REDACTED]");
}
function redactProviderData(value, { sensitive = false, secrets = [] } = {}) {
  const text = JSON.stringify(value, (key, item) => {
    if (key && /^(?:authorization|proxy-authorization|x-api-key|api[_-]?key|access[_-]?token|token|password|secret|credential)$/i.test(key)) return "[REDACTED]";
    if (typeof item !== "string") return item;
    const redacted = redactSecretText(item, secrets);
    return sensitive ? redacted.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (match) => redactEmail(match)) : redacted;
  });
  return text === undefined ? null : JSON.parse(text);
}
function safeEndpoint(value) {
  const url = new URL(String(value));
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("SearXNG must use HTTPS, except for an explicit loopback instance.");
  url.username = ""; url.password = ""; url.search = ""; url.hash = "";
  return url.toString().replace(/\/$/, "");
}

class OsintProviderBrokerService {
  constructor({ credentialStore, fetchImpl = fetch, now = Date.now } = {}) {
    if (!credentialStore) throw new Error("The OSINT provider broker requires protected credential storage.");
    this.credentialStore = credentialStore;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.cache = new Map();
    this.rateState = new Map();
    this.invocations = [];
  }

  configure(providerId, values = {}) {
    const provider = PROVIDERS[providerId];
    if (!provider || !provider.namespace) throw new Error("This provider does not have protected configuration.");
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("Provider configuration must be an object.");
    const allowed = providerId === "searxng" ? ["endpoint"] : (provider.secretKeys || [provider.secretKey]);
    const extras = Object.keys(values).filter((key) => !allowed.includes(key));
    if (extras.length) throw new Error("Provider configuration contains unsupported fields.");
    if (providerId === "searxng") {
      const endpoint = safeEndpoint(values.endpoint);
      this.credentialStore.set(provider.namespace, "endpoint", endpoint);
    } else if (provider.secretKeys) {
      const validated = [];
      for (const key of provider.secretKeys) {
        const value = String(values[key] ?? "").trim();
        if (key === "project-id") {
          if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value)) throw new Error("Google Cloud project ID format is invalid.");
        } else if (!/^[\x21-\x7e]{20,4096}$/.test(value) || /[\s?#]/.test(value)) throw new Error(`${provider.label} credential format is invalid.`);
        validated.push([key, value]);
      }
      for (const [key, value] of validated) this.credentialStore.set(provider.namespace, key, value);
    } else {
      const secret = String(values[provider.secretKey] ?? "").trim();
      if (providerId === "hibp" && !/^[a-f0-9]{32}$/i.test(secret)) throw new Error("HIBP API keys must contain exactly 32 hexadecimal characters.");
      const minimumLength = providerId === "reliefweb.reports" ? 3 : 12;
      if (providerId !== "hibp" && (!new RegExp(`^[\\x21-\\x7e]{${minimumLength},2048}$`).test(secret) || /[\s?#]/.test(secret))) throw new Error(`${provider.label} credential format is invalid.`);
      this.credentialStore.set(provider.namespace, provider.secretKey, secret);
    }
    return this.describe(providerId);
  }

  remove(providerId) {
    const provider = PROVIDERS[providerId];
    if (!provider?.namespace) throw new Error("This provider does not have protected configuration.");
    for (const key of this.credentialStore.list(provider.namespace)) this.credentialStore.delete(provider.namespace, key);
    for (const cacheKey of [...this.cache.keys()]) if (cacheKey.startsWith(`${providerId}:`)) this.cache.delete(cacheKey);
    return this.describe(providerId);
  }

  describe(providerId) {
    const provider = PROVIDERS[providerId];
    if (!provider) throw new Error("Unknown OSINT provider.");
    if (!provider.namespace) return { configured: true, fingerprint: null, updatedAt: null };
    const keys = providerId === "searxng" ? ["endpoint"] : (provider.secretKeys || [provider.secretKey]);
    const descriptions = keys.map((key) => this.credentialStore.describe(provider.namespace, key));
    const fingerprintDescription = descriptions[keys.indexOf(provider.secretKey)] || descriptions[0];
    return { configured: descriptions.every((description) => description.stored), fingerprint: fingerprintDescription.fingerprint, updatedAt: descriptions.map((description) => description.updatedAt).filter(Boolean).sort().at(-1) || null };
  }

  status() {
    return Object.entries(PROVIDERS).map(([id, provider]) => {
      const described = this.describe(id);
      const state = this.rateState.get(id) || {};
      return {
        id, label: provider.label, configured: described.configured, fingerprint: described.fingerprint, updatedAt: described.updatedAt,
        cacheEntries: [...this.cache.keys()].filter((key) => key.startsWith(`${id}:`)).length,
        lastRequestAt: state.lastRequestAt ? new Date(state.lastRequestAt).toISOString() : null,
        nextAllowedAt: state.nextAllowedAt && state.nextAllowedAt > this.now() ? new Date(state.nextAllowedAt).toISOString() : null,
        lastStatus: state.lastStatus || "idle", lastError: state.lastError || null,
      };
    });
  }

  getInvocations() { return this.invocations.map((entry) => ({ ...entry })); }

  providerSecrets(providerId) {
    const provider = PROVIDERS[providerId];
    if (!provider?.namespace) return [];
    return this.credentialStore.list(provider.namespace).map((key) => this.credentialStore.get(provider.namespace, key)).filter((value) => typeof value === "string" && value.length >= 4);
  }

  async test(providerId) {
    if (providerId === "searxng") return this.query({ providerId, targetType: "domain", target: "example.com", operation: "web-search", testOnly: true });
    if (providerId === "shodan") return this.request(providerId, "https://api.shodan.io/api-info", { query: { key: this.secret(providerId) }, targetHash: "credential-test", testOnly: true });
    if (providerId === "censys") return this.request(providerId, "https://api.platform.censys.io/v3/accounts/users/credits", { headers: { Authorization: `Bearer ${this.secret(providerId)}` }, targetHash: "credential-test", testOnly: true });
    if (providerId === "hibp") return this.request(providerId, "https://haveibeenpwned.com/api/v3/subscription/status", { headers: { "hibp-api-key": this.secret(providerId), "user-agent": "VoidCat-Harness" }, targetHash: "credential-test", testOnly: true, sensitive: true });
    if (["deflock", "opensquat-local"].includes(providerId)) return { ok: true, providerId, configured: true, cache: { status: "not-applicable", ageMs: 0 }, data: { local: true } };
    if (HUNTER_PROVIDER_IDS.has(providerId)) return this.hunterQuery({ sourceId: providerId, testOnly: true });
    throw new Error("Unknown OSINT provider.");
  }

  secret(providerId, key) {
    const provider = PROVIDERS[providerId];
    const credentialKey = key || provider?.secretKey;
    const value = provider?.namespace && credentialKey ? this.credentialStore.get(provider.namespace, credentialKey) : null;
    if (!value) throw new Error(`${provider?.label || providerId} is not configured.`);
    return value;
  }

  async query(input = {}, options = {}) {
    const { providerId, targetType } = input;
    const target = String(input.target ?? "").trim();
    if (!PROVIDERS[providerId]) throw new Error("Unknown OSINT provider.");
    if (target.length < 1 || target.length > 500) throw new Error("An exact bounded provider target is required.");
    if (providerId === "searxng") {
      const endpoint = this.credentialStore.get(PROVIDERS.searxng.namespace, "endpoint");
      if (!endpoint) throw new Error("SearXNG is not configured.");
      const url = new URL(`${safeEndpoint(endpoint)}/search`);
      url.searchParams.set("q", target); url.searchParams.set("format", "json"); url.searchParams.set("safesearch", "2"); url.searchParams.set("language", "en");
      return this.request(providerId, url.toString(), { targetHash: hash(`${targetType}:${target}`), testOnly: input.testOnly === true, signal: options.signal });
    }
    if (providerId === "shodan") {
      if (targetType === "ip-address" && isExactIp(target)) return this.request(providerId, `https://api.shodan.io/shodan/host/${encodeURIComponent(target)}`, { query: { key: this.secret(providerId), minify: "false" }, targetHash: hash(`${targetType}:${target}`), signal: options.signal });
      if (targetType === "domain" && isExactDomain(target)) return this.request(providerId, `https://api.shodan.io/dns/domain/${encodeURIComponent(target.toLowerCase())}`, { query: { key: this.secret(providerId) }, targetHash: hash(`${targetType}:${target}`), signal: options.signal });
      throw new Error("Shodan accepts only an exact IP address or domain.");
    }
    if (providerId === "censys") {
      const headers = { Authorization: `Bearer ${this.secret(providerId)}` };
      if (targetType === "ip-address" && isExactIp(target)) return this.request(providerId, `https://api.platform.censys.io/v3/global/asset/host/${encodeURIComponent(target)}`, { headers, targetHash: hash(`${targetType}:${target}`), signal: options.signal });
      if (targetType === "domain" && isExactDomain(target)) return this.request(providerId, "https://api.platform.censys.io/v3/global/search/query", { method: "POST", headers, body: { query: `host.dns.names: ${JSON.stringify(target.toLowerCase())}`, page_size: 25 }, targetHash: hash(`${targetType}:${target}`), signal: options.signal });
      throw new Error("Censys accepts only an exact IP address or domain.");
    }
    if (providerId === "hibp") {
      if (input.authorizationMode !== "exposure-check" || input.confirmed !== true || String(input.exactTarget ?? "").trim().toLowerCase() !== target.toLowerCase()) throw new Error("HIBP requires fresh exact-target exposure authorization.");
      const headers = { "hibp-api-key": this.secret(providerId), "user-agent": "VoidCat-Harness" };
      if (targetType === "email-address" && isExactEmail(target)) return this.request(providerId, `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(target)}`, { headers, query: { truncateResponse: "false" }, targetHash: hash(`${targetType}:${target}`), sensitive: true, signal: options.signal });
      if (targetType === "domain" && isExactDomain(target)) return this.request(providerId, `https://haveibeenpwned.com/api/v3/breacheddomain/${encodeURIComponent(target.toLowerCase())}`, { headers, targetHash: hash(`${targetType}:${target}`), sensitive: true, redactDomainAccounts: true, signal: options.signal });
      throw new Error("HIBP accepts only one exact authorized email address or verified domain.");
    }
    throw new Error(`${PROVIDERS[providerId].label} is handled locally and cannot use the credential broker.`);
  }

  validateHunterInput(input) {
    if (!input || typeof input !== "object" || Array.isArray(input) || !HUNTER_PROVIDER_IDS.has(input.sourceId)) throw new Error("A registered credentialed Hunter-Seeker source is required.");
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500)) throw new Error("Hunter provider limit must be between 1 and 500.");
    if (input.query !== undefined && (typeof input.query !== "string" || input.query.trim().length < 2 || input.query.length > 240)) throw new Error("Hunter provider query must contain 2 to 240 characters.");
    if (input.resource !== undefined && (typeof input.resource !== "string" || input.resource.trim().length < 1 || input.resource.length > 120)) throw new Error("Hunter provider resource is invalid.");
    if (input.bbox) {
      const { west, south, east, north } = input.bbox;
      if (![west, south, east, north].every(Number.isFinite) || west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) throw new Error("Hunter provider bounding box is invalid.");
    }
    for (const value of [input.startAt, input.endAt]) if (value !== undefined && !Number.isFinite(Date.parse(value))) throw new Error("Hunter provider time window is invalid.");
    return { ...input, limit: input.limit || 100 };
  }

  async hunterQuery(untrustedInput = {}, options = {}) {
    const input = this.validateHunterInput(untrustedInput); const providerId = input.sourceId; const provider = PROVIDERS[providerId];
    const secret = this.secret(providerId); const targetHash = hash(JSON.stringify({ sourceId: providerId, bbox: input.bbox, point: input.point, query: input.query, resource: input.resource, startAt: input.startAt, endAt: input.endAt, limit: input.limit }));
    if (input.testOnly === true) {
      const tests = {
        "gdelt.events": [`https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(this.secret(providerId, "project-id"))}/queries`, { method: "POST", headers: { Authorization: `Bearer ${secret}` }, body: { query: "SELECT 1 AS credential_check", useLegacySql: false, timeoutMs: 8000, maximumBytesBilled: "1000000" } }],
        "acled.events": ["https://acleddata.com/api/acled/read", { headers: { Authorization: `Bearer ${secret}` }, query: { limit: 1 } }],
        "ucdp.ged": ["https://ucdpapi.pcr.uu.se/api/gedevents/24.1", { headers: { "x-ucdp-access-token": secret }, query: { pagesize: 1, page: 0 } }],
        "reliefweb.reports": ["https://api.reliefweb.int/v1/reports", { query: { appname: secret, limit: 1 } }],
        "noaa.cdo": ["https://www.ncei.noaa.gov/cdo-web/api/v2/datasets", { headers: { token: secret }, query: { limit: 1 } }],
        "openaq.measurements": ["https://api.openaq.org/v3/locations", { headers: { "X-API-Key": secret }, query: { limit: 1 } }],
        "epa.airnow": ["https://www.airnowapi.org/aq/observation/zipCode/current/", { query: { format: "application/json", zipCode: "20001", distance: 1, API_KEY: secret } }],
        "gfw.alerts": ["https://data-api.globalforestwatch.org/dataset", { headers: { Authorization: `Bearer ${secret}` }, query: { page: 1, page_size: 1 } }],
        "copernicus.dataspace": ["https://catalogue.dataspace.copernicus.eu/stac/collections", { headers: { Authorization: `Bearer ${secret}` }, query: { limit: 1 } }],
        "gfw.fishing": ["https://gateway.api.globalfishingwatch.org/v3/datasets", { headers: { Authorization: `Bearer ${secret}` }, query: { limit: 1 } }],
        "mobility.database": ["https://api.mobilitydatabase.org/v1/feeds", { headers: { "X-API-Key": secret }, query: { limit: 1 } }],
      };
      const [url, requestOptions] = tests[providerId]; return this.request(providerId, url, { ...requestOptions, targetHash: "credential-test", testOnly: true, signal: options.signal });
    }
    const bbox = input.bbox; const bboxText = bbox ? `${bbox.west},${bbox.south},${bbox.east},${bbox.north}` : null; const start = input.startAt?.slice(0, 10); const end = input.endAt?.slice(0, 10);
    if (providerId === "gdelt.events") {
      if (!bbox || !start || !end) throw new Error("GDELT BigQuery requires a bounded map area and time window.");
      const projectId = this.secret(providerId, "project-id");
      const query = `SELECT CAST(GLOBALEVENTID AS STRING) AS event_id, ActionGeo_FullName AS location_name, ActionGeo_CountryCode AS country_code, ActionGeo_Lat AS latitude, ActionGeo_Long AS longitude, CAST(SQLDATE AS STRING) AS event_date, EventCode AS event_code, EventBaseCode AS base_event_code, EventRootCode AS root_event_code, QuadClass AS quad_class, GoldsteinScale AS goldstein_scale, NumMentions AS mentions, NumSources AS sources, NumArticles AS articles, AvgTone AS average_tone, SOURCEURL AS source_url FROM \`gdelt-bq.gdeltv2.events\` WHERE ActionGeo_Lat BETWEEN @south AND @north AND ActionGeo_Long BETWEEN @west AND @east AND PARSE_DATE('%Y%m%d', CAST(SQLDATE AS STRING)) BETWEEN @start_date AND @end_date ORDER BY DATEADDED DESC LIMIT ${input.limit}`;
      const queryParameters = [
        ["south", "FLOAT64", bbox.south], ["north", "FLOAT64", bbox.north], ["west", "FLOAT64", bbox.west], ["east", "FLOAT64", bbox.east],
        ["start_date", "DATE", start], ["end_date", "DATE", end],
      ].map(([name, type, value]) => ({ name, parameterType: { type }, parameterValue: { value: String(value) } }));
      return this.request(providerId, `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(projectId)}/queries`, { method: "POST", headers: { Authorization: `Bearer ${secret}` }, body: { query, useLegacySql: false, parameterMode: "NAMED", queryParameters, timeoutMs: 10000, maximumBytesBilled: "5000000000" }, targetHash, signal: options.signal });
    }
    if (providerId === "acled.events") return this.request(providerId, "https://acleddata.com/api/acled/read", { headers: { Authorization: `Bearer ${secret}` }, query: { limit: input.limit, event_date: start && end ? `${start}|${end}` : undefined, event_date_where: start && end ? "BETWEEN" : undefined, latitude: bbox ? `${bbox.south}|${bbox.north}` : undefined, latitude_where: bbox ? "BETWEEN" : undefined, longitude: bbox ? `${bbox.west}|${bbox.east}` : undefined, longitude_where: bbox ? "BETWEEN" : undefined }, targetHash, signal: options.signal });
    if (providerId === "ucdp.ged") return this.request(providerId, "https://ucdpapi.pcr.uu.se/api/gedevents/24.1", { headers: { "x-ucdp-access-token": secret }, query: { pagesize: input.limit, page: 0, StartDate: start, EndDate: end }, targetHash, signal: options.signal });
    if (providerId === "reliefweb.reports") return this.request(providerId, "https://api.reliefweb.int/v1/reports", { method: "POST", query: { appname: secret }, body: { preset: "latest", limit: input.limit, query: { value: input.query }, fields: { include: ["title", "body", "url", "url_alias", "date", "country", "disaster", "source", "format"] } }, targetHash, signal: options.signal });
    if (providerId === "noaa.cdo") return this.request(providerId, "https://www.ncei.noaa.gov/cdo-web/api/v2/data", { headers: { token: secret }, query: { datasetid: input.resource, startdate: start, enddate: end, extent: bbox ? `${bbox.south},${bbox.west},${bbox.north},${bbox.east}` : undefined, limit: input.limit, includemetadata: "false", units: "metric" }, targetHash, signal: options.signal });
    if (providerId === "openaq.measurements") return this.request(providerId, "https://api.openaq.org/v3/locations", { headers: { "X-API-Key": secret }, query: { bbox: bboxText, limit: input.limit, page: 1 }, targetHash, signal: options.signal });
    if (providerId === "epa.airnow") { if (!bbox) throw new Error("AirNow requires a bounded map area."); const latitude = (bbox.south + bbox.north) / 2; const longitude = (bbox.west + bbox.east) / 2; const distance = Math.min(200, Math.max(1, Math.ceil(Math.hypot(bbox.north - bbox.south, bbox.east - bbox.west) * 55.5))); return this.request(providerId, "https://www.airnowapi.org/aq/observation/latLong/current/", { query: { format: "application/json", latitude, longitude, distance, API_KEY: secret }, targetHash, signal: options.signal }); }
    if (providerId === "gfw.alerts") return this.request(providerId, "https://data-api.globalforestwatch.org/dataset/gfw_integrated_alerts/latest/query", { method: "POST", headers: { Authorization: `Bearer ${secret}` }, body: { sql: `SELECT * FROM data WHERE longitude BETWEEN ${bbox.west} AND ${bbox.east} AND latitude BETWEEN ${bbox.south} AND ${bbox.north} LIMIT ${input.limit}` }, targetHash, signal: options.signal });
    if (providerId === "copernicus.dataspace") return this.request(providerId, "https://catalogue.dataspace.copernicus.eu/stac/search", { method: "POST", headers: { Authorization: `Bearer ${secret}` }, body: { bbox: [bbox.west, bbox.south, bbox.east, bbox.north], datetime: `${input.startAt}/${input.endAt}`, limit: input.limit }, targetHash, signal: options.signal });
    if (providerId === "gfw.fishing") return this.request(providerId, "https://gateway.api.globalfishingwatch.org/v3/events", { headers: { Authorization: `Bearer ${secret}` }, query: { datasets: "public-global-fishing-events:latest", "start-date": start, "end-date": end, bbox: bboxText, limit: input.limit }, targetHash, signal: options.signal });
    if (providerId === "mobility.database") return this.request(providerId, "https://api.mobilitydatabase.org/v1/feeds", { headers: { "X-API-Key": secret }, query: { search: input.query, limit: input.limit }, targetHash, signal: options.signal });
    throw new Error(`${provider.label} does not have a protected query adapter.`);
  }

  async request(providerId, rawUrl, options = {}) {
    const provider = PROVIDERS[providerId];
    const cacheKey = `${providerId}:${options.targetHash}:${hash(`${options.method || "GET"}:${rawUrl.replace(/[?].*$/, "")}:${JSON.stringify(options.body || null)}`)}`;
    const cached = this.cache.get(cacheKey);
    const currentTime = this.now();
    if (!options.testOnly && cached && cached.expiresAt > currentTime) return { ok: true, providerId, configured: true, cache: { status: "cached", ageMs: currentTime - cached.storedAt, expiresAt: new Date(cached.expiresAt).toISOString() }, data: structuredClone(cached.data) };
    const state = this.rateState.get(providerId) || {};
    if (state.nextAllowedAt && state.nextAllowedAt > currentTime) throw new Error(`${provider.label} request guard is active until ${new Date(state.nextAllowedAt).toISOString()}.`);
    if (options.signal?.aborted) throw new Error("Provider request cancelled.");
    const url = new URL(rawUrl);
    for (const [key, value] of Object.entries(options.query || {})) if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(new Error("Provider request timed out.")), 12_000);
    const cancel = () => controller.abort(options.signal?.reason); options.signal?.addEventListener("abort", cancel, { once: true });
    state.lastRequestAt = currentTime; state.nextAllowedAt = currentTime + provider.minimumIntervalMs; state.lastStatus = "requesting"; state.lastError = null; this.rateState.set(providerId, state);
    const log = { id: hash(`${providerId}:${currentTime}:${options.targetHash}`), providerId, operation: options.testOnly ? "credential-test" : "query", targetType: "redacted-hash", targetHash: options.targetHash, startedAt: new Date(currentTime).toISOString(), status: "running", responseBytes: 0 };
    this.invocations.push(log); if (this.invocations.length > MAX_LOG_ENTRIES) this.invocations.splice(0, this.invocations.length - MAX_LOG_ENTRIES);
    try {
      const response = await this.fetchImpl(url, { method: options.method || "GET", redirect: "error", signal: controller.signal, headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) }, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
      const retryAfter = Number(response.headers.get("retry-after"));
      if (response.status === 429 && Number.isFinite(retryAfter)) state.nextAllowedAt = currentTime + retryAfter * 1_000;
      if (!response.ok && !(providerId === "hibp" && response.status === 404 && !options.testOnly)) throw new Error(`${provider.label} returned HTTP ${response.status}.`);
      const declared = Number(response.headers.get("content-length")); if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error(`${provider.label} response exceeded the 2 MB safety limit.`);
      const contentType = response.headers.get("content-type"); if (contentType && !/json/i.test(contentType)) throw new Error(`${provider.label} returned a non-JSON response.`);
      const text = response.status === 404 ? "[]" : await response.text(); const bytes = Buffer.byteLength(text);
      if (bytes > MAX_RESPONSE_BYTES) throw new Error(`${provider.label} response exceeded the 2 MB safety limit.`);
      let data; try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`${provider.label} returned malformed JSON.`); }
      if (options.redactDomainAccounts && data && typeof data === "object" && !Array.isArray(data)) data = Object.entries(data).map(([account, breaches]) => ({ account: redactEmail(account), breaches }));
      const stored = redactProviderData(data, { sensitive: options.sensitive === true, secrets: this.providerSecrets(providerId) });
      const expiresAt = currentTime + provider.cacheTtlMs;
      if (!options.testOnly) {
        this.cache.set(cacheKey, { storedAt: currentTime, expiresAt, data: stored });
        while (this.cache.size > MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value);
      }
      state.lastStatus = "healthy"; log.status = "completed"; log.responseBytes = bytes;
      return { ok: true, providerId, configured: true, cache: { status: "live", ageMs: 0, expiresAt: new Date(expiresAt).toISOString() }, data: stored };
    } catch (error) {
      state.lastStatus = "degraded"; state.lastError = options.signal?.aborted ? "Provider request cancelled." : redactSecretText(error instanceof Error ? error.message : "Provider request failed.", this.providerSecrets(providerId));
      log.status = "failed"; throw new Error(state.lastError, { cause: error });
    } finally { clearTimeout(timeout); options.signal?.removeEventListener("abort", cancel); }
  }
}

function startOsintProviderBroker({ credentialStore, token, fetchImpl, now } = {}) {
  if (!token) throw new Error("The OSINT provider broker requires the desktop authentication token.");
  const service = new OsintProviderBrokerService({ credentialStore, fetchImpl, now });
  const server = http.createServer((request, response) => {
    const send = (status, value) => { const body = JSON.stringify(value); response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" }); response.end(body); };
    if (request.socket.remoteAddress !== "127.0.0.1" && request.socket.remoteAddress !== "::1" && request.socket.remoteAddress !== "::ffff:127.0.0.1") { send(403, { error: "Loopback access required." }); return; }
    if (request.headers["x-voidcat-desktop-token"] !== token) { send(403, { error: "Protected desktop bridge authentication failed." }); return; }
    if (request.method === "GET" && request.url === "/status") { send(200, { providers: service.status() }); return; }
    if (request.method !== "POST" || (request.url !== "/query" && request.url !== "/hunter/query")) { send(404, { error: "Broker route not found." }); return; }
    let bytes = 0; const chunks = [];
    request.on("data", (chunk) => { bytes += chunk.length; if (bytes <= 16_384) chunks.push(chunk); else request.destroy(); });
    request.on("end", () => { void (async () => {
      const controller = new AbortController();
      const abort = () => controller.abort(new Error("Provider bridge client disconnected."));
      request.once("aborted", abort); response.once("close", () => { if (!response.writableEnded) abort(); });
      try { const input = JSON.parse(Buffer.concat(chunks).toString("utf8")); const result = request.url === "/hunter/query" ? await service.hunterQuery(input, { signal: controller.signal }) : await service.query(input, { signal: controller.signal }); if (!response.destroyed) send(200, result); }
      catch (error) { if (!response.destroyed) send(400, { error: error instanceof Error ? error.message : "Provider request failed." }); }
    })(); });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ service, server, port: server.address().port, close: () => new Promise((done) => server.close(done)) }));
  });
}

module.exports = { PROVIDERS, HUNTER_PROVIDER_IDS, OsintProviderBrokerService, startOsintProviderBroker, isExactIp, isExactDomain, isExactEmail, redactProviderData, safeEndpoint };
