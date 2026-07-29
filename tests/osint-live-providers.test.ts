import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_INVESTIGATION_BUDGET, type InvestigationSeed } from "../build/osint/contracts.ts";
import {
  LIVE_OSINT_PROVIDER_ADAPTERS,
  LIVE_OSINT_PROVIDER_DESCRIPTORS,
  generateOpenSquatStyleCandidates,
  normalizeLiveProviderResult,
  type LiveOsintProviderId,
} from "../build/osint/live-provider-adapters.ts";
import { osintStableId, validateProviderDescriptor } from "../build/osint/provider-contracts.ts";
import { evaluateOsintPolicy } from "../build/osint/policy-and-planner.ts";

function seed(type: InvestigationSeed["type"], value: string): InvestigationSeed { return { type, value, attributes: {}, source: { kind: "operator", id: "fixture" } }; }

const fixtures: Record<LiveOsintProviderId, { seed: InvestigationSeed; raw: unknown; mode: "public-research" | "exposure-check" }> = {
  deflock: { seed: seed("geographic-area", "29,-99,31,-97"), raw: [{ observationId: "deflock.osm-alpr:node:1", entityId: "alpr-camera:osm-node:1" }], mode: "public-research" },
  searxng: { seed: seed("domain", "example.com"), raw: { results: [{ title: "Example Domain", url: "https://example.com/", content: "Example result", engine: "fixture" }] }, mode: "public-research" },
  "opensquat-local": { seed: seed("domain", "example.com"), raw: generateOpenSquatStyleCandidates("example.com", 12), mode: "public-research" },
  shodan: { seed: seed("ip-address", "192.0.2.10"), raw: { ip_str: "192.0.2.10", ports: [80, 443], hostnames: ["test.example"], org: "Fixture Org", asn: "AS64500", last_update: "2026-07-28T00:00:00Z" }, mode: "public-research" },
  censys: { seed: seed("ip-address", "192.0.2.11"), raw: { result: { resource: { services: [{ port: 443, service_name: "HTTPS", observed_at: "2026-07-28T00:00:00Z" }], last_updated_at: "2026-07-28T00:00:00Z" } } }, mode: "public-research" },
  hibp: { seed: seed("email-address", "authorized@example.com"), raw: [{ Name: "FixtureBreach", BreachDate: "2025-01-01", DataClasses: ["Email addresses"] }], mode: "exposure-check" },
};

test("Gate 4 registers exactly six passive providers with capability, cache, rate, auth, and attribution metadata", () => {
  assert.deepEqual(LIVE_OSINT_PROVIDER_DESCRIPTORS.map(({ id }) => id), ["deflock", "searxng", "opensquat-local", "shodan", "censys", "hibp"]);
  for (const descriptor of LIVE_OSINT_PROVIDER_DESCRIPTORS) {
    assert.equal(descriptor.passiveOnly, true);
    assert.ok(descriptor.capabilities.length);
    assert.ok(descriptor.rateLimit.requests > 0 && descriptor.rateLimit.windowMs >= 1_000);
    assert.ok(descriptor.cache.ttlMs >= 1_000);
    assert.match(descriptor.attribution.documentationUrl, /^https:/);
    if (descriptor.authentication.kind !== "none") assert.match(descriptor.authentication.credentialNamespace ?? "", /^vc-osint\./);
  }
  for (const providerId of ["searxng", "shodan", "censys", "hibp"]) {
    const setup = LIVE_OSINT_PROVIDER_DESCRIPTORS.find(({ id }) => id === providerId)?.setup;
    assert.ok(setup, `${providerId} requires a guided setup contract`);
    assert.match(setup.acquisitionUrl, /^https:\/\//);
    assert.ok(setup.actionLabel.length > 3);
    assert.ok(setup.steps.length >= 3);
  }
});

test("every live adapter passes deterministic fixture normalization without network access", () => {
  for (const adapter of LIVE_OSINT_PROVIDER_ADAPTERS) {
    const fixture = fixtures[adapter.descriptor.id as LiveOsintProviderId];
    const support = adapter.supports(fixture.seed, fixture.mode);
    assert.equal(support.supported, true, adapter.descriptor.id);
    const investigationId = osintStableId("inv", { provider: adapter.descriptor.id });
    const query = adapter.plan(fixture.seed, { investigationId, objective: "Fixture normalization", authorizationMode: fixture.mode, budget: DEFAULT_INVESTIGATION_BUDGET })[0];
    const result = normalizeLiveProviderResult(adapter.descriptor.id as LiveOsintProviderId, fixture.raw, { investigationId, query, provider: adapter.descriptor, retrievedAt: "2026-07-28T01:00:00Z", budget: DEFAULT_INVESTIGATION_BUDGET, cache: { status: "fixture", ageMs: 0 } });
    assert.equal(result.providerId, adapter.descriptor.id);
    assert.ok(result.entities.length >= 1);
    assert.ok(result.evidence.length >= 1);
    assert.ok(result.observations.length >= 1);
    assert.ok(result.evidence.every(({ id }) => result.observations.some(({ evidenceIds }) => evidenceIds.includes(id)) || adapter.descriptor.id === "searxng"));
  }
});

test("guided provider acquisition links reject non-HTTPS destinations", () => {
  const descriptor = LIVE_OSINT_PROVIDER_DESCRIPTORS.find(({ id }) => id === "shodan")!;
  assert.throws(() => validateProviderDescriptor({ ...descriptor, setup: { ...descriptor.setup!, acquisitionUrl: "http://account.example.test/" } }), /setup URLs must use HTTPS/);
});

test("OpenSquat-style generation is local, bounded, deterministic, and makes no maliciousness claim", () => {
  const first = generateOpenSquatStyleCandidates("Example.COM", 20);
  const second = generateOpenSquatStyleCandidates("example.com", 20);
  assert.deepEqual(first, second);
  assert.ok(first.length > 5 && first.length <= 20);
  assert.ok(first.every((value) => value !== "example.com"));
});

test("HIBP requires exact fresh authorization for email or domain and emits no expansion leads", () => {
  const descriptor = LIVE_OSINT_PROVIDER_DESCRIPTORS.find(({ id }) => id === "hibp")!;
  const domainSeed = seed("domain", "example.com");
  const denied = evaluateOsintPolicy({ seed: domainSeed, objective: "Exposure check", authorizationMode: "exposure-check", requestedProviderIds: ["hibp"] }, [descriptor], "2026-07-28T01:00:00Z");
  assert.equal(denied.outcome, "require-confirmation");
  const allowed = evaluateOsintPolicy({ seed: domainSeed, objective: "Exposure check", authorizationMode: "exposure-check", requestedProviderIds: ["hibp"], exposureConfirmation: { confirmed: true, exactTarget: "example.com", statement: "I am authorized to check this verified domain." } }, [descriptor], "2026-07-28T01:00:00Z");
  assert.equal(allowed.outcome, "allow");
  const fixture = fixtures.hibp; const adapter = LIVE_OSINT_PROVIDER_ADAPTERS.find(({ descriptor: value }) => value.id === "hibp")!;
  const query = adapter.plan(fixture.seed, { investigationId: "fixture", objective: "Authorized", authorizationMode: "exposure-check", budget: DEFAULT_INVESTIGATION_BUDGET })[0];
  const result = normalizeLiveProviderResult("hibp", fixture.raw, { investigationId: "fixture", query, provider: adapter.descriptor, retrievedAt: "2026-07-28T01:00:00Z", budget: DEFAULT_INVESTIGATION_BUDGET, cache: { status: "fixture", ageMs: 0 } });
  assert.equal(result.leads.length, 0);
  assert.ok(result.evidence.every(({ sensitivity }) => sensitivity === "exposure-sensitive"));
  assert.equal(result.observations[0].attributes.hunterForwarding, "blocked-pending-approval");

  const domainQuery = adapter.plan(domainSeed, { investigationId: "domain-fixture", objective: "Authorized", authorizationMode: "exposure-check", budget: DEFAULT_INVESTIGATION_BUDGET })[0];
  const domainResult = normalizeLiveProviderResult("hibp", [{ account: "a***@example.com", breaches: ["FixtureBreach", "OtherBreach"] }], { investigationId: "domain-fixture", query: domainQuery, provider: adapter.descriptor, retrievedAt: "2026-07-28T01:00:00Z", budget: DEFAULT_INVESTIGATION_BUDGET, cache: { status: "fixture", ageMs: 0 } });
  assert.deepEqual(domainResult.observations[0].attributes.breachNames, ["FixtureBreach", "OtherBreach"]);
  assert.equal(domainResult.observations[0].attributes.affectedAccountCount, 1);
  assert.ok(!JSON.stringify(domainResult).includes("a***@example.com"));
});
