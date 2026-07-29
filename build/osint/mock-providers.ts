import {
  DEFAULT_INVESTIGATION_BUDGET,
  validateInvestigationSeed,
  type InvestigationSeed,
  type OsintAuthorizationMode,
  type OsintEntityType,
  type OsintIdentifierType,
} from "./contracts.ts";
import {
  osintStableId,
  validateProviderDescriptor,
  type OsintProviderAdapter,
  type OsintProviderCapabilityId,
  type OsintProviderDescriptor,
  type OsintProviderNormalizationContext,
  type OsintProviderPlanningContext,
  type OsintProviderQuery,
  type OsintProviderResultDraft,
  type OsintProviderSupportDecision,
} from "./provider-contracts.ts";

type MockRawResponse = {
  fixtureVersion: "1.0.0";
  providerId: string;
  queryId: string;
  draft: OsintProviderResultDraft;
};

type MockFixtureBuilder = (query: OsintProviderQuery) => OsintProviderResultDraft;

export interface MockOsintProvider extends OsintProviderAdapter<MockRawResponse> {
  fixture(query: OsintProviderQuery): MockRawResponse;
}

function descriptor(
  id: string,
  displayName: string,
  reliability: number,
  capabilities: Array<{ id: OsintProviderCapabilityId; seedTypes: OsintEntityType[]; produces: OsintEntityType[] }>,
): OsintProviderDescriptor {
  return validateProviderDescriptor({
    id, displayName, description: `${displayName} deterministic offline fixture provider.`, passiveOnly: true, transport: "local", authentication: { kind: "none" },
    capabilities: capabilities.map((capability) => ({
      id: capability.id, description: `${displayName} ${capability.id} fixture capability.`, seedTypes: capability.seedTypes,
      authorizationModes: ["public-research", "owned-asset", "authorized-client"], producesEntityTypes: capability.produces,
      maximumQueriesPerInvestigation: 1, sensitive: false,
    })),
    rateLimit: { requests: 100, windowMs: 60_000, maximumConcurrent: 2 }, cache: { ttlMs: 60_000, staleIfErrorMs: 300_000 }, reliability,
    attribution: { provider: displayName, documentationUrl: `https://example.com/voidcat-fixtures/${id}`, termsUrl: "https://example.com/terms" }, enabledByDefault: true,
  });
}

class DeterministicMockProvider implements MockOsintProvider {
  readonly descriptor: OsintProviderDescriptor;
  private readonly buildFixture: MockFixtureBuilder;

  constructor(providerDescriptor: OsintProviderDescriptor, buildFixture: MockFixtureBuilder) {
    this.descriptor = providerDescriptor;
    this.buildFixture = buildFixture;
  }

  supports(seed: InvestigationSeed, authorizationMode: OsintAuthorizationMode): OsintProviderSupportDecision {
    validateInvestigationSeed(seed);
    const capabilities = this.descriptor.capabilities.filter((capability) => capability.seedTypes.includes(seed.type) && capability.authorizationModes.includes(authorizationMode));
    return {
      supported: capabilities.length > 0, capabilityIds: capabilities.map(({ id }) => id),
      reasons: capabilities.length ? ["A deterministic fixture capability supports this seed."] : ["This fixture provider does not support the seed type."],
      requiresCredential: false, requiresExplicitAuthorization: false,
    };
  }

  plan(seed: InvestigationSeed, context: OsintProviderPlanningContext): OsintProviderQuery[] {
    const support = this.supports(seed, context.authorizationMode);
    return support.capabilityIds.slice(0, context.budget.maximumExternalCalls).map((capabilityId) => ({
      id: osintStableId("query", { providerId: this.descriptor.id, capabilityId, seed, objective: context.objective }), providerId: this.descriptor.id,
      capabilityId, operation: capabilityId, seed: structuredClone(seed), parameters: { seedType: seed.type, seedValue: seed.value }, purpose: context.objective,
      cacheKey: osintStableId("cache", { providerId: this.descriptor.id, capabilityId, seed }), estimatedExternalCalls: 1,
      maximumResponseBytes: Math.min(256 * 1024, context.budget.maximumEvidenceBytes),
    }));
  }

  fixture(query: OsintProviderQuery): MockRawResponse {
    if (query.providerId !== this.descriptor.id) throw new Error("Mock fixture query addressed the wrong provider.");
    return { fixtureVersion: "1.0.0", providerId: this.descriptor.id, queryId: query.id, draft: this.buildFixture(query) };
  }

  normalize(raw: MockRawResponse, context: OsintProviderNormalizationContext): OsintProviderResultDraft {
    if (!raw || raw.fixtureVersion !== "1.0.0" || raw.providerId !== this.descriptor.id || raw.queryId !== context.query.id) throw new Error("Mock provider response envelope is invalid.");
    return structuredClone(raw.draft);
  }
}

function evidence(providerId: string, ref: string, title: string, excerpt: string) {
  return { ref, sourceRef: `fixture:${providerId}:${ref}`, title, excerpt, url: `https://example.com/voidcat-fixtures/${providerId}/${ref}`, byteLength: Buffer.byteLength(excerpt), sensitivity: "public" as const, metadata: { fixture: true, providerId } };
}

function domainFixture(providerId: string, query: OsintProviderQuery, variant: "dns" | "certificate" | "search"): OsintProviderResultDraft {
  const domain = query.seed.value.trim().toLowerCase().replace(/\.$/, "");
  const organization = "Example Research Cooperative";
  if (variant === "dns") {
    return {
      entities: [
        { ref: "domain", type: "domain", displayName: domain, identifiers: [{ type: "domain", value: query.seed.value }], attributes: { fixtureRole: "seed" } },
        { ref: "ip", type: "ip-address", displayName: "192.0.2.10", identifiers: [{ type: "ipv4", value: "192.0.2.10" }], attributes: { reservedDocumentationAddress: true } },
      ],
      evidence: [evidence(providerId, "dns-record", "Passive DNS fixture", `${domain} was associated with documentation address 192.0.2.10 in the offline fixture.`)],
      observations: [
        { ref: "domain-dns", entityRef: "domain", evidenceRefs: ["dns-record"], attributes: { organization, registrationStatus: "active-fixture" }, confidence: 0.82, directness: "direct", freshness: "recent" },
        { ref: "ip-record", entityRef: "ip", evidenceRefs: ["dns-record"], attributes: { address: "192.0.2.10", addressClass: "documentation-only" }, confidence: 0.99, directness: "direct", freshness: "recent" },
      ],
      relationships: [{ ref: "domain-ip", sourceEntityRef: "domain", targetEntityRef: "ip", type: "resolves-to", evidenceRefs: ["dns-record"], confidence: 0.82, status: "observed" }],
      leads: [{ ref: "ip-lead", entityRef: "ip", seed: { type: "ip-address", value: "192.0.2.10", label: "Documentation IP", attributes: {}, source: { kind: "candidate-lead", id: providerId } }, reason: "The passive fixture associated this address with the seed domain.", depth: 1, evidenceRefs: ["dns-record"] }],
      coverageLimitations: ["Offline fixture data does not describe the live DNS state."], warnings: [],
    };
  }
  if (variant === "certificate") {
    const fingerprint = "a".repeat(64);
    return {
      entities: [
        { ref: "domain", type: "domain", displayName: domain.toUpperCase(), identifiers: [{ type: "domain", value: domain }], attributes: { fixtureRole: "certificate-subject" } },
        { ref: "certificate", type: "certificate", displayName: "Fixture TLS certificate", identifiers: [{ type: "certificate-sha256", value: fingerprint }], attributes: { fixture: true } },
        { ref: "organization", type: "organization", displayName: organization, identifiers: [{ type: "organization-name", value: organization }], attributes: { fixture: true } },
      ],
      evidence: [evidence(providerId, "certificate-record", "Certificate transparency fixture", `A synthetic certificate record linked ${domain} and ${organization}. No live certificate service was queried.`)],
      observations: [
        { ref: "domain-certificate", entityRef: "domain", evidenceRefs: ["certificate-record"], attributes: { organization, certificateFingerprint: fingerprint }, confidence: 0.88, directness: "direct", freshness: "recent" },
        { ref: "certificate-record", entityRef: "certificate", evidenceRefs: ["certificate-record"], attributes: { sha256: fingerprint }, confidence: 0.95, directness: "direct", freshness: "recent" },
      ],
      relationships: [
        { ref: "domain-certificate", sourceEntityRef: "domain", targetEntityRef: "certificate", type: "presents-certificate", evidenceRefs: ["certificate-record"], confidence: 0.88, status: "observed" },
        { ref: "domain-organization", sourceEntityRef: "domain", targetEntityRef: "organization", type: "associated-with", evidenceRefs: ["certificate-record"], confidence: 0.76, status: "observed" },
      ],
      leads: [{ ref: "organization-lead", entityRef: "organization", seed: { type: "organization", value: organization, label: organization, attributes: {}, source: { kind: "candidate-lead", id: providerId } }, reason: "The certificate fixture named an associated organization.", depth: 1, evidenceRefs: ["certificate-record"] }],
      coverageLimitations: ["The synthetic certificate record cannot establish current ownership."], warnings: [],
    };
  }
  return {
    entities: [
      { ref: "domain", type: "domain", displayName: domain, identifiers: [{ type: "domain", value: `${domain}.` }], attributes: { fixtureRole: "search-result" } },
      { ref: "organization", type: "organization", displayName: organization, identifiers: [{ type: "organization-name", value: organization.toUpperCase() }], attributes: { fixture: true } },
      { ref: "username", type: "username", displayName: "example_research", identifiers: [{ type: "username", value: "example_research" }], attributes: { fixture: true } },
    ],
    evidence: [evidence(providerId, "search-result", "Public web fixture", `A deterministic public-page fixture mentioned ${domain}, ${organization}, and the handle example_research.`)],
    observations: [
      { ref: "domain-search", entityRef: "domain", evidenceRefs: ["search-result"], attributes: { organization, publicMention: true }, confidence: 0.68, directness: "direct", freshness: "recent" },
      { ref: "organization-search", entityRef: "organization", evidenceRefs: ["search-result"], attributes: { organizationName: organization }, confidence: 0.68, directness: "direct", freshness: "recent" },
    ],
    relationships: [{ ref: "domain-org", sourceEntityRef: "domain", targetEntityRef: "organization", type: "publicly-mentioned-with", evidenceRefs: ["search-result"], confidence: 0.62, status: "observed" }],
    leads: [{ ref: "username-lead", entityRef: "username", seed: { type: "username", value: "example_research", label: "example_research", attributes: {}, source: { kind: "candidate-lead", id: providerId } }, reason: "A public fixture mentioned this handle near the seed domain.", depth: 1, evidenceRefs: ["search-result"] }],
    coverageLimitations: ["Co-mention does not prove common ownership or control."], warnings: [],
  };
}

function identifierForSeed(seed: InvestigationSeed): { type: OsintIdentifierType; value: string } {
  if (seed.type === "aircraft") return { type: "aircraft-icao", value: seed.value };
  if (seed.type === "vessel") return { type: "vessel-mmsi", value: seed.value };
  if (seed.type === "satellite") return { type: "satellite-norad", value: seed.value };
  return { type: "hunter-entity", value: seed.value };
}

function hunterContextFixture(providerId: string, query: OsintProviderQuery): OsintProviderResultDraft {
  const identifier = identifierForSeed(query.seed);
  const title = query.seed.label ?? query.seed.value;
  return {
    entities: [{ ref: "seed", type: query.seed.type, displayName: title, identifiers: [identifier], attributes: { fixtureContext: true } }],
    evidence: [evidence(providerId, "context-record", "Hunter context fixture", `Offline context fixture for ${query.seed.type} ${title}; no live source was queried.`)],
    observations: [{ ref: "seed-context", entityRef: "seed", evidenceRefs: ["context-record"], attributes: { contextAvailable: true, contextKind: query.capabilityId }, confidence: 0.72, directness: "derived", freshness: "recent" }],
    relationships: [], leads: [], coverageLimitations: ["This is synthetic context and must not be treated as a live identification."], warnings: [],
  };
}

export function createDefaultMockProviders(): MockOsintProvider[] {
  const providers: MockOsintProvider[] = [
    new DeterministicMockProvider(descriptor("mock.passive-dns", "Mock Passive DNS", 0.84, [{ id: "passive-dns", seedTypes: ["domain"], produces: ["domain", "ip-address"] }]), (query) => domainFixture("mock.passive-dns", query, "dns")),
    new DeterministicMockProvider(descriptor("mock.certificate", "Mock Certificate Index", 0.9, [{ id: "certificate-search", seedTypes: ["domain"], produces: ["domain", "certificate", "organization"] }]), (query) => domainFixture("mock.certificate", query, "certificate")),
    new DeterministicMockProvider(descriptor("mock.search", "Mock Public Search", 0.72, [{ id: "web-search", seedTypes: ["domain"], produces: ["domain", "organization", "username"] }]), (query) => domainFixture("mock.search", query, "search")),
    new DeterministicMockProvider(descriptor("mock.hunter-context", "Mock Hunter Context", 0.75, [
      { id: "aviation-context", seedTypes: ["aircraft"], produces: ["aircraft"] },
      { id: "maritime-context", seedTypes: ["vessel"], produces: ["vessel"] },
      { id: "orbital-context", seedTypes: ["satellite"], produces: ["satellite"] },
      { id: "event-context", seedTypes: ["event", "geographic-area"], produces: ["event", "geographic-area"] },
    ]), (query) => hunterContextFixture("mock.hunter-context", query)),
  ];
  return providers.sort((left, right) => left.descriptor.id.localeCompare(right.descriptor.id));
}

export class MockProviderExecutor {
  private readonly providers: Map<string, MockOsintProvider>;
  private readonly delayMs: number;

  constructor(providers: readonly MockOsintProvider[] = createDefaultMockProviders(), options: { delayMs?: number } = {}) {
    this.providers = new Map(providers.map((provider) => [provider.descriptor.id, provider]));
    if (this.providers.size !== providers.length) throw new Error("Mock provider identifiers must be unique.");
    this.delayMs = Math.max(0, Math.min(10_000, Math.round(options.delayMs ?? 0)));
  }

  list() {
    return [...this.providers.values()];
  }

  resolve(providerId: string) {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error(`Mock provider ${providerId} is not registered.`);
    return provider;
  }

  async query(query: OsintProviderQuery, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason ?? new Error("Mock provider query was cancelled.");
    if (this.delayMs) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { signal.removeEventListener("abort", cancelled); resolve(); }, this.delayMs);
      const cancelled = () => { clearTimeout(timer); reject(signal.reason ?? new Error("Mock provider query was cancelled.")); };
      signal.addEventListener("abort", cancelled, { once: true });
    });
    if (signal.aborted) throw signal.reason ?? new Error("Mock provider query was cancelled.");
    return this.resolve(query.providerId).fixture(query);
  }
}

export const MOCK_INVESTIGATION_BUDGET = Object.freeze({ ...DEFAULT_INVESTIGATION_BUDGET, maximumProviders: 4, maximumExternalCalls: 8, maximumRuntimeMs: 30_000, maximumEntities: 100, maximumEvidenceBytes: 512 * 1024, maximumDiscoveryDepth: 1 });
