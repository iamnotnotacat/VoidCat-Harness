import {
  normalizeProviderResult,
  osintStableId,
  validateProviderDescriptor,
  type NormalizedOsintProviderResult,
  type OsintProviderAdapter,
  type OsintProviderCapability,
  type OsintProviderDescriptor,
  type OsintProviderNormalizationContext,
  type OsintProviderPlanningContext,
  type OsintProviderQuery,
  type OsintProviderResultDraft,
  type OsintProviderSupportDecision,
} from "./provider-contracts.ts";
import type { InvestigationSeed, OsintAuthorizationMode, OsintIdentifierType, OsintJsonRecord } from "./contracts.ts";

export const LIVE_OSINT_PROVIDER_IDS = ["deflock", "searxng", "opensquat-local", "shodan", "censys", "hibp"] as const;
export type LiveOsintProviderId = typeof LIVE_OSINT_PROVIDER_IDS[number];

function capability(value: Omit<OsintProviderCapability, "maximumQueriesPerInvestigation" | "sensitive"> & Partial<Pick<OsintProviderCapability, "maximumQueriesPerInvestigation" | "sensitive">>): OsintProviderCapability {
  return { maximumQueriesPerInvestigation: 1, sensitive: false, ...value };
}

export const LIVE_OSINT_PROVIDER_DESCRIPTORS: readonly OsintProviderDescriptor[] = [
  {
    id: "deflock", displayName: "DeFlock Camera Registry", description: "Known crowdsourced ALPR camera locations supplied through the bounded Hunter-Seeker map layer.", passiveOnly: true, transport: "safe-web",
    authentication: { kind: "none" }, capabilities: [capability({ id: "visual-search", description: "Known ALPR cameras inside an exact geographic area.", seedTypes: ["geographic-area"], authorizationModes: ["public-research", "owned-asset", "authorized-client"], producesEntityTypes: ["event", "geographic-area"] })],
    rateLimit: { requests: 1, windowMs: 30_000, maximumConcurrent: 1 }, cache: { ttlMs: 15 * 60_000, staleIfErrorMs: 60 * 60_000 }, reliability: 0.82,
    attribution: { provider: "DeFlock / OpenStreetMap", documentationUrl: "https://deflock.org/", termsUrl: "https://www.openstreetmap.org/copyright" }, enabledByDefault: false,
  },
  {
    id: "searxng", displayName: "SearXNG", description: "Operator-configured passive metasearch discovery.", passiveOnly: true, transport: "electron-broker",
    authentication: { kind: "none", credentialNamespace: "vc-osint.searxng" }, capabilities: [capability({ id: "web-search", description: "General passive web discovery, including explicitly submitted Hunter-Seeker identifiers and regions.", seedTypes: ["domain", "ip-address", "email-address", "username", "organization", "url", "person", "aircraft", "vessel", "satellite", "event", "geographic-area", "unknown"], authorizationModes: ["public-research", "owned-asset", "authorized-client"], producesEntityTypes: ["url", "domain"] })],
    rateLimit: { requests: 10, windowMs: 60_000, maximumConcurrent: 1 }, cache: { ttlMs: 15 * 60_000, staleIfErrorMs: 60 * 60_000 }, reliability: 0.66,
    attribution: { provider: "SearXNG", documentationUrl: "https://docs.searxng.org/dev/search_api.html" },
    setup: {
      acquisitionUrl: "https://docs.searxng.org/admin/installation.html", actionLabel: "SET UP SEARXNG", summary: "SearXNG does not issue an API key. VoidCat needs the base URL of an instance you operate or are authorized to use with JSON search enabled.",
      steps: ["Install or select an authorized SearXNG instance.", "Enable JSON in the instance search formats and confirm its usage policy permits API access.", "Copy only the instance base URL, without /search or query parameters.", "Return to VoidCat, paste the base URL, save it, then run TEST LIVE."],
      secondaryUrl: "https://searx.space/", secondaryLabel: "VIEW INSTANCE DIRECTORY",
    }, enabledByDefault: false,
  },
  {
    id: "opensquat-local", displayName: "OpenSquat-style Local Similarity", description: "Deterministic local lookalike-domain candidate generation; it makes no network requests.", passiveOnly: true, transport: "local",
    authentication: { kind: "none" }, capabilities: [capability({ id: "domain-profile", description: "Local domain similarity candidate generation.", seedTypes: ["domain"], authorizationModes: ["public-research", "owned-asset", "authorized-client"], producesEntityTypes: ["domain"] })],
    rateLimit: { requests: 100, windowMs: 60_000, maximumConcurrent: 4 }, cache: { ttlMs: 24 * 60 * 60_000, staleIfErrorMs: 0 }, reliability: 0.42,
    attribution: { provider: "VoidCat local similarity generator", documentationUrl: "https://github.com/atenreiro/opensquat" }, enabledByDefault: true,
  },
  {
    id: "shodan", displayName: "Shodan", description: "Passive host and domain infrastructure observations.", passiveOnly: true, transport: "electron-broker",
    authentication: { kind: "api-key", credentialNamespace: "vc-osint.shodan" }, capabilities: [
      capability({ id: "ip-infrastructure", description: "Passive host services for an exact IP.", seedTypes: ["ip-address"], authorizationModes: ["public-research", "owned-asset", "authorized-client"], producesEntityTypes: ["ip-address", "service", "organization", "autonomous-system"] }),
      capability({ id: "domain-profile", description: "Passive DNS/domain profile for an exact domain.", seedTypes: ["domain"], authorizationModes: ["public-research", "owned-asset", "authorized-client"], producesEntityTypes: ["domain", "ip-address"] }),
    ], rateLimit: { requests: 1, windowMs: 1_000, maximumConcurrent: 1 }, cache: { ttlMs: 60 * 60_000, staleIfErrorMs: 24 * 60 * 60_000 }, reliability: 0.86,
    attribution: { provider: "Shodan", documentationUrl: "https://developer.shodan.io/api", termsUrl: "https://account.shodan.io/terms" },
    setup: {
      acquisitionUrl: "https://account.shodan.io/", actionLabel: "GET SHODAN API KEY", summary: "Sign in to Shodan and copy the API key assigned to your account.",
      steps: ["Open the official Shodan account page and sign in or create an account.", "Locate and copy the API key shown in your account.", "Return to VoidCat, paste the key, and choose SAVE PROTECTED VALUE.", "Choose TEST LIVE so VoidCat can verify the key without storing it in an investigation."],
    }, enabledByDefault: false,
  },
  {
    id: "censys", displayName: "Censys", description: "Passive internet host, service, TLS, and certificate observations.", passiveOnly: true, transport: "electron-broker",
    authentication: { kind: "api-key", credentialNamespace: "vc-osint.censys" }, capabilities: [
      capability({ id: "ip-infrastructure", description: "Passive host and service lookup for an exact IP.", seedTypes: ["ip-address"], authorizationModes: ["public-research", "owned-asset", "authorized-client"], producesEntityTypes: ["ip-address", "service", "certificate"] }),
      capability({ id: "certificate-search", description: "Certificate and TLS context associated with an exact domain.", seedTypes: ["domain"], authorizationModes: ["public-research", "owned-asset", "authorized-client"], producesEntityTypes: ["domain", "certificate", "ip-address"] }),
    ], rateLimit: { requests: 1, windowMs: 1_000, maximumConcurrent: 1 }, cache: { ttlMs: 60 * 60_000, staleIfErrorMs: 24 * 60 * 60_000 }, reliability: 0.88,
    attribution: { provider: "Censys", documentationUrl: "https://docs.censys.com/reference/get-started", termsUrl: "https://censys.com/terms-of-service/" },
    setup: {
      acquisitionUrl: "https://platform.censys.io/", actionLabel: "CREATE CENSYS TOKEN", summary: "Censys Platform uses a Personal Access Token. Free accounts can use the lookup endpoints available to their tier.",
      steps: ["Open Censys Platform and sign in or create an account.", "Open the profile menu, choose API Access, and create a Personal Access Token.", "Copy the token when it is displayed.", "Return to VoidCat, paste the token, save it, then run TEST LIVE."],
      secondaryUrl: "https://docs.censys.com/reference/get-started", secondaryLabel: "TOKEN INSTRUCTIONS",
    }, enabledByDefault: false,
  },
  {
    id: "hibp", displayName: "Have I Been Pwned", description: "Exact-target authorized breach exposure checks with sensitive evidence redaction.", passiveOnly: true, transport: "electron-broker",
    authentication: { kind: "custom-header", credentialNamespace: "vc-osint.hibp" }, capabilities: [capability({ id: "authorized-exposure-check", description: "Explicitly authorized exposure check for one exact email address or verified domain.", seedTypes: ["email-address", "domain"], authorizationModes: ["exposure-check"], producesEntityTypes: ["email-address", "domain", "event"], sensitive: true })],
    rateLimit: { requests: 1, windowMs: 1_600, maximumConcurrent: 1 }, cache: { ttlMs: 5 * 60_000, staleIfErrorMs: 0 }, reliability: 0.94,
    attribution: { provider: "Have I Been Pwned", documentationUrl: "https://haveibeenpwned.com/API/v3", termsUrl: "https://haveibeenpwned.com/TermsOfUse" },
    setup: {
      acquisitionUrl: "https://haveibeenpwned.com/API/Key", actionLabel: "GET HIBP API KEY", summary: "HIBP exposure APIs require a subscription key. VoidCat will still require explicit authorization for every exact target.",
      steps: ["Open the official HIBP dashboard and sign in.", "Purchase or manage a subscription, then open Business and API Key.", "Copy the 32-character API key.", "Return to VoidCat, paste the key, save it, then run TEST LIVE."],
      secondaryUrl: "https://support.haveibeenpwned.com/hc/en-au/articles/15542964608655-How-do-I-get-started-after-purchasing-a-subscription", secondaryLabel: "SETUP INSTRUCTIONS",
    }, enabledByDefault: false,
  },
] as const;

LIVE_OSINT_PROVIDER_DESCRIPTORS.forEach(validateProviderDescriptor);

function identifierForSeed(seed: InvestigationSeed): OsintIdentifierType {
  if (seed.type === "domain") return "domain";
  if (seed.type === "ip-address") return seed.value.includes(":") ? "ipv6" : "ipv4";
  if (seed.type === "email-address") return "email";
  if (seed.type === "username") return "username";
  if (seed.type === "organization") return "organization-name";
  if (seed.type === "url") return "url";
  if (seed.type === "geographic-area") return "geographic-label";
  return "provider-record";
}

function seedEntity(seed: InvestigationSeed) {
  return { ref: "seed", type: seed.type, displayName: seed.label || seed.value, identifiers: [{ type: identifierForSeed(seed), value: seed.value, confidence: 1 }] };
}

function jsonBytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function stringValue(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function objectValue(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function arrayValue(value: unknown) { return Array.isArray(value) ? value : []; }
function safeHttpUrl(value: unknown) {
  try { const url = new URL(stringValue(value)); return ["http:", "https:"].includes(url.protocol) ? url.toString() : ""; } catch { return ""; }
}

function genericSupport(descriptor: OsintProviderDescriptor, seed: InvestigationSeed, authorizationMode: OsintAuthorizationMode): OsintProviderSupportDecision {
  const supported = descriptor.capabilities.filter((item) => item.seedTypes.includes(seed.type) && item.authorizationModes.includes(authorizationMode));
  return { supported: supported.length > 0, capabilityIds: supported.map(({ id }) => id), reasons: supported.length ? [] : ["This provider does not support the selected seed and authorization mode."], requiresCredential: descriptor.authentication.kind !== "none", requiresExplicitAuthorization: supported.some(({ sensitive }) => sensitive) };
}

function genericPlan(descriptor: OsintProviderDescriptor, seed: InvestigationSeed, context: OsintProviderPlanningContext): OsintProviderQuery[] {
  const support = genericSupport(descriptor, seed, context.authorizationMode);
  return support.capabilityIds.slice(0, context.budget.maximumExternalCalls).map((capabilityId) => {
    const core = { providerId: descriptor.id, capabilityId, seedType: seed.type, seedValue: seed.value };
    return { id: osintStableId("query", core), providerId: descriptor.id, capabilityId, operation: capabilityId, seed: structuredClone(seed), parameters: { exactTarget: seed.value }, purpose: context.objective, cacheKey: osintStableId("cache", core), estimatedExternalCalls: descriptor.transport === "local" ? 0 : 1, maximumResponseBytes: Math.min(context.budget.maximumEvidenceBytes, 2_000_000) };
  });
}

function createAdapter<TRaw>(descriptor: OsintProviderDescriptor, normalizer: (raw: TRaw, context: OsintProviderNormalizationContext) => OsintProviderResultDraft): OsintProviderAdapter<TRaw> {
  return { descriptor, supports: (seed, mode) => genericSupport(descriptor, seed, mode), plan: (seed, context) => genericPlan(descriptor, seed, context), normalize: normalizer };
}

function baseDraft(context: OsintProviderNormalizationContext, raw: unknown, title: string, excerpt: string, options: { sensitivity?: "public" | "restricted" | "exposure-sensitive"; sourceRef?: string; url?: string; attributes?: OsintJsonRecord; confidence?: number; limitations?: string[] } = {}): OsintProviderResultDraft {
  return {
    entities: [seedEntity(context.query.seed)],
    evidence: [{ ref: "primary", sourceRef: options.sourceRef ?? `${context.provider.id}:${context.query.cacheKey}`, title, excerpt: excerpt.slice(0, 12_000), ...(options.url ? { url: options.url } : {}), byteLength: jsonBytes(raw), sensitivity: options.sensitivity ?? "public", metadata: { exactTargetOnly: true } }],
    observations: [{ ref: "primary", entityRef: "seed", evidenceRefs: ["primary"], attributes: options.attributes ?? {}, confidence: options.confidence ?? context.provider.reliability, directness: "direct", freshness: context.cache.status === "cached" ? "recent" : "live", coverageLimitations: options.limitations ?? [] }],
    coverageLimitations: options.limitations ?? [], warnings: [],
  };
}

function normalizeSearxng(raw: unknown, context: OsintProviderNormalizationContext): OsintProviderResultDraft {
  const results = arrayValue(objectValue(raw).results).slice(0, 25).map(objectValue);
  const draft = baseDraft(context, raw, "SearXNG passive discovery", `${results.length} bounded search results returned.`, { limitations: ["Search ranking and coverage depend on the configured SearXNG instance and enabled engines."] });
  results.forEach((result, index) => {
    const url = safeHttpUrl(result.url); if (!url) return;
    const ref = `url-${index}`; const evidenceRef = `result-${index}`;
    draft.entities.push({ ref, type: "url", displayName: stringValue(result.title) || url, identifiers: [{ type: "url", value: url, confidence: 0.9 }] });
    draft.evidence.push({ ref: evidenceRef, sourceRef: `searxng:rank:${index + 1}`, title: stringValue(result.title) || "Search result", excerpt: stringValue(result.content).slice(0, 2_000), url, byteLength: jsonBytes(result), metadata: { rank: index + 1, engine: stringValue(result.engine) || "unknown" } });
    draft.observations.push({ ref, entityRef: ref, evidenceRefs: [evidenceRef], attributes: { rank: index + 1 }, confidence: Math.max(0.35, 0.72 - index * 0.01), directness: "direct", freshness: "unknown", coverageLimitations: draft.coverageLimitations });
    draft.relationships ??= [];
    draft.relationships.push({ ref: `mentions-${index}`, sourceEntityRef: "seed", targetEntityRef: ref, type: "search-result-for", direction: "directed", evidenceRefs: [evidenceRef], confidence: 0.55, status: "observed" });
    draft.leads ??= [];
    draft.leads.push({ ref: `lead-${index}`, entityRef: ref, seed: { type: "url", value: url, label: stringValue(result.title) || url, attributes: {}, source: { kind: "candidate-lead", id: context.query.id } }, reason: "Passive search result submitted as a candidate only; relevance and identity require operator review.", depth: 1, evidenceRefs: [evidenceRef] });
  });
  return draft;
}

export function generateOpenSquatStyleCandidates(domainValue: string, maximum = 80) {
  const normalized = domainValue.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/\.$/, "");
  const labels = normalized.split("."); const name = labels.shift() ?? ""; const suffix = labels.join(".");
  if (!/^[a-z0-9-]{2,63}$/.test(name) || !suffix) throw new Error("A registrable domain is required for local similarity generation.");
  const candidates = new Set<string>();
  const add = (value: string) => { if (value && value !== normalized && /^[a-z0-9-]+\.[a-z0-9.-]+$/.test(value)) candidates.add(value); };
  for (let index = 0; index < name.length; index += 1) {
    add(`${name.slice(0, index)}${name.slice(index + 1)}.${suffix}`);
    if (index < name.length - 1) add(`${name.slice(0, index)}${name[index + 1]}${name[index]}${name.slice(index + 2)}.${suffix}`);
  }
  for (const prefix of ["login", "secure", "account", "support", "verify"]) add(`${prefix}-${name}.${suffix}`);
  for (const alternate of ["com", "net", "org", "co"]) if (alternate !== suffix) add(`${name}.${alternate}`);
  return [...candidates].sort().slice(0, Math.max(1, Math.min(200, maximum)));
}

function normalizeOpenSquat(raw: unknown, context: OsintProviderNormalizationContext): OsintProviderResultDraft {
  const candidates = arrayValue(raw).filter((value): value is string => typeof value === "string").slice(0, 200);
  const draft = baseDraft(context, raw, "Local domain similarity candidates", `${candidates.length} deterministic lookalike candidates generated locally. No registration or maliciousness claim was made.`, { confidence: 0.42, limitations: ["Similarity is a candidate-generation heuristic, not evidence of ownership, registration, use, or malicious intent."] });
  draft.leads = [];
  candidates.forEach((domain, index) => {
    const ref = `candidate-${index}`;
    draft.entities.push({ ref, type: "domain", displayName: domain, identifiers: [{ type: "domain", value: domain, confidence: 0.7 }], attributes: { generatedLocally: true, maliciousnessClaimed: false } });
    draft.leads!.push({ ref: `lead-${index}`, entityRef: ref, seed: { type: "domain", value: domain, attributes: {}, source: { kind: "candidate-lead", id: context.query.id } }, reason: "Local string-similarity candidate; requires separate passive verification.", depth: 1, evidenceRefs: ["primary"] });
  });
  return draft;
}

function normalizeShodan(raw: unknown, context: OsintProviderNormalizationContext) {
  const root = objectValue(raw); const ports = arrayValue(root.ports).filter((value): value is number => typeof value === "number").slice(0, 200);
  const hostnames = arrayValue(root.hostnames).filter((value): value is string => typeof value === "string").slice(0, 50);
  return baseDraft(context, raw, "Shodan passive infrastructure record", `Exact target passive record: ${ports.length} ports; ${hostnames.length} hostnames.`, { attributes: { ports, hostnames, organization: stringValue(root.org), asn: stringValue(root.asn), lastUpdate: stringValue(root.last_update) }, limitations: ["Shodan observations may be stale, incomplete, or reflect shared infrastructure. No active scan was requested."] });
}

function normalizeCensys(raw: unknown, context: OsintProviderNormalizationContext) {
  const root = objectValue(raw); const result = objectValue(root.result); const resource = objectValue(result.resource ?? root.resource ?? result);
  const services = arrayValue(resource.services).slice(0, 200).map((value) => { const item = objectValue(value); return { port: typeof item.port === "number" ? item.port : null, protocol: stringValue(item.service_name || item.transport_protocol), observedAt: stringValue(item.observed_at) }; });
  return baseDraft(context, raw, "Censys passive asset record", `Exact target passive record: ${services.length} observed services.`, { attributes: { services, lastUpdatedAt: stringValue(resource.last_updated_at), location: objectValue(resource.location) as unknown as OsintJsonRecord }, limitations: ["Censys coverage is scan-derived, time-varying, and may omit services or shared-infrastructure context. No active scan was requested."] });
}

function normalizeHibp(raw: unknown, context: OsintProviderNormalizationContext): OsintProviderResultDraft {
  const rawItems = arrayValue(raw).slice(0, 200);
  const accountRows = rawItems.filter((item) => typeof objectValue(item).account === "string");
  const breachValues = accountRows.length
    ? accountRows.flatMap((item) => arrayValue(objectValue(item).breaches)).slice(0, 500)
    : rawItems;
  const names = [...new Set(breachValues.map((item) => typeof item === "string" ? item.trim() : stringValue(objectValue(item).Name || objectValue(item).name)).filter(Boolean))];
  return baseDraft(context, raw, "HIBP authorized exact-target exposure check", names.length ? `Exposure records: ${names.join(", ").slice(0, 4_000)}.` : "No exposure records were returned for the exact authorized target.", {
    sensitivity: "exposure-sensitive", sourceRef: `hibp:exact-target:${context.query.cacheKey}`, attributes: { breachNames: names, breachCount: names.length, affectedAccountCount: accountRows.length, exactTargetOnly: true, hunterForwarding: "blocked-pending-approval" }, confidence: 0.94,
    limitations: ["A breach appearance does not prove current compromise.", "No discovered email address is emitted or automatically expanded.", "Forwarding exposure evidence to Hunter-Seeker requires separate operator approval."],
  });
}

function normalizeDeflock(raw: unknown, context: OsintProviderNormalizationContext) {
  const records = arrayValue(raw).slice(0, 2_000).map(objectValue);
  return baseDraft(context, raw, "DeFlock visible camera observations", `${records.length} known crowdsourced ALPR camera locations intersect the supplied Hunter-Seeker region.`, { attributes: { cameraCount: records.length }, limitations: ["Crowdsourced known-camera locations only; absence does not establish that an area has no ALPR cameras."] });
}

const descriptor = (id: LiveOsintProviderId) => LIVE_OSINT_PROVIDER_DESCRIPTORS.find((item) => item.id === id)!;
export const deflockOsintAdapter = createAdapter(descriptor("deflock"), normalizeDeflock);
export const searxngOsintAdapter = createAdapter(descriptor("searxng"), normalizeSearxng);
export const openSquatLocalAdapter = createAdapter(descriptor("opensquat-local"), normalizeOpenSquat);
export const shodanOsintAdapter = createAdapter(descriptor("shodan"), normalizeShodan);
export const censysOsintAdapter = createAdapter(descriptor("censys"), normalizeCensys);
export const hibpOsintAdapter = createAdapter(descriptor("hibp"), normalizeHibp);
export const LIVE_OSINT_PROVIDER_ADAPTERS = [deflockOsintAdapter, searxngOsintAdapter, openSquatLocalAdapter, shodanOsintAdapter, censysOsintAdapter, hibpOsintAdapter] as const;

export function normalizeLiveProviderResult(providerId: LiveOsintProviderId, raw: unknown, context: OsintProviderNormalizationContext): NormalizedOsintProviderResult {
  const adapter = LIVE_OSINT_PROVIDER_ADAPTERS.find((candidate) => candidate.descriptor.id === providerId);
  if (!adapter) throw new Error(`Unknown live OSINT provider ${providerId}.`);
  return normalizeProviderResult(adapter.normalize(raw as never, context), context);
}
