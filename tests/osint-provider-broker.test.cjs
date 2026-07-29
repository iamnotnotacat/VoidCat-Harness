/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const { OsintProviderBrokerService, safeEndpoint } = require("../desktop/osint-provider-broker.cjs");

class FixtureStore {
  constructor() { this.values = new Map(); }
  set(namespace, key, value) { this.values.set(`${namespace}:${key}`, String(value)); return { namespace, key, stored: true }; }
  get(namespace, key) { return this.values.get(`${namespace}:${key}`) ?? null; }
  delete(namespace, key) { return this.values.delete(`${namespace}:${key}`); }
  list(namespace) { return [...this.values.keys()].filter((key) => key.startsWith(`${namespace}:`)).map((key) => key.slice(namespace.length + 1)); }
  describe(namespace, key) { const value = this.get(namespace, key); return { stored: value !== null, fingerprint: value ? `fixture-${value.length}` : null, updatedAt: value ? "2026-07-28T01:00:00Z" : null }; }
}

test("protected broker accepts only bounded provider configuration and never returns a secret", () => {
  const store = new FixtureStore(); const service = new OsintProviderBrokerService({ credentialStore: store, fetchImpl: async () => new Response("{}") });
  const saved = service.configure("hibp", { "api-key": "0123456789abcdef0123456789abcdef" });
  assert.equal(saved.configured, true); assert.ok(!JSON.stringify(saved).includes("0123456789abcdef"));
  assert.throws(() => service.configure("hibp", { "api-key": "bad" }), /32 hexadecimal/i);
  assert.equal(safeEndpoint("http://127.0.0.1:8080/"), "http://127.0.0.1:8080");
  assert.throws(() => safeEndpoint("http://example.com"), /HTTPS/i);
});

test("HIBP broker enforces exact authorization and redacts domain accounts before return or cache", async () => {
  const store = new FixtureStore(); store.set("vc-osint.hibp", "api-key", "0123456789abcdef0123456789abcdef");
  const service = new OsintProviderBrokerService({ credentialStore: store, fetchImpl: async () => new Response(JSON.stringify({ "person@example.com": [{ Name: "Fixture" }] }), { status: 200, headers: { "content-type": "application/json" } }) });
  await assert.rejects(service.query({ providerId: "hibp", targetType: "domain", target: "example.com", authorizationMode: "exposure-check", confirmed: false, exactTarget: "example.com" }), /authorization/i);
  const result = await service.query({ providerId: "hibp", targetType: "domain", target: "example.com", authorizationMode: "exposure-check", confirmed: true, exactTarget: "example.com" });
  assert.equal(result.data[0].account, "p***@example.com");
  assert.ok(!JSON.stringify(result).includes("person@example.com"));
});

test("broker logs only target hashes and redacts credentials from failures", async () => {
  const store = new FixtureStore(); store.set("vc-osint.shodan", "api-key", "0123456789abcdef0123456789abcdef");
  const service = new OsintProviderBrokerService({ credentialStore: store, fetchImpl: async () => new Response("denied", { status: 401 }) });
  await assert.rejects(service.query({ providerId: "shodan", targetType: "ip-address", target: "192.0.2.10" }), /HTTP 401/);
  const logs = service.getInvocations();
  assert.equal(logs.length, 1); assert.equal(logs[0].targetType, "redacted-hash");
  const serialized = JSON.stringify({ logs, status: service.status() });
  assert.ok(!serialized.includes("192.0.2.10")); assert.ok(!serialized.includes("0123456789abcdef"));
});

test("credential tests use current official account endpoints without returning secrets", async () => {
  const store = new FixtureStore();
  store.set("vc-osint.censys", "personal-access-token", "censys-token-0123456789");
  store.set("vc-osint.hibp", "api-key", "0123456789abcdef0123456789abcdef");
  const requests = [];
  const service = new OsintProviderBrokerService({
    credentialStore: store,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), headers: options.headers });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  await service.test("censys");
  await service.test("hibp");
  assert.equal(requests[0].url, "https://api.platform.censys.io/v3/accounts/users/credits");
  assert.equal(requests[1].url, "https://haveibeenpwned.com/api/v3/subscription/status");
  const visible = JSON.stringify({ requests: requests.map(({ url }) => url), status: service.status(), logs: service.getInvocations() });
  assert.ok(!visible.includes("censys-token"));
  assert.ok(!visible.includes("0123456789abcdef"));
});

test("broker serves valid cache entries before rate guards and exposes bounded retry state", async () => {
  let now = Date.parse("2026-07-28T12:00:00.000Z"); let calls = 0;
  const store = new FixtureStore(); store.set("vc-osint.searxng", "endpoint", "https://search.example.test");
  const service = new OsintProviderBrokerService({ credentialStore: store, now: () => now, fetchImpl: async () => { calls += 1; return new Response(JSON.stringify({ results: [{ title: "Fixture", url: "https://example.test", content: "safe" }] }), { status: 200, headers: { "content-type": "application/json" } }); } });
  const first = await service.query({ providerId: "searxng", targetType: "domain", target: "example.com" });
  const cached = await service.query({ providerId: "searxng", targetType: "domain", target: "example.com" });
  assert.equal(first.cache.status, "live"); assert.equal(cached.cache.status, "cached"); assert.equal(calls, 1);
  await assert.rejects(service.query({ providerId: "searxng", targetType: "domain", target: "example.net" }), /request guard/i);
  const held = service.status().find(({ id }) => id === "searxng"); assert.ok(Date.parse(held.nextAllowedAt) > now);
  now += 6_001; await service.query({ providerId: "searxng", targetType: "domain", target: "example.net" }); assert.equal(calls, 2);
});

test("network, content-type, and malformed JSON failures degrade safely without caching", async () => {
  const setup = (fetchImpl) => { const store = new FixtureStore(); store.set("vc-osint.searxng", "endpoint", "https://search.example.test"); return new OsintProviderBrokerService({ credentialStore: store, fetchImpl }); };
  const network = setup(async () => { throw new Error("network unavailable?api_key=do-not-return"); });
  await assert.rejects(network.query({ providerId: "searxng", targetType: "domain", target: "example.com" }), /REDACTED/);
  assert.equal(network.status().find(({ id }) => id === "searxng").cacheEntries, 0);
  assert.doesNotMatch(JSON.stringify(network.status()), /do-not-return/);

  const wrongType = setup(async () => new Response("<html>upstream failure</html>", { status: 200, headers: { "content-type": "text/html" } }));
  await assert.rejects(wrongType.query({ providerId: "searxng", targetType: "domain", target: "example.com" }), /non-JSON/i);
  assert.equal(wrongType.status().find(({ id }) => id === "searxng").cacheEntries, 0);

  const malformed = setup(async () => new Response('{"results":', { status: 200, headers: { "content-type": "application/json" } }));
  await assert.rejects(malformed.query({ providerId: "searxng", targetType: "domain", target: "example.com" }), /malformed JSON/i);
  assert.equal(malformed.status().find(({ id }) => id === "searxng").lastStatus, "degraded");
});

test("provider responses and failures cannot echo configured secrets", async () => {
  const secret = "shodan-secret-0123456789"; const store = new FixtureStore(); store.set("vc-osint.shodan", "api-key", secret);
  const responseService = new OsintProviderBrokerService({ credentialStore: store, fetchImpl: async () => new Response(JSON.stringify({ ip_str: "192.0.2.10", api_key: secret, nested: { authorization: `Bearer ${secret}`, url: `https://provider.test/?token=${secret}` } }), { status: 200, headers: { "content-type": "application/json" } }) });
  const result = await responseService.query({ providerId: "shodan", targetType: "ip-address", target: "192.0.2.10" });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret)); assert.equal(result.data.api_key, "[REDACTED]");

  const failureService = new OsintProviderBrokerService({ credentialStore: store, fetchImpl: async () => { throw new Error(`connection failed with Bearer ${secret}`); } });
  await assert.rejects(failureService.query({ providerId: "shodan", targetType: "ip-address", target: "192.0.2.11" }), (error) => error instanceof Error && !error.message.includes(secret));
  assert.doesNotMatch(JSON.stringify({ status: failureService.status(), logs: failureService.getInvocations() }), new RegExp(secret));
});

test("external cancellation reaches an in-flight provider request", async () => {
  const store = new FixtureStore(); store.set("vc-osint.searxng", "endpoint", "https://search.example.test"); let upstreamAborted = false;
  const service = new OsintProviderBrokerService({ credentialStore: store, fetchImpl: async (_url, options) => new Promise((_resolve, reject) => { options.signal.addEventListener("abort", () => { upstreamAborted = true; reject(options.signal.reason ?? new Error("aborted")); }, { once: true }); }) });
  const controller = new AbortController(); const pending = service.query({ providerId: "searxng", targetType: "domain", target: "example.com" }, { signal: controller.signal });
  controller.abort(new Error("operator cancelled"));
  await assert.rejects(pending, /cancelled/i); assert.equal(upstreamAborted, true); assert.equal(service.status().find(({ id }) => id === "searxng").lastStatus, "degraded");
});
