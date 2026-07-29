/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import { createHash } from "node:crypto";
import {
  OSINT_SCHEMA_VERSION,
  OsintContractError,
  confidenceCategory,
  toOsintJsonRecord,
  validateInvestigationBudget,
  validateOsintContract,
  type InvestigationBudget,
  type InvestigationSeed,
  type OsintAuthorizationMode,
  type OsintEntity,
  type OsintEntityType,
  type OsintEvidence,
  type OsintIdentifierType,
  type OsintJsonRecord,
  type OsintLead,
  type OsintObservation,
  type OsintRelationship,
} from "./contracts.ts";

export const OSINT_PROVIDER_CAPABILITIES = [
  "domain-profile", "ip-infrastructure", "username-search", "organization-profile", "authorized-exposure-check",
  "certificate-search", "passive-dns", "web-search", "aviation-context", "maritime-context", "orbital-context",
  "event-context", "visual-search", "entity-expansion",
] as const;
export type OsintProviderCapabilityId = typeof OSINT_PROVIDER_CAPABILITIES[number];

export type OsintProviderCapability = {
  id: OsintProviderCapabilityId;
  description: string;
  seedTypes: OsintEntityType[];
  authorizationModes: OsintAuthorizationMode[];
  producesEntityTypes: OsintEntityType[];
  maximumQueriesPerInvestigation: number;
  sensitive: boolean;
};

export type OsintProviderDescriptor = {
  id: string;
  displayName: string;
  description: string;
  passiveOnly: true;
  transport: "local" | "safe-web" | "electron-broker";
  authentication: {
    kind: "none" | "api-key" | "basic" | "custom-header";
    credentialNamespace?: string;
  };
  capabilities: OsintProviderCapability[];
  rateLimit: {
    requests: number;
    windowMs: number;
    maximumConcurrent: number;
  };
  cache: {
    ttlMs: number;
    staleIfErrorMs: number;
  };
  reliability: number;
  attribution: {
    provider: string;
    documentationUrl: string;
    termsUrl?: string;
  };
  setup?: {
    acquisitionUrl: string;
    actionLabel: string;
    summary: string;
    steps: string[];
    secondaryUrl?: string;
    secondaryLabel?: string;
  };
  enabledByDefault: boolean;
};

export type OsintProviderSupportDecision = {
  supported: boolean;
  capabilityIds: OsintProviderCapabilityId[];
  reasons: string[];
  requiresCredential: boolean;
  requiresExplicitAuthorization: boolean;
};

export type OsintProviderQuery = {
  id: string;
  providerId: string;
  capabilityId: OsintProviderCapabilityId;
  operation: string;
  seed: InvestigationSeed;
  parameters: OsintJsonRecord;
  purpose: string;
  cacheKey: string;
  estimatedExternalCalls: number;
  maximumResponseBytes: number;
};

export type OsintProviderPlanningContext = {
  investigationId: string;
  objective: string;
  authorizationMode: OsintAuthorizationMode;
  budget: InvestigationBudget;
};

export type OsintProviderNormalizationContext = {
  investigationId: string;
  query: OsintProviderQuery;
  provider: OsintProviderDescriptor;
  retrievedAt: string;
  budget: InvestigationBudget;
  cache: {
    status: "live" | "cached" | "fixture";
    ageMs: number;
    expiresAt?: string;
  };
};

export type OsintProviderResultDraft = {
  entities: Array<{
    ref: string;
    type: OsintEntityType;
    displayName: string;
    identifiers: Array<{ type: OsintIdentifierType; value: string; confidence?: number }>;
    attributes?: unknown;
  }>;
  evidence: Array<{
    ref: string;
    sourceRef: string;
    title: string;
    excerpt?: string;
    url?: string;
    observedAt?: string;
    mimeType?: string;
    byteLength: number;
    sha256?: string;
    sensitivity?: OsintEvidence["sensitivity"];
    metadata?: unknown;
  }>;
  observations: Array<{
    ref: string;
    entityRef: string;
    observedAt?: string;
    evidenceRefs: string[];
    attributes?: unknown;
    confidence: number;
    directness: OsintObservation["directness"];
    freshness: OsintObservation["freshness"];
    coverageLimitations?: string[];
  }>;
  relationships?: Array<{
    ref: string;
    sourceEntityRef: string;
    targetEntityRef: string;
    type: string;
    direction?: OsintRelationship["direction"];
    observedAt?: string;
    evidenceRefs: string[];
    confidence: number;
    status: OsintRelationship["status"];
  }>;
  leads?: Array<{
    ref: string;
    entityRef: string;
    seed: InvestigationSeed;
    reason: string;
    depth: number;
    evidenceRefs: string[];
  }>;
  coverageLimitations: string[];
  warnings: string[];
};

export type NormalizedOsintProviderResult = {
  providerId: string;
  queryId: string;
  entities: OsintEntity[];
  evidence: OsintEvidence[];
  observations: OsintObservation[];
  relationships: OsintRelationship[];
  leads: OsintLead[];
  coverageLimitations: string[];
  warnings: string[];
  accounting: {
    entityCount: number;
    evidenceCount: number;
    evidenceBytes: number;
  };
};

/**
 * Provider adapters are pure at Gate 1. They can create a bounded request plan and
 * normalize an already supplied response, but they deliberately have no fetch,
 * socket, file, database, credential, or arbitrary transport method.
 */
export interface OsintProviderAdapter<TRaw = unknown> {
  readonly descriptor: OsintProviderDescriptor;
  supports(seed: InvestigationSeed, authorizationMode: OsintAuthorizationMode): OsintProviderSupportDecision;
  plan(seed: InvestigationSeed, context: OsintProviderPlanningContext): OsintProviderQuery[];
  normalize(raw: TRaw, context: OsintProviderNormalizationContext): OsintProviderResultDraft;
}

function iso(value: string) {
  return Number.isFinite(Date.parse(value));
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

export function osintStableId(prefix: string, value: unknown) {
  return `${prefix}_${createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 24)}`;
}

export function normalizeIdentifierValue(type: OsintIdentifierType, value: string) {
  const trimmed = value.trim();
  if (["aircraft-icao", "aircraft-callsign", "aircraft-registration", "international-designator"].includes(type)) return trimmed.replace(/\s+/g, "").toUpperCase();
  if (["domain", "email", "username", "organization-name", "vessel-name", "geographic-label"].includes(type)) return trimmed.toLocaleLowerCase("en-US").replace(type === "domain" ? /\.$/ : /$^/, "");
  if (["vessel-mmsi", "satellite-norad", "asn"].includes(type)) return trimmed.replace(type === "asn" ? /^AS/i : /\D/g, "").toUpperCase();
  if (type === "url") {
    try { const url = new URL(trimmed); url.hash = ""; return url.toString(); } catch { return trimmed; }
  }
  return trimmed.toLocaleLowerCase("en-US");
}

export function validateProviderDescriptor(descriptor: OsintProviderDescriptor) {
  const issues: string[] = [];
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(descriptor.id)) issues.push("id must be a stable lowercase provider key");
  if (!descriptor.displayName.trim() || !descriptor.description.trim()) issues.push("displayName and description are required");
  if (descriptor.passiveOnly !== true) issues.push("provider must be passive-only");
  if (!descriptor.capabilities.length) issues.push("provider requires at least one capability");
  if (new Set(descriptor.capabilities.map(({ id }) => id)).size !== descriptor.capabilities.length) issues.push("provider capabilities must be unique");
  for (const capability of descriptor.capabilities) {
    if (!OSINT_PROVIDER_CAPABILITIES.includes(capability.id)) issues.push(`unsupported capability ${capability.id}`);
    if (!capability.description.trim() || !capability.seedTypes.length || !capability.authorizationModes.length || !capability.producesEntityTypes.length) issues.push(`capability ${capability.id} has incomplete metadata`);
    if (!Number.isInteger(capability.maximumQueriesPerInvestigation) || capability.maximumQueriesPerInvestigation < 1 || capability.maximumQueriesPerInvestigation > 20) issues.push(`capability ${capability.id} has an invalid query ceiling`);
    if (capability.sensitive && !capability.authorizationModes.includes("exposure-check")) issues.push(`sensitive capability ${capability.id} must require exposure-check mode`);
  }
  if (!Number.isInteger(descriptor.rateLimit.requests) || descriptor.rateLimit.requests < 1 || descriptor.rateLimit.windowMs < 1_000 || descriptor.rateLimit.maximumConcurrent < 1) issues.push("rateLimit is invalid");
  if (!Number.isInteger(descriptor.cache.ttlMs) || descriptor.cache.ttlMs < 1_000 || descriptor.cache.staleIfErrorMs < 0) issues.push("cache policy is invalid");
  if (!Number.isFinite(descriptor.reliability) || descriptor.reliability < 0 || descriptor.reliability > 1) issues.push("reliability must be between 0 and 1");
  for (const candidate of [descriptor.attribution.documentationUrl, descriptor.attribution.termsUrl].filter(Boolean) as string[]) {
    try { const url = new URL(candidate); if (url.protocol !== "https:" && url.protocol !== "http:") issues.push("attribution URLs must be HTTP(S)"); } catch { issues.push("attribution URLs must be valid"); }
  }
  if (descriptor.setup) {
    if (!descriptor.setup.actionLabel.trim() || !descriptor.setup.summary.trim()) issues.push("provider setup requires an action label and summary");
    if (descriptor.setup.steps.length < 2 || descriptor.setup.steps.length > 8 || descriptor.setup.steps.some((step) => !step.trim() || step.length > 240)) issues.push("provider setup requires 2-8 bounded steps");
    if (Boolean(descriptor.setup.secondaryUrl) !== Boolean(descriptor.setup.secondaryLabel)) issues.push("provider setup secondary URL and label must be supplied together");
    for (const candidate of [descriptor.setup.acquisitionUrl, descriptor.setup.secondaryUrl].filter(Boolean) as string[]) {
      try { if (new URL(candidate).protocol !== "https:") issues.push("provider setup URLs must use HTTPS"); } catch { issues.push("provider setup URLs must be valid"); }
    }
  }
  if (descriptor.authentication.kind !== "none" && !descriptor.authentication.credentialNamespace?.trim()) issues.push("credentialed providers require a protected credential namespace");
  if (issues.length) throw new OsintContractError("provider-result", issues);
  return structuredClone(descriptor);
}

function requireUniqueRefs(items: Array<{ ref: string }>, label: string, maximum: number) {
  if (items.length > maximum) throw new OsintContractError("provider-result", [`${label} exceeds ${maximum} items`]);
  const refs = new Set<string>();
  for (const item of items) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(item.ref)) throw new OsintContractError("provider-result", [`${label} contains invalid ref ${item.ref}`]);
    if (refs.has(item.ref)) throw new OsintContractError("provider-result", [`${label} contains duplicate ref ${item.ref}`]);
    refs.add(item.ref);
  }
  return refs;
}

function uniqueStrings(values: string[], maximum: number, maximumLength = 1000) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, maximum).map((value) => value.slice(0, maximumLength));
}

function assertClosedDraftRecord(value: unknown, label: string, allowed: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OsintContractError("provider-result", [`${label} must be an object`]);
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw new OsintContractError("provider-result", [`${label} contains unsupported properties: ${extras.join(", ")}`]);
}

function assertDraftShape(draft: OsintProviderResultDraft) {
  for (const [index, entity] of draft.entities.entries()) {
    assertClosedDraftRecord(entity, `entities[${index}]`, ["ref", "type", "displayName", "identifiers", "attributes"]);
    if (!Array.isArray(entity.identifiers) || entity.identifiers.length < 1 || entity.identifiers.length > 100) throw new OsintContractError("provider-result", [`entities[${index}].identifiers must contain between 1 and 100 items`]);
    entity.identifiers.forEach((identifier, identifierIndex) => assertClosedDraftRecord(identifier, `entities[${index}].identifiers[${identifierIndex}]`, ["type", "value", "confidence"]));
  }
  draft.evidence.forEach((item, index) => assertClosedDraftRecord(item, `evidence[${index}]`, ["ref", "sourceRef", "title", "excerpt", "url", "observedAt", "mimeType", "byteLength", "sha256", "sensitivity", "metadata"]));
  draft.observations.forEach((item, index) => assertClosedDraftRecord(item, `observations[${index}]`, ["ref", "entityRef", "observedAt", "evidenceRefs", "attributes", "confidence", "directness", "freshness", "coverageLimitations"]));
  (draft.relationships ?? []).forEach((item, index) => assertClosedDraftRecord(item, `relationships[${index}]`, ["ref", "sourceEntityRef", "targetEntityRef", "type", "direction", "observedAt", "evidenceRefs", "confidence", "status"]));
  (draft.leads ?? []).forEach((item, index) => assertClosedDraftRecord(item, `leads[${index}]`, ["ref", "entityRef", "seed", "reason", "depth", "evidenceRefs"]));
  for (const [label, values] of [["coverageLimitations", draft.coverageLimitations], ["warnings", draft.warnings]] as const) {
    if (values.some((value) => typeof value !== "string")) throw new OsintContractError("provider-result", [`${label} must contain only strings`]);
  }
  for (const [label, values] of [
    ...draft.observations.map((item, index) => [`observations[${index}].evidenceRefs`, item.evidenceRefs] as const),
    ...(draft.relationships ?? []).map((item, index) => [`relationships[${index}].evidenceRefs`, item.evidenceRefs] as const),
    ...(draft.leads ?? []).map((item, index) => [`leads[${index}].evidenceRefs`, item.evidenceRefs] as const),
  ]) if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) throw new OsintContractError("provider-result", [`${label} must contain only strings`]);
}

export function normalizeProviderResult(draft: OsintProviderResultDraft, context: OsintProviderNormalizationContext): NormalizedOsintProviderResult {
  validateProviderDescriptor(context.provider);
  validateInvestigationBudget(context.budget);
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) throw new OsintContractError("provider-result", ["provider result draft must be an object"]);
  const allowedDraftKeys = new Set(["entities", "evidence", "observations", "relationships", "leads", "coverageLimitations", "warnings"]);
  if (Object.keys(draft).some((key) => !allowedDraftKeys.has(key))) throw new OsintContractError("provider-result", ["provider result draft contains unsupported properties"]);
  if (!Array.isArray(draft.entities) || !Array.isArray(draft.evidence) || !Array.isArray(draft.observations) || !Array.isArray(draft.coverageLimitations) || !Array.isArray(draft.warnings) || (draft.relationships !== undefined && !Array.isArray(draft.relationships)) || (draft.leads !== undefined && !Array.isArray(draft.leads))) {
    throw new OsintContractError("provider-result", ["provider result collections must be arrays"]);
  }
  assertDraftShape(draft);
  if (context.query.providerId !== context.provider.id) throw new OsintContractError("provider-result", ["query provider does not match descriptor"]);
  if (!iso(context.retrievedAt)) throw new OsintContractError("provider-result", ["retrievedAt must be an ISO timestamp"]);
  const entityRefs = requireUniqueRefs(draft.entities, "entities", context.budget.maximumEntities);
  requireUniqueRefs(draft.evidence, "evidence", Math.min(2_000, context.budget.maximumEntities * 4));
  requireUniqueRefs(draft.observations, "observations", Math.min(5_000, context.budget.maximumEntities * 4));
  requireUniqueRefs(draft.relationships ?? [], "relationships", Math.min(10_000, context.budget.maximumEntities * 8));
  requireUniqueRefs(draft.leads ?? [], "leads", Math.min(1_000, context.budget.maximumEntities));

  const evidenceIdByRef = new Map<string, string>();
  let evidenceBytes = 0;
  const evidence = draft.evidence.map((item) => {
    if (!Number.isInteger(item.byteLength) || item.byteLength < 0) throw new OsintContractError("provider-result", [`evidence ${item.ref} byteLength is invalid`]);
    evidenceBytes += item.byteLength;
    if (evidenceBytes > context.budget.maximumEvidenceBytes) throw new OsintContractError("provider-result", ["normalized evidence exceeds the investigation byte budget"]);
    if (item.observedAt && !iso(item.observedAt)) throw new OsintContractError("provider-result", [`evidence ${item.ref} observedAt is invalid`]);
    const id = osintStableId("ev", { provider: context.provider.id, query: context.query.id, ref: item.ref, sourceRef: item.sourceRef });
    evidenceIdByRef.set(item.ref, id);
    return validateOsintContract("evidence", {
      schemaVersion: OSINT_SCHEMA_VERSION, id, providerId: context.provider.id, sourceType: "provider", sourceRef: item.sourceRef.trim(), retrievedAt: context.retrievedAt,
      ...(item.observedAt ? { observedAt: item.observedAt } : {}), title: item.title.trim().slice(0, 500), ...(item.excerpt ? { excerpt: item.excerpt.trim().slice(0, 12_000) } : {}),
      ...(item.url ? { url: item.url } : {}), ...(item.mimeType ? { mimeType: item.mimeType } : {}),
      sha256: item.sha256?.toLowerCase() ?? createHash("sha256").update(item.excerpt ?? `${item.sourceRef}:${item.title}`).digest("hex"), byteLength: item.byteLength,
      sensitivity: item.sensitivity ?? "public", cache: { ...context.cache }, attribution: { provider: context.provider.attribution.provider, ...(context.provider.attribution.termsUrl ? { termsUrl: context.provider.attribution.termsUrl } : {}) }, metadata: toOsintJsonRecord(item.metadata ?? {}),
    });
  });

  const entityIdByRef = new Map<string, string>();
  const entities = draft.entities.map((item) => {
    if (!item.identifiers.length) throw new OsintContractError("provider-result", [`entity ${item.ref} requires an identifier`]);
    const identifiers = [...new Map(item.identifiers.map((identifier) => {
      const normalizedValue = normalizeIdentifierValue(identifier.type, identifier.value);
      const key = `${identifier.type}:${normalizedValue}`;
      return [key, { ...identifier, normalizedValue }];
    })).values()];
    const primary = identifiers[0];
    const entityId = osintStableId("ent", { type: item.type, identifierType: primary.type, value: primary.normalizedValue });
    entityIdByRef.set(item.ref, entityId);
    return validateOsintContract("entity", {
      schemaVersion: OSINT_SCHEMA_VERSION, id: entityId, type: item.type, displayName: item.displayName.trim().slice(0, 500),
      identifiers: identifiers.map((identifier) => validateOsintContract("identifier", {
        schemaVersion: OSINT_SCHEMA_VERSION, id: osintStableId("id", { entityId, type: identifier.type, value: identifier.normalizedValue }), type: identifier.type,
        value: identifier.value.trim(), normalizedValue: identifier.normalizedValue, confidence: identifier.confidence ?? context.provider.reliability, evidenceIds: [],
      })),
      attributes: toOsintJsonRecord(item.attributes ?? {}), createdAt: context.retrievedAt, updatedAt: context.retrievedAt,
    });
  });

  function mapEvidence(refs: string[], label: string) {
    return uniqueStrings(refs, 200).map((ref) => {
      const id = evidenceIdByRef.get(ref);
      if (!id) throw new OsintContractError("provider-result", [`${label} references missing evidence ${ref}`]);
      return id;
    });
  }
  function mapEntity(ref: string, label: string) {
    if (!entityRefs.has(ref)) throw new OsintContractError("provider-result", [`${label} references missing entity ${ref}`]);
    return entityIdByRef.get(ref) as string;
  }

  const observations = draft.observations.map((item) => validateOsintContract("observation", {
    schemaVersion: OSINT_SCHEMA_VERSION, id: osintStableId("obs", { investigationId: context.investigationId, provider: context.provider.id, query: context.query.id, ref: item.ref }), investigationId: context.investigationId,
    entityId: mapEntity(item.entityRef, `observation ${item.ref}`), providerId: context.provider.id, observedAt: item.observedAt ?? context.retrievedAt, retrievedAt: context.retrievedAt,
    evidenceIds: mapEvidence(item.evidenceRefs, `observation ${item.ref}`), attributes: toOsintJsonRecord(item.attributes ?? {}), confidence: item.confidence,
    confidenceCategory: confidenceCategory(item.confidence), directness: item.directness, freshness: item.freshness,
    coverageLimitations: uniqueStrings([...(item.coverageLimitations ?? []), ...draft.coverageLimitations], 50),
  }));

  const relationships = (draft.relationships ?? []).map((item) => validateOsintContract("relationship", {
    schemaVersion: OSINT_SCHEMA_VERSION, id: osintStableId("rel", { investigationId: context.investigationId, provider: context.provider.id, query: context.query.id, ref: item.ref }), investigationId: context.investigationId,
    sourceEntityId: mapEntity(item.sourceEntityRef, `relationship ${item.ref}`), targetEntityId: mapEntity(item.targetEntityRef, `relationship ${item.ref}`), type: item.type.trim(), direction: item.direction ?? "directed",
    observedAt: item.observedAt ?? context.retrievedAt, evidenceIds: mapEvidence(item.evidenceRefs, `relationship ${item.ref}`), confidence: item.confidence,
    confidenceCategory: confidenceCategory(item.confidence), status: item.status,
  }));

  const leads = (draft.leads ?? []).map((item) => {
    const entityId = mapEntity(item.entityRef, `lead ${item.ref}`);
    if (item.depth > context.budget.maximumDiscoveryDepth) throw new OsintContractError("provider-result", [`lead ${item.ref} exceeds discovery depth`]);
    return validateOsintContract("lead", {
      schemaVersion: OSINT_SCHEMA_VERSION, id: osintStableId("lead", { investigationId: context.investigationId, entityId, depth: item.depth }), investigationId: context.investigationId, entityId,
      seed: item.seed, reason: item.reason.trim(), status: "candidate", depth: item.depth, discoveredByEvidenceIds: mapEvidence(item.evidenceRefs, `lead ${item.ref}`), createdAt: context.retrievedAt, updatedAt: context.retrievedAt,
    });
  });

  return {
    providerId: context.provider.id, queryId: context.query.id, entities, evidence, observations, relationships, leads,
    coverageLimitations: uniqueStrings(draft.coverageLimitations, 50), warnings: uniqueStrings(draft.warnings, 50),
    accounting: { entityCount: entities.length, evidenceCount: evidence.length, evidenceBytes },
  };
}
