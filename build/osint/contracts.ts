/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
export type OsintJsonPrimitive = string | number | boolean | null;
export type OsintJsonValue = OsintJsonPrimitive | OsintJsonValue[] | { [key: string]: OsintJsonValue };
export type OsintJsonRecord = { [key: string]: OsintJsonValue };

export const OSINT_SCHEMA_VERSION = "1.0.0" as const;

export const OSINT_ENTITY_TYPES = [
  "domain", "ip-address", "email-address", "username", "organization", "certificate", "autonomous-system",
  "service", "url", "aircraft", "vessel", "satellite", "event", "geographic-area", "person", "phone-number",
  "device", "location", "vehicle", "social-account", "document", "incident", "cryptocurrency-address",
  "malware-family", "software-package", "repository", "unknown",
] as const;
export type OsintEntityType = typeof OSINT_ENTITY_TYPES[number];

export const OSINT_IDENTIFIER_TYPES = [
  "domain", "ipv4", "ipv6", "email", "username", "organization-name", "certificate-sha256", "asn", "url",
  "aircraft-icao", "aircraft-callsign", "aircraft-registration", "vessel-mmsi", "vessel-name", "satellite-norad",
  "international-designator", "provider-record", "hunter-entity", "hunter-observation", "geographic-label",
  "phone", "account-id", "avatar-sha256", "cryptocurrency-address", "repository-url", "device-id",
] as const;
export type OsintIdentifierType = typeof OSINT_IDENTIFIER_TYPES[number];

export type OsintAuthorizationMode = "public-research" | "owned-asset" | "authorized-client" | "exposure-check";
export type OsintInvestigationStatus = "draft" | "planned" | "running" | "completed" | "partial" | "failed" | "cancelled";
export type OsintConfidenceCategory = "very-low" | "low" | "moderate" | "high" | "very-high";

export type InvestigationBudget = {
  maximumProviders: number;
  maximumExternalCalls: number;
  maximumRuntimeMs: number;
  maximumEntities: number;
  maximumEvidenceBytes: number;
  maximumDiscoveryDepth: number;
};

export type InvestigationSeed = {
  type: OsintEntityType;
  value: string;
  label?: string;
  attributes: OsintJsonRecord;
  source: {
    kind: "operator" | "hunter-seeker" | "agent" | "candidate-lead";
    id: string;
    observationId?: string;
  };
};

export type OsintIdentifier = {
  schemaVersion: typeof OSINT_SCHEMA_VERSION;
  id: string;
  type: OsintIdentifierType;
  value: string;
  normalizedValue: string;
  confidence: number;
  firstSeenAt?: string;
  lastSeenAt?: string;
  evidenceIds: string[];
};

export type OsintEntity = {
  schemaVersion: typeof OSINT_SCHEMA_VERSION;
  id: string;
  type: OsintEntityType;
  displayName: string;
  identifiers: OsintIdentifier[];
  attributes: OsintJsonRecord;
  createdAt: string;
  updatedAt: string;
};

export type OsintEvidence = {
  schemaVersion: typeof OSINT_SCHEMA_VERSION;
  id: string;
  providerId: string;
  sourceType: "provider" | "hunter-seeker" | "web" | "operator" | "derived";
  sourceRef: string;
  retrievedAt: string;
  observedAt?: string;
  title: string;
  excerpt?: string;
  url?: string;
  mimeType?: string;
  sha256: string;
  byteLength: number;
  sensitivity: "public" | "restricted" | "exposure-sensitive";
  cache: {
    status: "live" | "cached" | "fixture" | "not-applicable";
    ageMs: number;
    expiresAt?: string;
  };
  attribution: {
    provider: string;
    termsUrl?: string;
  };
  metadata: OsintJsonRecord;
};

export type OsintObservation = {
  schemaVersion: typeof OSINT_SCHEMA_VERSION;
  id: string;
  investigationId: string;
  entityId: string;
  providerId: string;
  observedAt: string;
  retrievedAt: string;
  evidenceIds: string[];
  attributes: OsintJsonRecord;
  confidence: number;
  confidenceCategory: OsintConfidenceCategory;
  directness: "direct" | "derived" | "inferred";
  freshness: "live" | "recent" | "stale" | "historical" | "unknown";
  coverageLimitations: string[];
};

export type OsintClaim = {
  schemaVersion: typeof OSINT_SCHEMA_VERSION;
  id: string;
  investigationId: string;
  subjectEntityId: string;
  predicate: string;
  value: OsintJsonValue;
  validFrom?: string;
  validTo?: string;
  status: "proposed" | "supported" | "contested" | "superseded" | "unsupported";
  evidenceIds: string[];
  observationIds: string[];
  confidence: number;
  confidenceCategory: OsintConfidenceCategory;
  explanation: string;
};

export type OsintRelationship = {
  schemaVersion: typeof OSINT_SCHEMA_VERSION;
  id: string;
  investigationId: string;
  sourceEntityId: string;
  targetEntityId: string;
  type: string;
  direction: "directed" | "undirected";
  observedAt: string;
  validFrom?: string;
  validTo?: string;
  evidenceIds: string[];
  confidence: number;
  confidenceCategory: OsintConfidenceCategory;
  status: "observed" | "inferred" | "contested" | "superseded";
};

export type OsintLead = {
  schemaVersion: typeof OSINT_SCHEMA_VERSION;
  id: string;
  investigationId: string;
  entityId: string;
  seed: InvestigationSeed;
  reason: string;
  status: "candidate" | "approved" | "submitted" | "rejected" | "expired";
  depth: number;
  discoveredByEvidenceIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type OsintInvestigation = {
  schemaVersion: typeof OSINT_SCHEMA_VERSION;
  id: string;
  seed: InvestigationSeed;
  objective: string;
  authorizationMode: OsintAuthorizationMode;
  status: OsintInvestigationStatus;
  budget: InvestigationBudget;
  planId?: string;
  counts: {
    providers: number;
    externalCalls: number;
    entities: number;
    evidenceBytes: number;
    leads: number;
  };
  warnings: string[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type OsintContractName = "entity" | "identifier" | "observation" | "claim" | "relationship" | "evidence" | "lead" | "investigation";
export type OsintContractMap = {
  entity: OsintEntity;
  identifier: OsintIdentifier;
  observation: OsintObservation;
  claim: OsintClaim;
  relationship: OsintRelationship;
  evidence: OsintEvidence;
  lead: OsintLead;
  investigation: OsintInvestigation;
};

export type OsintContractSchema = {
  $id: string;
  type: "object";
  additionalProperties: false;
  required: readonly string[];
  properties: Readonly<Record<string, { type: string | readonly string[]; maxLength?: number; maximum?: number; minimum?: number }>>;
};

function closedSchema(name: OsintContractName, required: readonly string[], properties: OsintContractSchema["properties"]): OsintContractSchema {
  return { $id: `voidcat://osint/${OSINT_SCHEMA_VERSION}/${name}`, type: "object", additionalProperties: false, required, properties };
}

export const OSINT_CONTRACT_SCHEMAS: Record<OsintContractName, OsintContractSchema> = {
  identifier: closedSchema("identifier", ["schemaVersion", "id", "type", "value", "normalizedValue", "confidence", "evidenceIds"], { schemaVersion: { type: "string" }, id: { type: "string", maxLength: 160 }, type: { type: "string" }, value: { type: "string", maxLength: 2048 }, normalizedValue: { type: "string", maxLength: 2048 }, confidence: { type: "number", minimum: 0, maximum: 1 }, firstSeenAt: { type: "string" }, lastSeenAt: { type: "string" }, evidenceIds: { type: "array" } }),
  entity: closedSchema("entity", ["schemaVersion", "id", "type", "displayName", "identifiers", "attributes", "createdAt", "updatedAt"], { schemaVersion: { type: "string" }, id: { type: "string", maxLength: 160 }, type: { type: "string" }, displayName: { type: "string", maxLength: 500 }, identifiers: { type: "array" }, attributes: { type: "object" }, createdAt: { type: "string" }, updatedAt: { type: "string" } }),
  evidence: closedSchema("evidence", ["schemaVersion", "id", "providerId", "sourceType", "sourceRef", "retrievedAt", "title", "sha256", "byteLength", "sensitivity", "cache", "attribution", "metadata"], { schemaVersion: { type: "string" }, id: { type: "string", maxLength: 160 }, providerId: { type: "string", maxLength: 80 }, sourceType: { type: "string" }, sourceRef: { type: "string", maxLength: 2048 }, retrievedAt: { type: "string" }, observedAt: { type: "string" }, title: { type: "string", maxLength: 500 }, excerpt: { type: "string", maxLength: 12000 }, url: { type: "string", maxLength: 4096 }, mimeType: { type: "string", maxLength: 120 }, sha256: { type: "string", maxLength: 64 }, byteLength: { type: "integer", minimum: 0 }, sensitivity: { type: "string" }, cache: { type: "object" }, attribution: { type: "object" }, metadata: { type: "object" } }),
  observation: closedSchema("observation", ["schemaVersion", "id", "investigationId", "entityId", "providerId", "observedAt", "retrievedAt", "evidenceIds", "attributes", "confidence", "confidenceCategory", "directness", "freshness", "coverageLimitations"], { schemaVersion: { type: "string" }, id: { type: "string", maxLength: 160 }, investigationId: { type: "string", maxLength: 160 }, entityId: { type: "string", maxLength: 160 }, providerId: { type: "string", maxLength: 80 }, observedAt: { type: "string" }, retrievedAt: { type: "string" }, evidenceIds: { type: "array" }, attributes: { type: "object" }, confidence: { type: "number", minimum: 0, maximum: 1 }, confidenceCategory: { type: "string" }, directness: { type: "string" }, freshness: { type: "string" }, coverageLimitations: { type: "array" } }),
  claim: closedSchema("claim", ["schemaVersion", "id", "investigationId", "subjectEntityId", "predicate", "value", "status", "evidenceIds", "observationIds", "confidence", "confidenceCategory", "explanation"], { schemaVersion: { type: "string" }, id: { type: "string", maxLength: 160 }, investigationId: { type: "string", maxLength: 160 }, subjectEntityId: { type: "string", maxLength: 160 }, predicate: { type: "string", maxLength: 160 }, value: { type: ["string", "number", "boolean", "object", "array", "null"] }, validFrom: { type: "string" }, validTo: { type: "string" }, status: { type: "string" }, evidenceIds: { type: "array" }, observationIds: { type: "array" }, confidence: { type: "number", minimum: 0, maximum: 1 }, confidenceCategory: { type: "string" }, explanation: { type: "string", maxLength: 2000 } }),
  relationship: closedSchema("relationship", ["schemaVersion", "id", "investigationId", "sourceEntityId", "targetEntityId", "type", "direction", "observedAt", "evidenceIds", "confidence", "confidenceCategory", "status"], { schemaVersion: { type: "string" }, id: { type: "string", maxLength: 160 }, investigationId: { type: "string", maxLength: 160 }, sourceEntityId: { type: "string", maxLength: 160 }, targetEntityId: { type: "string", maxLength: 160 }, type: { type: "string", maxLength: 160 }, direction: { type: "string" }, observedAt: { type: "string" }, validFrom: { type: "string" }, validTo: { type: "string" }, evidenceIds: { type: "array" }, confidence: { type: "number", minimum: 0, maximum: 1 }, confidenceCategory: { type: "string" }, status: { type: "string" } }),
  lead: closedSchema("lead", ["schemaVersion", "id", "investigationId", "entityId", "seed", "reason", "status", "depth", "discoveredByEvidenceIds", "createdAt", "updatedAt"], { schemaVersion: { type: "string" }, id: { type: "string", maxLength: 160 }, investigationId: { type: "string", maxLength: 160 }, entityId: { type: "string", maxLength: 160 }, seed: { type: "object" }, reason: { type: "string", maxLength: 1000 }, status: { type: "string" }, depth: { type: "integer", minimum: 0 }, discoveredByEvidenceIds: { type: "array" }, createdAt: { type: "string" }, updatedAt: { type: "string" } }),
  investigation: closedSchema("investigation", ["schemaVersion", "id", "seed", "objective", "authorizationMode", "status", "budget", "counts", "warnings", "createdAt", "updatedAt"], { schemaVersion: { type: "string" }, id: { type: "string", maxLength: 160 }, seed: { type: "object" }, objective: { type: "string", maxLength: 2000 }, authorizationMode: { type: "string" }, status: { type: "string" }, budget: { type: "object" }, planId: { type: "string", maxLength: 160 }, counts: { type: "object" }, warnings: { type: "array" }, createdAt: { type: "string" }, updatedAt: { type: "string" }, completedAt: { type: "string" } }),
};

export class OsintContractError extends Error {
  readonly contract: OsintContractName | "budget" | "seed" | "provider-result";
  readonly issues: string[];

  constructor(contract: OsintContractError["contract"], issues: string[]) {
    super(`Invalid OSINT ${contract}: ${issues.join("; ")}`);
    this.name = "OsintContractError";
    this.contract = contract;
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && value.length >= 20 && Number.isFinite(Date.parse(value));
}

function closedObjectIssues(value: unknown, schema: OsintContractSchema) {
  if (!isRecord(value)) return ["must be an object"];
  const allowed = new Set(Object.keys(schema.properties));
  const issues = Object.keys(value).filter((key) => !allowed.has(key)).map((key) => `contains unsupported property ${key}`);
  for (const key of schema.required) if (!(key in value)) issues.push(`is missing required property ${key}`);
  return issues;
}

function stringIssue(value: unknown, label: string, maximum = 2048) {
  return typeof value === "string" && value.trim() && value.length <= maximum ? [] : [`${label} must be a non-empty string no longer than ${maximum} characters`];
}

function stringArrayIssues(value: unknown, label: string, maximum = 200) {
  if (!Array.isArray(value)) return [`${label} must be an array`];
  if (value.length > maximum) return [`${label} exceeds ${maximum} items`];
  return value.some((item) => typeof item !== "string" || !item.trim()) ? [`${label} must contain only non-empty strings`] : [];
}

function confidenceIssues(value: unknown, label = "confidence") {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? [] : [`${label} must be between 0 and 1`];
}

function enumIssues<T extends string>(value: unknown, label: string, allowed: readonly T[]) {
  return typeof value === "string" && allowed.includes(value as T) ? [] : [`${label} must be one of ${allowed.join(", ")}`];
}

function jsonValueIssues(value: unknown, label: string, depth = 0): string[] {
  if (depth > 12) return [`${label} exceeds the maximum JSON depth`];
  if (value === null || typeof value === "string" || typeof value === "boolean") return [];
  if (typeof value === "number") return Number.isFinite(value) ? [] : [`${label} contains a non-finite number`];
  if (Array.isArray(value)) {
    if (value.length > 1_000) return [`${label} exceeds 1,000 array items`];
    return value.flatMap((item, index) => jsonValueIssues(item, `${label}[${index}]`, depth + 1));
  }
  if (!isRecord(value)) return [`${label} must contain only JSON values`];
  const entries = Object.entries(value);
  if (entries.length > 1_000) return [`${label} exceeds 1,000 object properties`];
  return entries.flatMap(([key, item]) => key.length > 200 ? [`${label} contains an overlong property name`] : jsonValueIssues(item, `${label}.${key}`, depth + 1));
}

function optionalTimestampIssues(value: unknown, label: string) {
  return value === undefined || isIso(value) ? [] : [`${label} must be an ISO timestamp`];
}

function temporalOrderIssues(start: unknown, end: unknown, startLabel: string, endLabel: string) {
  if (!isIso(start) || !isIso(end)) return [];
  return Date.parse(start) <= Date.parse(end) ? [] : [`${startLabel} cannot be later than ${endLabel}`];
}

function commonIssues(value: Record<string, unknown>) {
  const issues = [...stringIssue(value.id, "id", 160)];
  if (value.schemaVersion !== OSINT_SCHEMA_VERSION) issues.push(`schemaVersion must be ${OSINT_SCHEMA_VERSION}`);
  return issues;
}

function identifierIssues(value: unknown): string[] {
  const issues = closedObjectIssues(value, OSINT_CONTRACT_SCHEMAS.identifier);
  if (!isRecord(value)) return issues;
  issues.push(...commonIssues(value), ...stringIssue(value.value, "value"), ...stringIssue(value.normalizedValue, "normalizedValue"), ...confidenceIssues(value.confidence), ...stringArrayIssues(value.evidenceIds, "evidenceIds"));
  if (!OSINT_IDENTIFIER_TYPES.includes(value.type as OsintIdentifierType)) issues.push("type is not a supported identifier type");
  if (value.firstSeenAt !== undefined && !isIso(value.firstSeenAt)) issues.push("firstSeenAt must be an ISO timestamp");
  if (value.lastSeenAt !== undefined && !isIso(value.lastSeenAt)) issues.push("lastSeenAt must be an ISO timestamp");
  return issues;
}

function seedIssues(value: unknown): string[] {
  if (!isRecord(value)) return ["seed must be an object"];
  const allowed = new Set(["type", "value", "label", "attributes", "source"]);
  const issues = Object.keys(value).filter((key) => !allowed.has(key)).map((key) => `seed contains unsupported property ${key}`);
  if (!OSINT_ENTITY_TYPES.includes(value.type as OsintEntityType)) issues.push("seed type is unsupported");
  issues.push(...stringIssue(value.value, "seed value"));
  if (value.label !== undefined) issues.push(...stringIssue(value.label, "seed label", 500));
  if (!isRecord(value.attributes)) issues.push("seed attributes must be an object"); else issues.push(...jsonValueIssues(value.attributes, "seed attributes"));
  if (!isRecord(value.source)) issues.push("seed source is invalid");
  else {
    const sourceKeys = Object.keys(value.source); if (sourceKeys.some((key) => !["kind", "id", "observationId"].includes(key))) issues.push("seed source contains unsupported properties");
    issues.push(...enumIssues(value.source.kind, "seed source kind", ["operator", "hunter-seeker", "agent", "candidate-lead"]), ...stringIssue(value.source.id, "seed source id", 160));
    if (value.source.observationId !== undefined) issues.push(...stringIssue(value.source.observationId, "seed source observationId", 160));
  }
  return issues;
}

function validateSpecific(name: OsintContractName, value: Record<string, unknown>): string[] {
  const issues = commonIssues(value);
  if (name === "identifier") return identifierIssues(value);
  if (name === "entity") {
    if (!OSINT_ENTITY_TYPES.includes(value.type as OsintEntityType)) issues.push("type is not a supported entity type");
    issues.push(...stringIssue(value.displayName, "displayName", 500));
    if (!Array.isArray(value.identifiers) || value.identifiers.length < 1 || value.identifiers.length > 100) issues.push("identifiers must be an array of between 1 and 100 items");
    else value.identifiers.forEach((identifier, index) => identifierIssues(identifier).forEach((issue) => issues.push(`identifiers[${index}] ${issue}`)));
    if (!isRecord(value.attributes)) issues.push("attributes must be an object"); else issues.push(...jsonValueIssues(value.attributes, "attributes"));
    if (!isIso(value.createdAt) || !isIso(value.updatedAt)) issues.push("createdAt and updatedAt must be ISO timestamps");
    issues.push(...temporalOrderIssues(value.createdAt, value.updatedAt, "createdAt", "updatedAt"));
  } else if (name === "evidence") {
    issues.push(...stringIssue(value.providerId, "providerId", 80), ...stringIssue(value.sourceRef, "sourceRef"), ...stringIssue(value.title, "title", 500));
    if (!isIso(value.retrievedAt) || (value.observedAt !== undefined && !isIso(value.observedAt))) issues.push("evidence timestamps must be ISO timestamps");
    issues.push(...enumIssues(value.sourceType, "sourceType", ["provider", "hunter-seeker", "web", "operator", "derived"]), ...enumIssues(value.sensitivity, "sensitivity", ["public", "restricted", "exposure-sensitive"]));
    if (value.excerpt !== undefined && (typeof value.excerpt !== "string" || value.excerpt.length > 12_000)) issues.push("excerpt must contain no more than 12,000 characters");
    if (value.url !== undefined) { try { const url = new URL(String(value.url)); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) issues.push("url must be an uncredentialed HTTP(S) URL"); } catch { issues.push("url must be a valid HTTP(S) URL"); } }
    if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) issues.push("sha256 must be a lowercase SHA-256 digest");
    if (!Number.isInteger(value.byteLength) || Number(value.byteLength) < 0) issues.push("byteLength must be a non-negative integer");
    if (!isRecord(value.cache)) issues.push("cache is invalid");
    else {
      if (Object.keys(value.cache).some((key) => !["status", "ageMs", "expiresAt"].includes(key))) issues.push("cache contains unsupported properties");
      issues.push(...enumIssues(value.cache.status, "cache status", ["live", "cached", "fixture", "not-applicable"]), ...optionalTimestampIssues(value.cache.expiresAt, "cache expiresAt"));
      if (!Number.isFinite(value.cache.ageMs) || Number(value.cache.ageMs) < 0) issues.push("cache ageMs must be non-negative");
    }
    if (!isRecord(value.attribution)) issues.push("attribution is invalid");
    else {
      if (Object.keys(value.attribution).some((key) => !["provider", "termsUrl"].includes(key))) issues.push("attribution contains unsupported properties");
      issues.push(...stringIssue(value.attribution.provider, "attribution provider", 200));
      if (value.attribution.termsUrl !== undefined) { try { const url = new URL(String(value.attribution.termsUrl)); if (!["http:", "https:"].includes(url.protocol)) issues.push("attribution termsUrl must be HTTP(S)"); } catch { issues.push("attribution termsUrl must be valid"); } }
    }
    if (!isRecord(value.metadata)) issues.push("metadata must be an object"); else issues.push(...jsonValueIssues(value.metadata, "metadata"));
  } else if (name === "observation") {
    issues.push(...stringIssue(value.investigationId, "investigationId", 160), ...stringIssue(value.entityId, "entityId", 160), ...stringIssue(value.providerId, "providerId", 80), ...confidenceIssues(value.confidence), ...stringArrayIssues(value.evidenceIds, "evidenceIds"), ...stringArrayIssues(value.coverageLimitations, "coverageLimitations", 50));
    if (!isIso(value.observedAt) || !isIso(value.retrievedAt)) issues.push("observation timestamps must be ISO timestamps");
    if (!isRecord(value.attributes)) issues.push("attributes must be an object"); else issues.push(...jsonValueIssues(value.attributes, "attributes"));
    issues.push(...enumIssues(value.confidenceCategory, "confidenceCategory", ["very-low", "low", "moderate", "high", "very-high"]), ...enumIssues(value.directness, "directness", ["direct", "derived", "inferred"]), ...enumIssues(value.freshness, "freshness", ["live", "recent", "stale", "historical", "unknown"]));
    if (typeof value.confidence === "number" && confidenceCategory(value.confidence) !== value.confidenceCategory) issues.push("confidenceCategory does not match confidence");
    if (Array.isArray(value.evidenceIds) && value.evidenceIds.length === 0) issues.push("observations require evidenceIds");
  } else if (name === "claim") {
    issues.push(...stringIssue(value.investigationId, "investigationId", 160), ...stringIssue(value.subjectEntityId, "subjectEntityId", 160), ...stringIssue(value.predicate, "predicate", 160), ...confidenceIssues(value.confidence), ...stringArrayIssues(value.evidenceIds, "evidenceIds"), ...stringArrayIssues(value.observationIds, "observationIds"), ...stringIssue(value.explanation, "explanation", 2000));
    issues.push(...jsonValueIssues(value.value, "claim value"), ...enumIssues(value.status, "status", ["proposed", "supported", "contested", "superseded", "unsupported"]), ...enumIssues(value.confidenceCategory, "confidenceCategory", ["very-low", "low", "moderate", "high", "very-high"]), ...optionalTimestampIssues(value.validFrom, "validFrom"), ...optionalTimestampIssues(value.validTo, "validTo"), ...temporalOrderIssues(value.validFrom, value.validTo, "validFrom", "validTo"));
    if (typeof value.confidence === "number" && confidenceCategory(value.confidence) !== value.confidenceCategory) issues.push("confidenceCategory does not match confidence");
    if (value.status === "supported" && (!Array.isArray(value.evidenceIds) || value.evidenceIds.length === 0)) issues.push("supported claims require evidenceIds");
    if (value.status === "unsupported" && Array.isArray(value.evidenceIds) && value.evidenceIds.length > 0) issues.push("unsupported claims cannot cite supporting evidence");
  } else if (name === "relationship") {
    issues.push(...stringIssue(value.investigationId, "investigationId", 160), ...stringIssue(value.sourceEntityId, "sourceEntityId", 160), ...stringIssue(value.targetEntityId, "targetEntityId", 160), ...stringIssue(value.type, "type", 160), ...confidenceIssues(value.confidence), ...stringArrayIssues(value.evidenceIds, "evidenceIds"));
    if (!isIso(value.observedAt)) issues.push("observedAt must be an ISO timestamp");
    issues.push(...enumIssues(value.direction, "direction", ["directed", "undirected"]), ...enumIssues(value.confidenceCategory, "confidenceCategory", ["very-low", "low", "moderate", "high", "very-high"]), ...enumIssues(value.status, "status", ["observed", "inferred", "contested", "superseded"]), ...optionalTimestampIssues(value.validFrom, "validFrom"), ...optionalTimestampIssues(value.validTo, "validTo"), ...temporalOrderIssues(value.validFrom, value.validTo, "validFrom", "validTo"));
    if (typeof value.confidence === "number" && confidenceCategory(value.confidence) !== value.confidenceCategory) issues.push("confidenceCategory does not match confidence");
    if (Array.isArray(value.evidenceIds) && value.evidenceIds.length === 0) issues.push("relationships require evidenceIds");
  } else if (name === "lead") {
    issues.push(...stringIssue(value.investigationId, "investigationId", 160), ...stringIssue(value.entityId, "entityId", 160), ...stringIssue(value.reason, "reason", 1000), ...stringArrayIssues(value.discoveredByEvidenceIds, "discoveredByEvidenceIds"), ...seedIssues(value.seed));
    if (!Number.isInteger(value.depth) || Number(value.depth) < 0) issues.push("depth must be a non-negative integer");
    if (!isIso(value.createdAt) || !isIso(value.updatedAt)) issues.push("lead timestamps must be ISO timestamps");
    issues.push(...enumIssues(value.status, "status", ["candidate", "approved", "submitted", "rejected", "expired"]), ...temporalOrderIssues(value.createdAt, value.updatedAt, "createdAt", "updatedAt"));
    if (value.status === "candidate" && Array.isArray(value.discoveredByEvidenceIds) && value.discoveredByEvidenceIds.length === 0) issues.push("candidate leads require discovery evidence");
  } else if (name === "investigation") {
    issues.push(...seedIssues(value.seed), ...stringIssue(value.objective, "objective", 2000));
    if (!isRecord(value.budget)) issues.push("budget must be an object"); else issues.push(...investigationBudgetIssues(value.budget));
    if (!isRecord(value.counts)) issues.push("counts must be an object");
    else {
      const counts = value.counts;
      const countKeys = ["providers", "externalCalls", "entities", "evidenceBytes", "leads"];
      if (Object.keys(counts).some((key) => !countKeys.includes(key)) || countKeys.some((key) => !Number.isInteger(counts[key]) || Number(counts[key]) < 0)) issues.push("counts must contain only non-negative integer accounting fields");
    }
    issues.push(...stringArrayIssues(value.warnings, "warnings", 100));
    if (!isIso(value.createdAt) || !isIso(value.updatedAt)) issues.push("investigation timestamps must be ISO timestamps");
    issues.push(...enumIssues(value.authorizationMode, "authorizationMode", ["public-research", "owned-asset", "authorized-client", "exposure-check"]), ...enumIssues(value.status, "status", ["draft", "planned", "running", "completed", "partial", "failed", "cancelled"]), ...optionalTimestampIssues(value.completedAt, "completedAt"), ...temporalOrderIssues(value.createdAt, value.updatedAt, "createdAt", "updatedAt"));
    if (value.completedAt !== undefined) issues.push(...temporalOrderIssues(value.createdAt, value.completedAt, "createdAt", "completedAt"));
    if (["planned", "running", "completed", "partial"].includes(String(value.status)) && (typeof value.planId !== "string" || !value.planId.trim())) issues.push("planned and executed investigations require planId");
    if (["completed", "partial", "failed", "cancelled"].includes(String(value.status)) && !isIso(value.completedAt)) issues.push("terminal investigations require completedAt");
    if (isRecord(value.counts) && isRecord(value.budget)) {
      if (Number(value.counts.providers) > Number(value.budget.maximumProviders)) issues.push("provider count exceeds budget");
      if (Number(value.counts.externalCalls) > Number(value.budget.maximumExternalCalls)) issues.push("external-call count exceeds budget");
      if (Number(value.counts.entities) > Number(value.budget.maximumEntities)) issues.push("entity count exceeds budget");
      if (Number(value.counts.evidenceBytes) > Number(value.budget.maximumEvidenceBytes)) issues.push("evidence-byte count exceeds budget");
    }
  }
  return issues;
}

export function validateOsintContract<K extends OsintContractName>(name: K, value: unknown): OsintContractMap[K] {
  const issues = closedObjectIssues(value, OSINT_CONTRACT_SCHEMAS[name]);
  if (isRecord(value)) issues.push(...validateSpecific(name, value));
  if (issues.length) throw new OsintContractError(name, [...new Set(issues)]);
  return structuredClone(value) as OsintContractMap[K];
}

export const DEFAULT_INVESTIGATION_BUDGET: Readonly<InvestigationBudget> = Object.freeze({
  maximumProviders: 4,
  maximumExternalCalls: 12,
  maximumRuntimeMs: 120_000,
  maximumEntities: 250,
  maximumEvidenceBytes: 2 * 1024 * 1024,
  maximumDiscoveryDepth: 1,
});

export const HARD_INVESTIGATION_BUDGET: Readonly<InvestigationBudget> = Object.freeze({
  maximumProviders: 12,
  maximumExternalCalls: 100,
  maximumRuntimeMs: 10 * 60_000,
  maximumEntities: 5_000,
  maximumEvidenceBytes: 50 * 1024 * 1024,
  maximumDiscoveryDepth: 3,
});

export function investigationBudgetIssues(value: Record<string, unknown>): string[] {
  const required = Object.keys(DEFAULT_INVESTIGATION_BUDGET) as Array<keyof InvestigationBudget>;
  const minimums: InvestigationBudget = { maximumProviders: 1, maximumExternalCalls: 1, maximumRuntimeMs: 50, maximumEntities: 1, maximumEvidenceBytes: 1, maximumDiscoveryDepth: 0 };
  const issues = Object.keys(value).filter((key) => !required.includes(key as keyof InvestigationBudget)).map((key) => `budget contains unsupported property ${key}`);
  for (const key of required) {
    const amount = value[key];
    if (!Number.isInteger(amount) || Number(amount) < minimums[key]) issues.push(`${key} must be an integer of at least ${minimums[key]}`);
    else if (Number(amount) > HARD_INVESTIGATION_BUDGET[key]) issues.push(`${key} exceeds the hard maximum of ${HARD_INVESTIGATION_BUDGET[key]}`);
  }
  return issues;
}

export function validateInvestigationBudget(value: unknown): InvestigationBudget {
  if (!isRecord(value)) throw new OsintContractError("budget", ["budget must be an object"]);
  const issues = investigationBudgetIssues(value);
  if (issues.length) throw new OsintContractError("budget", issues);
  return structuredClone(value) as InvestigationBudget;
}

export function validateInvestigationSeed(value: unknown): InvestigationSeed {
  const issues = seedIssues(value);
  if (issues.length) throw new OsintContractError("seed", issues);
  return structuredClone(value) as InvestigationSeed;
}

export function confidenceCategory(confidence: number): OsintConfidenceCategory {
  if (confidence >= 0.9) return "very-high";
  if (confidence >= 0.75) return "high";
  if (confidence >= 0.5) return "moderate";
  if (confidence >= 0.25) return "low";
  return "very-low";
}

export function toOsintJsonRecord(value: unknown, maximumDepth = 8): OsintJsonRecord {
  function convert(candidate: unknown, depth: number): OsintJsonValue {
    if (depth > maximumDepth) return "[depth-limited]";
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number") return Number.isFinite(candidate) ? candidate : null;
    if (Array.isArray(candidate)) return candidate.slice(0, 200).map((item) => convert(item, depth + 1));
    if (!isRecord(candidate)) return String(candidate).slice(0, 1000);
    return Object.fromEntries(Object.entries(candidate).slice(0, 200).map(([key, item]) => [key.slice(0, 200), convert(item, depth + 1)]));
  }
  const converted = convert(value, 0);
  return isRecord(converted) ? converted as OsintJsonRecord : { value: converted };
}
