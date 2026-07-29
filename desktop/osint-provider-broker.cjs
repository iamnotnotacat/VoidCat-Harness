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
});

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
    const allowed = providerId === "searxng" ? ["endpoint"] : [provider.secretKey];
    const extras = Object.keys(values).filter((key) => !allowed.includes(key));
    if (extras.length) throw new Error("Provider configuration contains unsupported fields.");
    if (providerId === "searxng") {
      const endpoint = safeEndpoint(values.endpoint);
      this.credentialStore.set(provider.namespace, "endpoint", endpoint);
    } else {
      const secret = String(values[provider.secretKey] ?? "").trim();
      if (providerId === "hibp" && !/^[a-f0-9]{32}$/i.test(secret)) throw new Error("HIBP API keys must contain exactly 32 hexadecimal characters.");
      if (providerId !== "hibp" && (!/^[\x21-\x7e]{16,512}$/.test(secret) || /[\s?#]/.test(secret))) throw new Error(`${provider.label} credential format is invalid.`);
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
    const key = providerId === "searxng" ? "endpoint" : provider.secretKey;
    const description = this.credentialStore.describe(provider.namespace, key);
    return { configured: description.stored, fingerprint: description.fingerprint, updatedAt: description.updatedAt };
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
    throw new Error("Unknown OSINT provider.");
  }

  secret(providerId) {
    const provider = PROVIDERS[providerId];
    const value = provider?.namespace && provider.secretKey ? this.credentialStore.get(provider.namespace, provider.secretKey) : null;
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
    for (const [key, value] of Object.entries(options.query || {})) url.searchParams.set(key, String(value));
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
    if (request.method !== "POST" || request.url !== "/query") { send(404, { error: "Broker route not found." }); return; }
    let bytes = 0; const chunks = [];
    request.on("data", (chunk) => { bytes += chunk.length; if (bytes <= 16_384) chunks.push(chunk); else request.destroy(); });
    request.on("end", () => { void (async () => {
      const controller = new AbortController();
      const abort = () => controller.abort(new Error("Provider bridge client disconnected."));
      request.once("aborted", abort); response.once("close", () => { if (!response.writableEnded) abort(); });
      try { const input = JSON.parse(Buffer.concat(chunks).toString("utf8")); const result = await service.query(input, { signal: controller.signal }); if (!response.destroyed) send(200, result); }
      catch (error) { if (!response.destroyed) send(400, { error: error instanceof Error ? error.message : "Provider request failed." }); }
    })(); });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ service, server, port: server.address().port, close: () => new Promise((done) => server.close(done)) }));
  });
}

module.exports = { PROVIDERS, OsintProviderBrokerService, startOsintProviderBroker, isExactIp, isExactDomain, isExactEmail, redactProviderData, safeEndpoint };
