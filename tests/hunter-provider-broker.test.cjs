/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0.
 * See LICENSE and NOTICE for attribution requirements. Original Code: VoidCat Harness.
 * Initial Developer: iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const { OsintProviderBrokerService } = require("../desktop/osint-provider-broker.cjs");

class MemoryCredentialStore {
  constructor() { this.values = new Map(); }
  key(namespace, key) { return `${namespace}:${key}`; }
  set(namespace, key, value) { this.values.set(this.key(namespace, key), value); }
  get(namespace, key) { return this.values.get(this.key(namespace, key)) || null; }
  delete(namespace, key) { return this.values.delete(this.key(namespace, key)); }
  list(namespace) { return [...this.values.keys()].filter((value) => value.startsWith(`${namespace}:`)).map((value) => value.slice(namespace.length + 1)); }
  describe(namespace, key) { const value = this.get(namespace, key); return { stored: Boolean(value), fingerprint: value ? "sha256:test" : null, updatedAt: value ? "2026-08-05T00:00:00Z" : null }; }
}

test("Hunter credentials stay in the broker and are absent from returned data and invocation logs", async () => {
  const store = new MemoryCredentialStore(); const secret = "ACLED-TOKEN-0123456789"; let receivedAuthorization = null;
  const broker = new OsintProviderBrokerService({ credentialStore: store, now: () => Date.parse("2026-08-05T12:00:00Z"), fetchImpl: async (_url, options) => { receivedAuthorization = options.headers.Authorization; return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } }); } });
  const status = broker.configure("acled.events", { "access-token": secret }); assert.equal(status.configured, true);
  const result = await broker.hunterQuery({ sourceId: "acled.events", bbox: { west: -98, south: 35, east: -97, north: 36 }, startAt: "2026-08-01T00:00:00Z", endAt: "2026-08-05T00:00:00Z", limit: 10 });
  assert.equal(receivedAuthorization, `Bearer ${secret}`);
  assert.equal(JSON.stringify(result).includes(secret), false); assert.equal(JSON.stringify(broker.getInvocations()).includes(secret), false);
  assert.equal(broker.remove("acled.events").configured, false);
});

test("Hunter broker rejects unknown source IDs, unbounded limits, and unsupported configuration fields", async () => {
  const broker = new OsintProviderBrokerService({ credentialStore: new MemoryCredentialStore(), fetchImpl: async () => new Response("{}") });
  assert.throws(() => broker.configure("acled.events", { password: "should-not-be-stored" }), /unsupported fields/);
  await assert.rejects(() => broker.hunterQuery({ sourceId: "unknown.source" }), /registered credentialed/);
  broker.configure("acled.events", { "access-token": "ACLED-TOKEN-0123456789" });
  await assert.rejects(() => broker.hunterQuery({ sourceId: "acled.events", limit: 501 }), /between 1 and 500/);
});

test("GDELT BigQuery configuration is complete-only, parameterized, bounded, and secret-free", async () => {
  const store = new MemoryCredentialStore(); const token = "ya29.fixture-access-token-0123456789"; let requestUrl = ""; let requestBody = null; let authorization = "";
  const broker = new OsintProviderBrokerService({ credentialStore: store, now: () => Date.parse("2026-08-05T12:00:00Z"), fetchImpl: async (url, options) => {
    requestUrl = String(url); authorization = options.headers.Authorization; requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ schema: { fields: [{ name: "event_id" }] }, rows: [{ f: [{ v: "123" }] }] }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  assert.throws(() => broker.configure("gdelt.events", { "access-token": token }), /unsupported|project ID|format/i);
  assert.equal(store.get("vc-hunter-seeker.gdelt-bigquery", "project-id"), null);
  assert.throws(() => broker.configure("gdelt.events", { "project-id": "voidcat-public-data", "access-token": "short" }), /credential format/i);
  assert.equal(store.get("vc-hunter-seeker.gdelt-bigquery", "project-id"), null);
  const configured = broker.configure("gdelt.events", { "project-id": "voidcat-public-data", "access-token": token });
  assert.equal(configured.configured, true);
  const result = await broker.hunterQuery({ sourceId: "gdelt.events", bbox: { west: -98, south: 35, east: -97, north: 36 }, startAt: "2026-08-01T00:00:00Z", endAt: "2026-08-05T00:00:00Z", limit: 10 });
  assert.match(requestUrl, /bigquery\.googleapis\.com\/bigquery\/v2\/projects\/voidcat-public-data\/queries/);
  assert.equal(authorization, `Bearer ${token}`);
  assert.equal(requestBody.maximumBytesBilled, "5000000000");
  assert.equal(requestBody.parameterMode, "NAMED");
  assert.match(requestBody.query, /LIMIT 10$/);
  assert.equal(requestBody.query.includes("-98"), false);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(JSON.stringify(broker.getInvocations()).includes(token), false);
  assert.equal(broker.remove("gdelt.events").configured, false);
});
