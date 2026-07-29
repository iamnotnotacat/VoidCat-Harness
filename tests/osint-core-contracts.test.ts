import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { HunterSeekerPublicObservation } from "../build/hunter-seeker/hunter-seeker-service.ts";
import {
  DEFAULT_INVESTIGATION_BUDGET,
  HARD_INVESTIGATION_BUDGET,
  HunterSeekerIntakeAdapter,
  OSINT_CONTRACT_SCHEMAS,
  OSINT_SCHEMA_VERSION,
  OsintContractError,
  buildDeterministicInvestigationPlan,
  evaluateOsintPolicy,
  normalizeProviderResult,
  validateDeterministicPlan,
  validateInvestigationBudget,
  validateOsintContract,
  validateProviderDescriptor,
  type InvestigationSeed,
  type OsintInvestigationRequest,
  type OsintProviderDescriptor,
  type OsintProviderQuery,
  type OsintProviderResultDraft,
} from "../build/osint/index.ts";

const AT = "2026-07-28T12:00:00.000Z";
const INVESTIGATION_ID = "inv_contract_test";

function seed(type: InvestigationSeed["type"] = "domain", value = "Example.COM."): InvestigationSeed {
  return { type, value, label: value, attributes: {}, source: { kind: "operator", id: "operator-test" } };
}

function capability(id: OsintProviderDescriptor["capabilities"][number]["id"], seedTypes: InvestigationSeed["type"][], modes: OsintProviderDescriptor["capabilities"][number]["authorizationModes"] = ["public-research", "owned-asset", "authorized-client"]) {
  return { id, description: `${id} passive lookup`, seedTypes, authorizationModes: modes, producesEntityTypes: seedTypes, maximumQueriesPerInvestigation: 1, sensitive: id === "authorized-exposure-check" } satisfies OsintProviderDescriptor["capabilities"][number];
}

function provider(id: string, capabilities: OsintProviderDescriptor["capabilities"], authentication: OsintProviderDescriptor["authentication"] = { kind: "none" }): OsintProviderDescriptor {
  return {
    id, displayName: id, description: `${id} fixture provider`, passiveOnly: true, transport: authentication.kind === "none" ? "safe-web" : "electron-broker", authentication,
    capabilities, rateLimit: { requests: 10, windowMs: 60_000, maximumConcurrent: 1 }, cache: { ttlMs: 60_000, staleIfErrorMs: 300_000 }, reliability: 0.8,
    attribution: { provider: id, documentationUrl: `https://example.test/${id}/docs`, termsUrl: `https://example.test/${id}/terms` }, enabledByDefault: false,
  };
}

const searchProvider = provider("fixture.search", [capability("web-search", ["domain", "username", "organization", "event", "aircraft", "vessel", "satellite", "geographic-area"])]);
const infrastructureProvider = provider("fixture.infrastructure", [capability("domain-profile", ["domain"]), capability("ip-infrastructure", ["ip-address"])]);
const exposureProvider = provider("fixture.exposure", [capability("authorized-exposure-check", ["email-address"], ["exposure-check"])], { kind: "api-key", credentialNamespace: "vc-osint.fixture-exposure" });

function ordinaryRequest(overrides: Partial<OsintInvestigationRequest> = {}): OsintInvestigationRequest {
  return { seed: seed(), objective: "Find bounded public evidence about this domain.", authorizationMode: "public-research", budget: { ...DEFAULT_INVESTIGATION_BUDGET }, ...overrides };
}

function hunterObservation(input: Partial<HunterSeekerPublicObservation> & Pick<HunterSeekerPublicObservation, "observationId" | "entityId" | "entityType">): HunterSeekerPublicObservation {
  return {
    observationId: input.observationId, entityId: input.entityId, entityType: input.entityType,
    position: input.position ?? { latitude: 29.75, longitude: -95.36, altitudeMeters: 1_000 }, timestamp: input.timestamp ?? AT,
    provenance: input.provenance ?? { sourceFeedId: "fixture.hunter", fetchedAt: AT, receivedAt: AT, upstreamTimestamp: AT, stalenessMs: 0 },
    confidence: input.confidence ?? 0.9, basis: input.basis ?? "measured", retentionClass: input.retentionClass ?? "bulk", attributes: input.attributes ?? {},
  };
}

test("all eight OSINT contracts expose versioned closed schemas and reject unknown properties", () => {
  assert.deepEqual(Object.keys(OSINT_CONTRACT_SCHEMAS).sort(), ["claim", "entity", "evidence", "identifier", "investigation", "lead", "observation", "relationship"]);
  for (const [name, schema] of Object.entries(OSINT_CONTRACT_SCHEMAS)) {
    assert.equal(schema.additionalProperties, false, name); assert.equal(schema.type, "object", name); assert.match(schema.$id, /voidcat:\/\/osint\/1\.0\.0\//);
  }
  assert.throws(() => validateOsintContract("identifier", { schemaVersion: OSINT_SCHEMA_VERSION, id: "id_x", type: "domain", value: "example.com", normalizedValue: "example.com", confidence: 0.8, evidenceIds: [], secretExtra: "no" }), (error: unknown) => error instanceof OsintContractError && error.issues.some((issue) => issue.includes("unsupported property secretExtra")));
  assert.throws(() => validateOsintContract("identifier", { schemaVersion: OSINT_SCHEMA_VERSION, id: "id_x", type: "domain", value: "example.com", normalizedValue: "example.com", confidence: 2, evidenceIds: [] }), /confidence must be between 0 and 1/);
  assert.throws(() => validateOsintContract("entity", { schemaVersion: OSINT_SCHEMA_VERSION, id: "ent_empty", type: "domain", displayName: "Empty", identifiers: [], attributes: {}, createdAt: AT, updatedAt: AT }), /between 1 and 100/);
});

test("investigation budgets expose every requested dimension and fail closed above hard limits", () => {
  assert.deepEqual(Object.keys(DEFAULT_INVESTIGATION_BUDGET).sort(), ["maximumDiscoveryDepth", "maximumEntities", "maximumEvidenceBytes", "maximumExternalCalls", "maximumProviders", "maximumRuntimeMs"]);
  assert.deepEqual(validateInvestigationBudget({ ...DEFAULT_INVESTIGATION_BUDGET }), DEFAULT_INVESTIGATION_BUDGET);
  assert.throws(() => validateInvestigationBudget({ ...DEFAULT_INVESTIGATION_BUDGET, maximumProviders: HARD_INVESTIGATION_BUDGET.maximumProviders + 1 }), /maximumProviders exceeds the hard maximum/);
  assert.throws(() => validateInvestigationBudget({ ...DEFAULT_INVESTIGATION_BUDGET, hiddenLimit: 1 }), /unsupported property hiddenLimit/);
  assert.throws(() => validateInvestigationBudget({ ...DEFAULT_INVESTIGATION_BUDGET, maximumRuntimeMs: 49 }), /maximumRuntimeMs must be an integer of at least 50/);
});

test("provider descriptors are passive, capability-rich, bounded, and credential namespaced", () => {
  assert.deepEqual(validateProviderDescriptor(searchProvider), searchProvider);
  assert.throws(() => validateProviderDescriptor({ ...searchProvider, passiveOnly: false } as unknown as OsintProviderDescriptor), /passive-only/);
  assert.throws(() => validateProviderDescriptor({ ...exposureProvider, authentication: { kind: "api-key" } }), /protected credential namespace/);
  assert.equal(searchProvider.capabilities[0].seedTypes.includes("domain"), true);
  assert.equal(exposureProvider.capabilities[0].sensitive, true);
});

test("policy requires exact authorization for exposure checks and excludes sensitive capabilities otherwise", () => {
  const publicDecision = evaluateOsintPolicy(ordinaryRequest(), [exposureProvider, searchProvider], AT);
  assert.equal(publicDecision.outcome, "allow"); assert.deepEqual(publicDecision.allowedProviderIds, ["fixture.search"]); assert.ok(!publicDecision.allowedCapabilityIds.includes("authorized-exposure-check"));
  const exposureRequest = ordinaryRequest({ seed: seed("email-address", "person@example.test"), authorizationMode: "exposure-check", requestedCapabilityIds: ["authorized-exposure-check"] });
  const held = evaluateOsintPolicy(exposureRequest, [exposureProvider], AT);
  assert.equal(held.outcome, "require-confirmation"); assert.equal(held.requiresOperatorConfirmation, true);
  const allowed = evaluateOsintPolicy({ ...exposureRequest, exposureConfirmation: { confirmed: true, exactTarget: "person@example.test", statement: "I am explicitly authorized to check this exact account." } }, [exposureProvider], AT);
  assert.equal(allowed.outcome, "allow"); assert.deepEqual(allowed.allowedCapabilityIds, ["authorized-exposure-check"]);
  const wrongTarget = evaluateOsintPolicy({ ...exposureRequest, exposureConfirmation: { confirmed: true, exactTarget: "different@example.test", statement: "I am explicitly authorized to check this exact account." } }, [exposureProvider], AT);
  assert.equal(wrongTarget.outcome, "require-confirmation");
});

test("plans are deterministic, provider-order independent, budgeted, and never auto-follow leads", () => {
  const request = ordinaryRequest();
  const decisionA = evaluateOsintPolicy(request, [searchProvider, infrastructureProvider], AT);
  const decisionB = evaluateOsintPolicy(request, [infrastructureProvider, searchProvider], AT);
  assert.equal(decisionA.id, decisionB.id);
  const planA = buildDeterministicInvestigationPlan(request, [searchProvider, infrastructureProvider], decisionA, AT);
  const planB = buildDeterministicInvestigationPlan(request, [infrastructureProvider, searchProvider], decisionB, AT);
  assert.deepEqual(planA, planB); validateDeterministicPlan(planA);
  assert.ok(planA.steps.length > 0); assert.ok(planA.reservations.providers <= request.budget!.maximumProviders); assert.ok(planA.reservations.externalCalls <= request.budget!.maximumExternalCalls);
  assert.equal(planA.execution.followCandidateLeadsAutomatically, false); assert.ok(planA.steps.every((step) => step.expansion.automatic === false && step.expansion.discoveredEntitiesBecome === "candidate-leads"));
  assert.throws(() => buildDeterministicInvestigationPlan(request, [searchProvider, infrastructureProvider], { ...decisionA, allowedProviderIds: ["fixture.search"] }, AT), /does not match the request/);
  const tinyRequest = ordinaryRequest({ budget: { ...DEFAULT_INVESTIGATION_BUDGET, maximumEvidenceBytes: 1, maximumEntities: 1 } });
  const tinyDecision = evaluateOsintPolicy(tinyRequest, [searchProvider, infrastructureProvider], AT); const tinyPlan = buildDeterministicInvestigationPlan(tinyRequest, [searchProvider, infrastructureProvider], tinyDecision, AT);
  assert.equal(tinyPlan.steps.length, 1); validateDeterministicPlan(tinyPlan);
});

function queryFor(providerValue: OsintProviderDescriptor): OsintProviderQuery {
  return { id: "query_fixture", providerId: providerValue.id, capabilityId: providerValue.capabilities[0].id, operation: "fixture", seed: seed(), parameters: {}, purpose: "Fixture normalization", cacheKey: "cache_fixture", estimatedExternalCalls: 1, maximumResponseBytes: 50_000 };
}

function resultDraft(): OsintProviderResultDraft {
  return {
    entities: [
      { ref: "domain", type: "domain", displayName: "Example", identifiers: [{ type: "domain", value: "Example.COM." }, { type: "domain", value: "example.com" }], attributes: { category: "fixture" } },
      { ref: "ip", type: "ip-address", displayName: "192.0.2.10", identifiers: [{ type: "ipv4", value: "192.0.2.10" }], attributes: {} },
    ],
    evidence: [{ ref: "record", sourceRef: "fixture:record:1", title: "Fixture record", excerpt: "Example.COM resolves to the documentation address 192.0.2.10.", byteLength: 82, sensitivity: "public" }],
    observations: [{ ref: "domain-observation", entityRef: "domain", evidenceRefs: ["record"], attributes: { resolvedAddress: "192.0.2.10" }, confidence: 0.8, directness: "direct", freshness: "recent" }],
    relationships: [{ ref: "resolution", sourceEntityRef: "domain", targetEntityRef: "ip", type: "resolves-to", evidenceRefs: ["record"], confidence: 0.8, status: "observed" }],
    leads: [{ ref: "ip-lead", entityRef: "ip", seed: seed("ip-address", "192.0.2.10"), reason: "A related documentation address was observed.", depth: 1, evidenceRefs: ["record"] }],
    coverageLimitations: ["Fixture data is not live."], warnings: [],
  };
}

test("provider normalization creates stable contracts, deduplicates identifiers, accounts bytes, and validates references", () => {
  const context = { investigationId: INVESTIGATION_ID, query: queryFor(infrastructureProvider), provider: infrastructureProvider, retrievedAt: AT, budget: { ...DEFAULT_INVESTIGATION_BUDGET }, cache: { status: "fixture" as const, ageMs: 0 } };
  const first = normalizeProviderResult(resultDraft(), context); const second = normalizeProviderResult(resultDraft(), context);
  assert.deepEqual(first, second); assert.equal(first.entities[0].identifiers.length, 1); assert.equal(first.entities[0].identifiers[0].normalizedValue, "example.com");
  assert.equal(first.accounting.evidenceBytes, 82); assert.equal(first.relationships[0].evidenceIds[0], first.evidence[0].id); assert.equal(first.leads[0].status, "candidate");
  validateOsintContract("entity", first.entities[0]); validateOsintContract("evidence", first.evidence[0]); validateOsintContract("observation", first.observations[0]); validateOsintContract("relationship", first.relationships[0]); validateOsintContract("lead", first.leads[0]);
  const missing = resultDraft(); missing.observations[0].evidenceRefs = ["missing"];
  assert.throws(() => normalizeProviderResult(missing, context), /references missing evidence missing/);
  assert.throws(() => normalizeProviderResult(resultDraft(), { ...context, budget: { ...DEFAULT_INVESTIGATION_BUDGET, maximumEvidenceBytes: 50 } }), /exceeds the investigation byte budget/);
  assert.throws(() => normalizeProviderResult({ ...resultDraft(), untrustedExtra: true } as unknown as OsintProviderResultDraft, context), /unsupported properties/);
  const nestedExtra = resultDraft(); (nestedExtra.entities[0] as unknown as Record<string, unknown>).secretExtra = "reject";
  assert.throws(() => normalizeProviderResult(nestedExtra, context), /entities\[0\] contains unsupported properties: secretExtra/);
});

test("claim and investigation contracts validate complete supported records", () => {
  const claim = validateOsintContract("claim", { schemaVersion: OSINT_SCHEMA_VERSION, id: "claim_fixture", investigationId: INVESTIGATION_ID, subjectEntityId: "ent_fixture", predicate: "resolves-to", value: "192.0.2.10", status: "supported", evidenceIds: ["ev_fixture"], observationIds: ["obs_fixture"], confidence: 0.8, confidenceCategory: "high", explanation: "One direct fixture record supports this claim." });
  assert.equal(claim.status, "supported");
  const investigation = validateOsintContract("investigation", { schemaVersion: OSINT_SCHEMA_VERSION, id: INVESTIGATION_ID, seed: seed(), objective: "Fixture investigation", authorizationMode: "public-research", status: "planned", budget: { ...DEFAULT_INVESTIGATION_BUDGET }, planId: "plan_fixture", counts: { providers: 0, externalCalls: 0, entities: 0, evidenceBytes: 0, leads: 0 }, warnings: [], createdAt: AT, updatedAt: AT });
  assert.equal(investigation.budget.maximumDiscoveryDepth, 1);
  assert.throws(() => validateOsintContract("investigation", { ...investigation, status: "completed" }), /terminal investigations require completedAt/);
  assert.throws(() => validateOsintContract("investigation", { ...investigation, counts: { ...investigation.counts, externalCalls: investigation.budget.maximumExternalCalls + 1 } }), /external-call count exceeds budget/);
  assert.throws(() => validateOsintContract("claim", { ...claim, confidence: 0.1, confidenceCategory: "very-high" }), /confidenceCategory does not match confidence/);
});

test("Hunter-Seeker intake maps aircraft, vessel, satellite, and event evidence with exact provenance", () => {
  const adapter = new HunterSeekerIntakeAdapter();
  const fixtures = [
    hunterObservation({ observationId: "air-1", entityId: "aircraft:ABC123", entityType: "military-aircraft", attributes: { title: "VOID1", transponderHex: "abc123", callsign: "VOID 1", registration: "N100VC" } }),
    hunterObservation({ observationId: "vessel-1", entityId: "vessel:123456789", entityType: "maritime-vessel", attributes: { mmsi: "123456789", shipName: "TEST SHIP" } }),
    hunterObservation({ observationId: "space-1", entityId: "space-station:25544", entityType: "space-station", basis: "estimated", attributes: { title: "ISS", noradCatalogId: "25544", internationalDesignator: "1998-067A" } }),
    hunterObservation({ observationId: "quake-1", entityId: "earthquake:test", entityType: "earthquake", attributes: { title: "M4.0 test event", magnitude: 4 } }),
  ];
  const expectedTypes = ["aircraft", "vessel", "satellite", "event"];
  fixtures.forEach((fixture, index) => {
    const result = adapter.adaptObservation(fixture, { investigationId: INVESTIGATION_ID, receivedAt: AT });
    assert.equal(result.entity.type, expectedTypes[index]); assert.equal(result.seed.source.observationId, fixture.observationId); assert.equal(result.evidence.metadata.hunterObservationId, fixture.observationId);
    assert.equal(result.observation.evidenceIds[0], result.evidence.id); assert.equal(result.observation.providerId, "hunter-seeker"); assert.ok(!("rawPayload" in result.evidence.metadata));
    assert.deepEqual(result, adapter.adaptObservation(fixture, { investigationId: INVESTIGATION_ID, receivedAt: AT }));
  });
  const region = adapter.adaptRegion({ label: "Antimeridian area", bounds: { west: 170, south: 20, east: -170, north: 40 } });
  assert.equal(region.type, "geographic-area"); assert.equal(region.attributes.geometryType, "bbox");
});

test("Gate 1 implementation has no network, database, filesystem-write, or credential transport primitive", async () => {
  const files = ["contracts.ts", "provider-contracts.ts", "policy-and-planner.ts", "hunter-seeker-intake.ts", "index.ts"];
  const sources = await Promise.all(files.map((file) => readFile(path.join(process.cwd(), "build", "osint", file), "utf8")));
  const joined = sources.join("\n");
  for (const forbidden of [/\bfetch\s*\(/, /node:https?/, /node:(?:net|tls|dns)/, /DatabaseSync/, /writeFile/, /safeStorage/, /credentialStore/]) assert.doesNotMatch(joined, forbidden);
});
