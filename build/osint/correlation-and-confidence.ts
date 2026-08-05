/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import {
  OSINT_SCHEMA_VERSION,
  confidenceCategory,
  validateOsintContract,
  type OsintClaim,
  type OsintEntity,
  type OsintEvidence,
  type OsintIdentifierType,
  type OsintJsonRecord,
  type OsintJsonValue,
  type OsintLead,
  type OsintObservation,
  type OsintRelationship,
} from "./contracts.ts";
import { osintStableId, type NormalizedOsintProviderResult, type OsintProviderDescriptor } from "./provider-contracts.ts";
import { compareEntitiesForResolution, type EntityResolutionCandidate } from "./intelligence-model.ts";

export type OsintCorrelationInput = {
  investigationId: string;
  providerResults: NormalizedOsintProviderResult[];
  seedRecords?: { entities: OsintEntity[]; evidence: OsintEvidence[]; observations: OsintObservation[] };
  providers: OsintProviderDescriptor[];
};

export type OsintIdentityLink = {
  id: string;
  canonicalEntityId: string;
  memberEntityIds: string[];
  sourceRecordCount: number;
  identifierType: OsintIdentifierType;
  normalizedValue: string;
  values: string[];
  matchKind: "exact" | "normalized" | "alias";
  confidence: number;
  evidenceIds: string[];
};

export type OsintTemporalChange = {
  id: string;
  entityId: string;
  predicate: string;
  changeType: "attribute-change" | "service-change";
  fromClaimId: string;
  toClaimId: string;
  fromValue: OsintJsonValue;
  toValue: OsintJsonValue;
  observedAt: string;
  evidenceIds: string[];
  observationIds: string[];
  explanation: string;
};

export type OsintContradiction = {
  id: string;
  subjectEntityId: string;
  predicate: string;
  claimIds: string[];
  values: OsintJsonValue[];
  evidenceIds: string[];
  observationIds: string[];
  detectedAt: string;
  explanation: string;
};

export type OsintConfidenceSource = {
  sourceFamily: string;
  providerIds: string[];
  evidenceIds: string[];
  reliabilityWeight: number;
  freshnessWeight: number;
  directnessWeight: number;
  observationConfidence: number;
  weightedScore: number;
};

export type OsintConclusion = {
  claimId: string;
  statement: string;
  supportingEvidenceIds: string[];
  supportingObservationIds: string[];
  contradictingClaimIds: string[];
  contradictingEvidenceIds: string[];
  freshness: {
    category: OsintObservation["freshness"];
    oldestObservedAt?: string;
    newestObservedAt?: string;
    ageAtRetrievalMs?: number;
  };
  confidence: {
    score: number;
    category: OsintClaim["confidenceCategory"];
    independentSourceCount: number;
    duplicateSourceCount: number;
    contradictionPenalty: number;
    sources: OsintConfidenceSource[];
    explanation: string;
  };
  coverageLimitations: string[];
};

export type OsintCorrelationResult = {
  entities: OsintEntity[];
  evidence: OsintEvidence[];
  observations: OsintObservation[];
  claims: OsintClaim[];
  conclusions: OsintConclusion[];
  relationships: OsintRelationship[];
  leads: OsintLead[];
  identityLinks: OsintIdentityLink[];
  resolutionCandidates: EntityResolutionCandidate[];
  changes: OsintTemporalChange[];
  contradictions: OsintContradiction[];
  deduplication: {
    inputEntities: number;
    outputEntities: number;
    mergedEntities: number;
    duplicateEvidence: number;
    duplicateLeads: number;
  };
};

type ClaimSample = {
  entityId: string;
  predicate: string;
  value: OsintJsonValue;
  observedAt: string;
  retrievedAt: string;
  evidenceIds: string[];
  observationIds: string[];
  providerId: string;
  confidence: number;
  directness: OsintObservation["directness"];
  freshness: OsintObservation["freshness"];
  coverageLimitations: string[];
};

type ClaimEpisode = {
  id: string;
  entityId: string;
  predicate: string;
  value: OsintJsonValue;
  validFrom: string;
  validTo?: string;
  status: OsintClaim["status"];
  samples: ClaimSample[];
};

const ALIAS_IDENTIFIER_TYPES = new Set<OsintIdentifierType>(["username", "organization-name", "aircraft-callsign", "vessel-name", "geographic-label"]);
const NON_CORRELATING_IDENTIFIER_TYPES = new Set<OsintIdentifierType>(["provider-record", "hunter-observation"]);
const SERVICE_ATTRIBUTE = /^(?:service|services|port|ports|protocol|protocols|product|products|software|technologies)$/i;
const CONTEMPORANEOUS_WINDOW_MS = 60_000;
const DIRECTNESS_WEIGHT: Record<OsintObservation["directness"], number> = { direct: 1, derived: 0.82, inferred: 0.62 };
const FRESHNESS_WEIGHT: Record<OsintObservation["freshness"], number> = { live: 1, recent: 0.95, stale: 0.7, historical: 0.55, unknown: 0.6 };

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

function unique(values: string[]) { return [...new Set(values)].sort(); }
function boundedUnique(values: string[], maximum = 100) { return unique(values.filter(Boolean)).slice(0, maximum); }
function mergeJsonRecords(records: OsintJsonRecord[]) {
  const output: OsintJsonRecord = {};
  for (const record of records) for (const [key, value] of Object.entries(record).sort(([left], [right]) => left.localeCompare(right))) {
    if (!(key in output)) output[key] = structuredClone(value);
    else if (stableJson(output[key]) !== stableJson(value)) {
      const variants = Array.isArray(output[`${key}Variants`]) ? output[`${key}Variants`] as OsintJsonValue[] : [output[key]];
      if (!variants.some((candidate) => stableJson(candidate) === stableJson(value))) variants.push(structuredClone(value));
      output[`${key}Variants`] = variants;
    }
  }
  return output;
}

class DisjointSet {
  private readonly parent: number[];
  constructor(size: number) { this.parent = Array.from({ length: size }, (_, index) => index); }
  find(value: number): number { const parent = this.parent[value]; if (parent === value) return value; this.parent[value] = this.find(parent); return this.parent[value]; }
  union(left: number, right: number) { const leftRoot = this.find(left); const rightRoot = this.find(right); if (leftRoot === rightRoot) return; this.parent[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot); }
}

function entityTypesCompatible(left: OsintEntity, right: OsintEntity) { return left.type === right.type || left.type === "unknown" || right.type === "unknown"; }

function deduplicateEntities(input: OsintEntity[], investigationId: string) {
  const entities = [...input].sort((left, right) => left.id.localeCompare(right.id));
  const groups = new DisjointSet(entities.length);
  const entityIdOwners = new Map<string, number>();
  entities.forEach((entity, entityIndex) => { const owner = entityIdOwners.get(entity.id); if (owner === undefined) entityIdOwners.set(entity.id, entityIndex); else groups.union(owner, entityIndex); });
  const identifierOwners = new Map<string, Array<{ entityIndex: number; identifier: OsintEntity["identifiers"][number] }>>();
  entities.forEach((entity, entityIndex) => {
    for (const identifier of entity.identifiers) {
      if (NON_CORRELATING_IDENTIFIER_TYPES.has(identifier.type)) continue;
      const key = `${identifier.type}:${identifier.normalizedValue}`;
      const owners = identifierOwners.get(key) ?? [];
      for (const owner of owners) {
        const alias = ALIAS_IDENTIFIER_TYPES.has(identifier.type);
        const aliasSafe = !alias && entityTypesCompatible(entity, entities[owner.entityIndex]);
        if (aliasSafe) groups.union(owner.entityIndex, entityIndex);
      }
      owners.push({ entityIndex, identifier }); identifierOwners.set(key, owners);
    }
  });

  const grouped = new Map<number, OsintEntity[]>();
  entities.forEach((entity, index) => { const root = groups.find(index); grouped.set(root, [...(grouped.get(root) ?? []), entity]); });
  const idMap = new Map<string, string>();
  const merged = [...grouped.values()].map((members) => {
    const ordered = [...members].sort((left, right) => left.id.localeCompare(right.id));
    const canonicalId = ordered[0].id; ordered.forEach(({ id }) => idMap.set(id, canonicalId));
    const identifierGroups = new Map<string, OsintEntity["identifiers"]>();
    for (const identifier of ordered.flatMap(({ identifiers }) => identifiers).sort((left, right) => left.id.localeCompare(right.id))) {
      const key = `${identifier.type}:${identifier.normalizedValue}:${identifier.value}`;
      identifierGroups.set(key, [...(identifierGroups.get(key) ?? []), identifier]);
    }
    const identifiers = [...identifierGroups.values()].map((values) => validateOsintContract("identifier", {
      ...values[0], confidence: Math.max(...values.map(({ confidence }) => confidence)),
      ...(values.some(({ firstSeenAt }) => firstSeenAt) ? { firstSeenAt: values.map(({ firstSeenAt }) => firstSeenAt).filter(Boolean).sort()[0] } : {}),
      ...(values.some(({ lastSeenAt }) => lastSeenAt) ? { lastSeenAt: values.map(({ lastSeenAt }) => lastSeenAt).filter(Boolean).sort().at(-1) } : {}),
      evidenceIds: unique(values.flatMap(({ evidenceIds }) => evidenceIds)),
    }));
    const entityTypes = ordered.map(({ type }) => type).filter((type) => type !== "unknown");
    return validateOsintContract("entity", {
      schemaVersion: OSINT_SCHEMA_VERSION, id: canonicalId, type: entityTypes.sort()[0] ?? "unknown",
      displayName: ordered.map(({ displayName }) => displayName).sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }))[0],
      identifiers, attributes: mergeJsonRecords(ordered.map(({ attributes }) => attributes)),
      createdAt: ordered.map(({ createdAt }) => createdAt).sort()[0], updatedAt: ordered.map(({ updatedAt }) => updatedAt).sort().at(-1) as string,
    });
  }).sort((left, right) => left.id.localeCompare(right.id));

  const identityLinks: OsintIdentityLink[] = [];
  for (const [key, owners] of [...identifierOwners.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const sourceRecordCount = new Set(owners.map(({ entityIndex }) => entityIndex)).size;
    const members = unique(owners.map(({ entityIndex }) => entities[entityIndex].id));
    const canonicalIds = unique(members.map((id) => idMap.get(id) ?? id));
    if (sourceRecordCount < 2 || canonicalIds.length !== 1) continue;
    const separator = key.indexOf(":"); const identifierType = key.slice(0, separator) as OsintIdentifierType; const normalizedValue = key.slice(separator + 1);
    const values = unique(owners.map(({ identifier }) => identifier.value));
    const matchKind = ALIAS_IDENTIFIER_TYPES.has(identifierType) ? "alias" : values.length === 1 ? "exact" : "normalized";
    identityLinks.push({
      id: osintStableId("identity", { canonicalEntityId: canonicalIds[0], identifierType, normalizedValue, members, sourceRecordCount }), canonicalEntityId: canonicalIds[0], memberEntityIds: members, sourceRecordCount,
      identifierType, normalizedValue, values, matchKind, confidence: Math.min(...owners.map(({ identifier }) => identifier.confidence)),
      evidenceIds: unique(owners.flatMap(({ identifier }) => identifier.evidenceIds)),
    });
  }
  const resolutionCandidates: EntityResolutionCandidate[] = [];
  for (const [key, owners] of [...identifierOwners.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const separator = key.indexOf(":"); const identifierType = key.slice(0, separator) as OsintIdentifierType;
    if (!ALIAS_IDENTIFIER_TYPES.has(identifierType)) continue;
    const entityIndexes = [...new Set(owners.map(({ entityIndex }) => entityIndex))].sort((left, right) => entities[left].id.localeCompare(entities[right].id));
    for (let left = 0; left < entityIndexes.length; left += 1) for (let right = left + 1; right < entityIndexes.length; right += 1) {
      const leftEntity = entities[entityIndexes[left]]; const rightEntity = entities[entityIndexes[right]];
      if (leftEntity.id === rightEntity.id || !entityTypesCompatible(leftEntity, rightEntity)) continue;
      const createdAt = [leftEntity.updatedAt, rightEntity.updatedAt].sort().at(-1) as string;
      resolutionCandidates.push(compareEntitiesForResolution(investigationId, leftEntity, rightEntity, createdAt));
      if (resolutionCandidates.length >= 500) break;
    }
    if (resolutionCandidates.length >= 500) break;
  }
  return { entities: merged, idMap, identityLinks, resolutionCandidates };
}

function deduplicateById<T extends { id: string }>(items: T[], label: string) {
  const output = new Map<string, T>(); let duplicates = 0;
  for (const item of [...items].sort((left, right) => left.id.localeCompare(right.id))) {
    const current = output.get(item.id);
    if (!current) output.set(item.id, item);
    else if (stableJson(current) !== stableJson(item)) throw new Error(`Conflicting ${label} records share id ${item.id}.`);
    else duplicates += 1;
  }
  return { values: [...output.values()], duplicates };
}

function remapObservations(observations: OsintObservation[], idMap: Map<string, string>) {
  return deduplicateById(observations.map((observation) => validateOsintContract("observation", { ...observation, entityId: idMap.get(observation.entityId) ?? observation.entityId, evidenceIds: unique(observation.evidenceIds) })), "observation").values;
}

function evidenceSourceFamily(evidence: OsintEvidence | undefined, fallbackProvider: string) {
  if (!evidence) return fallbackProvider.toLocaleLowerCase("en-US");
  const metadata = evidence.metadata;
  for (const key of ["sourceFamily", "upstreamProvider", "sourceDataset", "sourceFeedId"]) {
    const value = metadata[key]; if (typeof value === "string" && value.trim()) return value.trim().toLocaleLowerCase("en-US");
  }
  return (evidence.attribution.provider || evidence.providerId || fallbackProvider).trim().toLocaleLowerCase("en-US");
}

function evidenceCacheWeight(evidence: OsintEvidence | undefined) {
  if (!evidence || evidence.cache.status !== "cached") return 1;
  return Math.max(0.65, 1 - Math.min(evidence.cache.ageMs, 7 * 86_400_000) / (7 * 86_400_000) * 0.35);
}

function scoreSamples(samples: ClaimSample[], evidenceById: Map<string, OsintEvidence>, reliability: Map<string, number>) {
  const sourceMap = new Map<string, OsintConfidenceSource>(); let sourceOccurrences = 0;
  for (const sample of samples) {
    const evidenceRecords = sample.evidenceIds.map((id) => evidenceById.get(id)).filter(Boolean) as OsintEvidence[];
    const sources = evidenceRecords.length ? evidenceRecords : [undefined];
    for (const evidence of sources) {
      sourceOccurrences += 1;
      const providerId = evidence?.providerId ?? sample.providerId;
      const sourceFamily = evidenceSourceFamily(evidence, providerId);
      const reliabilityWeight = reliability.get(providerId) ?? reliability.get(sample.providerId) ?? 0.65;
      const directnessWeight = DIRECTNESS_WEIGHT[sample.directness];
      const freshnessWeight = FRESHNESS_WEIGHT[sample.freshness] * evidenceCacheWeight(evidence);
      const weightedScore = Math.min(0.99, sample.confidence * reliabilityWeight * directnessWeight * freshnessWeight);
      const current = sourceMap.get(sourceFamily);
      if (!current || weightedScore > current.weightedScore) sourceMap.set(sourceFamily, {
        sourceFamily, providerIds: unique([...(current?.providerIds ?? []), providerId]), evidenceIds: unique([...(current?.evidenceIds ?? []), ...(evidence ? [evidence.id] : sample.evidenceIds)]),
        reliabilityWeight, freshnessWeight, directnessWeight, observationConfidence: sample.confidence, weightedScore,
      });
      else {
        current.providerIds = unique([...current.providerIds, providerId]); current.evidenceIds = unique([...current.evidenceIds, ...(evidence ? [evidence.id] : sample.evidenceIds)]);
      }
    }
  }
  const sources = [...sourceMap.values()].sort((left, right) => left.sourceFamily.localeCompare(right.sourceFamily));
  const score = sources.length ? Math.min(0.99, 1 - sources.reduce((remaining, source) => remaining * (1 - source.weightedScore), 1)) : 0;
  return { score, sources, duplicateSourceCount: Math.max(0, sourceOccurrences - sources.length) };
}

function deduplicateRelationships(input: OsintRelationship[], idMap: Map<string, string>, evidenceById: Map<string, OsintEvidence>, reliability: Map<string, number>) {
  const grouped = new Map<string, OsintRelationship[]>();
  for (const relationship of input) {
    const sourceEntityId = idMap.get(relationship.sourceEntityId) ?? relationship.sourceEntityId;
    const targetEntityId = idMap.get(relationship.targetEntityId) ?? relationship.targetEntityId;
    const key = `${sourceEntityId}|${relationship.type}|${targetEntityId}|${relationship.direction}|${relationship.observedAt}`;
    grouped.set(key, [...(grouped.get(key) ?? []), { ...relationship, sourceEntityId, targetEntityId }]);
  }
  return [...grouped.entries()].map(([key, members]) => {
    const samples: ClaimSample[] = members.map((relationship) => ({
      entityId: relationship.sourceEntityId, predicate: `relationship.${relationship.type}`, value: relationship.targetEntityId, observedAt: relationship.observedAt, retrievedAt: relationship.observedAt,
      evidenceIds: relationship.evidenceIds, observationIds: [], providerId: evidenceById.get(relationship.evidenceIds[0])?.providerId ?? "unknown", confidence: relationship.confidence,
      directness: relationship.status === "inferred" ? "inferred" : "direct", freshness: "unknown", coverageLimitations: ["Relationship evidence does not establish exclusivity or uninterrupted continuity."],
    }));
    const confidence = scoreSamples(samples, evidenceById, reliability).score;
    return validateOsintContract("relationship", {
      schemaVersion: OSINT_SCHEMA_VERSION, id: osintStableId("rel", { investigationId: members[0].investigationId, key }), investigationId: members[0].investigationId,
      sourceEntityId: members[0].sourceEntityId, targetEntityId: members[0].targetEntityId, type: members[0].type, direction: members[0].direction,
      observedAt: members[0].observedAt, evidenceIds: unique(members.flatMap(({ evidenceIds }) => evidenceIds)), confidence,
      confidenceCategory: confidenceCategory(confidence), status: members.some(({ status }) => status === "contested") ? "contested" : members[0].status,
    });
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function claimableAttributes(attributes: OsintJsonRecord) {
  return Object.entries(attributes).filter(([key, value]) => {
    if (key.endsWith("Variants")) return false;
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
    return SERVICE_ATTRIBUTE.test(key) && stableJson(value).length <= 4_000;
  }).sort(([left], [right]) => left.localeCompare(right));
}

function claimAttributeValue(attribute: string, value: OsintJsonValue) {
  if (!SERVICE_ATTRIBUTE.test(attribute) || !Array.isArray(value)) return value;
  const uniqueValues = new Map(value.map((item) => [stableJson(item), item]));
  return [...uniqueValues.entries()].sort(([leftKey, left], [rightKey, right]) => typeof left === "number" && typeof right === "number" ? left - right : leftKey.localeCompare(rightKey)).map(([, item]) => structuredClone(item)) as OsintJsonValue;
}

function episodeId(investigationId: string, episode: Pick<ClaimEpisode, "entityId" | "predicate" | "value" | "validFrom">) {
  return osintStableId("claim", { investigationId, subjectEntityId: episode.entityId, predicate: episode.predicate, value: episode.value, validFrom: episode.validFrom });
}

function attributeEpisodes(investigationId: string, observations: OsintObservation[]) {
  const samplesByPredicate = new Map<string, ClaimSample[]>();
  for (const observation of observations) for (const [attribute, value] of claimableAttributes(observation.attributes)) {
    const predicate = `attribute.${attribute}`; const key = `${observation.entityId}|${predicate}`;
    const sample: ClaimSample = {
      entityId: observation.entityId, predicate, value: claimAttributeValue(attribute, value), observedAt: observation.observedAt, retrievedAt: observation.retrievedAt,
      evidenceIds: observation.evidenceIds, observationIds: [observation.id], providerId: observation.providerId, confidence: observation.confidence,
      directness: observation.directness, freshness: observation.freshness, coverageLimitations: observation.coverageLimitations,
    };
    samplesByPredicate.set(key, [...(samplesByPredicate.get(key) ?? []), sample]);
  }

  const episodes: ClaimEpisode[] = []; const changes: OsintTemporalChange[] = []; const contradictionGroups: Array<{ episodes: ClaimEpisode[]; detectedAt: string }> = [];
  for (const samples of [...samplesByPredicate.values()]) {
    const timeGroups: ClaimSample[][] = [];
    for (const sample of [...samples].sort((left, right) => left.observedAt.localeCompare(right.observedAt) || stableJson(left.value).localeCompare(stableJson(right.value)))) {
      const current = timeGroups.at(-1); const anchor = current?.[0]?.observedAt;
      if (current && anchor && Math.abs(Date.parse(sample.observedAt) - Date.parse(anchor)) <= CONTEMPORANEOUS_WINDOW_MS) current.push(sample);
      else timeGroups.push([sample]);
    }
    let active: ClaimEpisode | undefined;
    for (const timeSamples of timeGroups) {
      const observedAt = timeSamples.map(({ observedAt: value }) => value).sort()[0];
      const detectedAt = timeSamples.map(({ observedAt: value }) => value).sort().at(-1)!;
      const byValue = new Map<string, ClaimSample[]>();
      for (const sample of timeSamples) { const key = stableJson(sample.value); byValue.set(key, [...(byValue.get(key) ?? []), sample]); }
      if (byValue.size > 1) {
        if (active) { active.validTo = observedAt; active.status = "superseded"; active = undefined; }
        const contested = [...byValue.values()].map((valueSamples) => {
          const episode: ClaimEpisode = { id: "", entityId: valueSamples[0].entityId, predicate: valueSamples[0].predicate, value: valueSamples[0].value, validFrom: observedAt, validTo: observedAt, status: "contested", samples: valueSamples };
          episode.id = episodeId(investigationId, episode); episodes.push(episode); return episode;
        });
        contradictionGroups.push({ episodes: contested, detectedAt }); continue;
      }
      const valueSamples = [...byValue.values()][0]; const value = valueSamples[0].value;
      if (active && stableJson(active.value) === stableJson(value)) { active.samples.push(...valueSamples); continue; }
      const next: ClaimEpisode = { id: "", entityId: valueSamples[0].entityId, predicate: valueSamples[0].predicate, value, validFrom: observedAt, status: "supported", samples: valueSamples };
      next.id = episodeId(investigationId, next);
      if (active) {
        active.validTo = observedAt; active.status = "superseded";
        const evidenceIds = unique([...active.samples.flatMap(({ evidenceIds }) => evidenceIds), ...next.samples.flatMap(({ evidenceIds }) => evidenceIds)]);
        const observationIds = unique([...active.samples.flatMap(({ observationIds }) => observationIds), ...next.samples.flatMap(({ observationIds }) => observationIds)]);
        const changeType = SERVICE_ATTRIBUTE.test(active.predicate.slice("attribute.".length)) ? "service-change" as const : "attribute-change" as const;
        changes.push({
          id: osintStableId("change", { investigationId, entityId: active.entityId, predicate: active.predicate, fromClaimId: active.id, toClaimId: next.id, observedAt }), entityId: active.entityId, predicate: active.predicate, changeType,
          fromClaimId: active.id, toClaimId: next.id, fromValue: active.value, toValue: next.value, observedAt, evidenceIds, observationIds,
          explanation: `${active.predicate} changed from ${stableJson(active.value)} to ${stableJson(next.value)} at ${observedAt}; the observations remain separate and the earlier claim is superseded.`,
        });
      }
      episodes.push(next); active = next;
    }
  }
  return { episodes, changes, contradictionGroups };
}

function relationshipEpisodes(investigationId: string, relationships: OsintRelationship[], evidenceById: Map<string, OsintEvidence>) {
  return relationships.map((relationship): ClaimEpisode => {
    const evidence = evidenceById.get(relationship.evidenceIds[0]);
    const sample: ClaimSample = {
      entityId: relationship.sourceEntityId, predicate: `relationship.${relationship.type}`, value: relationship.targetEntityId, observedAt: relationship.observedAt, retrievedAt: evidence?.retrievedAt ?? relationship.observedAt,
      evidenceIds: relationship.evidenceIds, observationIds: [], providerId: evidence?.providerId ?? "unknown", confidence: relationship.confidence,
      directness: relationship.status === "inferred" ? "inferred" : "direct", freshness: evidence?.cache.status === "cached" ? "recent" : "unknown",
      coverageLimitations: ["Relationship evidence does not establish exclusivity or uninterrupted continuity."],
    };
    const episode = { id: "", entityId: relationship.sourceEntityId, predicate: sample.predicate, value: relationship.targetEntityId, validFrom: relationship.observedAt, status: relationship.status === "contested" ? "contested" as const : "supported" as const, samples: [sample] };
    episode.id = episodeId(investigationId, episode); return episode;
  });
}

function freshnessSummary(samples: ClaimSample[]): OsintConclusion["freshness"] {
  const ordered = [...samples].sort((left, right) => left.observedAt.localeCompare(right.observedAt));
  if (!ordered.length) return { category: "unknown" };
  const newest = ordered.at(-1)!;
  return { category: newest.freshness, oldestObservedAt: ordered[0].observedAt, newestObservedAt: newest.observedAt, ageAtRetrievalMs: Math.max(0, Date.parse(newest.retrievedAt) - Date.parse(newest.observedAt)) };
}

function createClaimsAndAnalysis(investigationId: string, observations: OsintObservation[], relationships: OsintRelationship[], evidenceById: Map<string, OsintEvidence>, reliability: Map<string, number>) {
  const attributes = attributeEpisodes(investigationId, observations);
  const episodes = [...attributes.episodes, ...relationshipEpisodes(investigationId, relationships, evidenceById)].sort((left, right) => left.id.localeCompare(right.id));
  const contradictionByClaim = new Map<string, ClaimEpisode[]>();
  const contradictions: OsintContradiction[] = attributes.contradictionGroups.map(({ episodes: group, detectedAt }) => {
    for (const episode of group) contradictionByClaim.set(episode.id, group.filter(({ id }) => id !== episode.id));
    const claimIds = group.map(({ id }) => id).sort(); const evidenceIds = unique(group.flatMap(({ samples }) => samples.flatMap(({ evidenceIds: ids }) => ids)));
    const observationIds = unique(group.flatMap(({ samples }) => samples.flatMap(({ observationIds: ids }) => ids)));
    return {
      id: osintStableId("contra", { investigationId, subjectEntityId: group[0].entityId, predicate: group[0].predicate, detectedAt, claimIds }), subjectEntityId: group[0].entityId, predicate: group[0].predicate,
      claimIds, values: group.map(({ value }) => value), evidenceIds, observationIds, detectedAt,
      explanation: `${group.length} incompatible values were reported for ${group[0].predicate} at the same observation time. They remain explicit contested claims; no value was silently selected.`,
    };
  }).sort((left, right) => left.id.localeCompare(right.id));

  const claims: OsintClaim[] = []; const conclusions: OsintConclusion[] = [];
  for (const episode of episodes) {
    const conflicts = contradictionByClaim.get(episode.id) ?? [];
    const scored = scoreSamples(episode.samples, evidenceById, reliability); const contradictionPenalty = conflicts.length ? 0.55 : 1;
    const confidence = Math.min(0.99, scored.score * contradictionPenalty); const category = confidenceCategory(confidence);
    const evidenceIds = unique(episode.samples.flatMap(({ evidenceIds: ids }) => ids)); const observationIds = unique(episode.samples.flatMap(({ observationIds: ids }) => ids));
    const contradictingClaimIds = conflicts.map(({ id }) => id).sort(); const contradictingEvidenceIds = unique(conflicts.flatMap(({ samples }) => samples.flatMap(({ evidenceIds: ids }) => ids)));
    const freshness = freshnessSummary(episode.samples);
    const coverageLimitations = boundedUnique([...episode.samples.flatMap(({ coverageLimitations }) => coverageLimitations), ...(conflicts.length ? ["Contemporaneous evidence reports incompatible values; the conflict is unresolved."] : [])]);
    const sourceSummary = scored.sources.map(({ sourceFamily, weightedScore }) => `${sourceFamily}=${weightedScore.toFixed(3)}`).join(", ") || "none";
    const confidenceExplanation = `${category} (${confidence.toFixed(3)}): ${scored.sources.length} independent source famil${scored.sources.length === 1 ? "y" : "ies"} [${sourceSummary}] after provider reliability, directness, freshness, and cache-age weighting${conflicts.length ? `, then contradiction penalty ×${contradictionPenalty}` : ""}.`;
    const statement = `${episode.entityId} ${episode.predicate} ${stableJson(episode.value)}`;
    const explanation = [
      `Claim: ${statement}.`, `Support: ${evidenceIds.length} evidence record${evidenceIds.length === 1 ? "" : "s"} and ${observationIds.length} observation${observationIds.length === 1 ? "" : "s"}.`,
      `Contradiction: ${conflicts.length ? `${contradictingClaimIds.length} incompatible claim${contradictingClaimIds.length === 1 ? "" : "s"} cite ${contradictingEvidenceIds.length} evidence record${contradictingEvidenceIds.length === 1 ? "" : "s"}` : "none detected"}.`,
      `Freshness: ${freshness.category}${freshness.newestObservedAt ? `; newest observation ${freshness.newestObservedAt}` : ""}.`, `Confidence: ${confidenceExplanation}`,
      `Coverage: ${coverageLimitations.length ? coverageLimitations.join(" ") : "No provider established exhaustive coverage."}`,
    ].join(" ").slice(0, 2_000);
    claims.push(validateOsintContract("claim", {
      schemaVersion: OSINT_SCHEMA_VERSION, id: episode.id, investigationId, subjectEntityId: episode.entityId, predicate: episode.predicate, value: episode.value,
      validFrom: episode.validFrom, ...(episode.validTo ? { validTo: episode.validTo } : {}), status: episode.status, evidenceIds, observationIds, confidence, confidenceCategory: category, explanation,
    }));
    conclusions.push({
      claimId: episode.id, statement, supportingEvidenceIds: evidenceIds, supportingObservationIds: observationIds, contradictingClaimIds, contradictingEvidenceIds, freshness,
      confidence: { score: confidence, category, independentSourceCount: scored.sources.length, duplicateSourceCount: scored.duplicateSourceCount, contradictionPenalty, sources: scored.sources, explanation: confidenceExplanation },
      coverageLimitations,
    });
  }
  return { claims: claims.sort((left, right) => left.id.localeCompare(right.id)), conclusions: conclusions.sort((left, right) => left.claimId.localeCompare(right.claimId)), changes: attributes.changes.sort((left, right) => left.id.localeCompare(right.id)), contradictions };
}

function deduplicateLeads(leads: OsintLead[], idMap: Map<string, string>) {
  const grouped = new Map<string, OsintLead[]>();
  for (const lead of leads) {
    const entityId = idMap.get(lead.entityId) ?? lead.entityId; const key = `${lead.seed.type}:${lead.seed.value.trim().toLocaleLowerCase("en-US")}`;
    grouped.set(key, [...(grouped.get(key) ?? []), { ...lead, entityId }]);
  }
  const output = [...grouped.entries()].map(([key, members]) => validateOsintContract("lead", {
    ...members[0], id: osintStableId("lead", { investigationId: members[0].investigationId, key }), entityId: members[0].entityId,
    reason: unique(members.map(({ reason }) => reason)).join(" ").slice(0, 1000), status: "candidate", depth: Math.min(...members.map(({ depth }) => depth)),
    discoveredByEvidenceIds: unique(members.flatMap(({ discoveredByEvidenceIds }) => discoveredByEvidenceIds)), createdAt: members.map(({ createdAt }) => createdAt).sort()[0], updatedAt: members.map(({ updatedAt }) => updatedAt).sort().at(-1),
  })).sort((left, right) => left.id.localeCompare(right.id));
  return { leads: output, duplicateLeads: leads.length - output.length };
}

export function correlateOsintResults(input: OsintCorrelationInput): OsintCorrelationResult {
  const providerEntities = input.providerResults.flatMap(({ entities }) => entities); const seedEntities = input.seedRecords?.entities ?? [];
  const allEntities = [...seedEntities, ...providerEntities]; const deduplicated = deduplicateEntities(allEntities, input.investigationId);
  const evidenceInput = [...(input.seedRecords?.evidence ?? []), ...input.providerResults.flatMap(({ evidence }) => evidence)];
  const evidenceDeduplicated = deduplicateById(evidenceInput, "evidence"); const evidence = evidenceDeduplicated.values.sort((left, right) => left.id.localeCompare(right.id));
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const reliability = new Map(input.providers.map((provider) => [provider.id, provider.reliability])); reliability.set("hunter-seeker", 0.9);
  const observations = remapObservations([...(input.seedRecords?.observations ?? []), ...input.providerResults.flatMap(({ observations: values }) => values)], deduplicated.idMap).sort((left, right) => left.id.localeCompare(right.id));
  const relationships = deduplicateRelationships(input.providerResults.flatMap(({ relationships: values }) => values), deduplicated.idMap, evidenceById, reliability);
  const leadResult = deduplicateLeads(input.providerResults.flatMap(({ leads }) => leads), deduplicated.idMap);
  const claimResult = createClaimsAndAnalysis(input.investigationId, observations, relationships, evidenceById, reliability);
  const entityIds = new Set(deduplicated.entities.map(({ id }) => id)); const evidenceIds = new Set(evidence.map(({ id }) => id));
  for (const observation of observations) if (!entityIds.has(observation.entityId) || observation.evidenceIds.some((id) => !evidenceIds.has(id))) throw new Error(`Observation ${observation.id} has an unresolved correlation reference.`);
  for (const relationship of relationships) if (!entityIds.has(relationship.sourceEntityId) || !entityIds.has(relationship.targetEntityId) || relationship.evidenceIds.some((id) => !evidenceIds.has(id))) throw new Error(`Relationship ${relationship.id} has an unresolved correlation reference.`);
  return {
    entities: deduplicated.entities, evidence, observations, claims: claimResult.claims, conclusions: claimResult.conclusions, relationships, leads: leadResult.leads,
    identityLinks: deduplicated.identityLinks, resolutionCandidates: deduplicated.resolutionCandidates, changes: claimResult.changes, contradictions: claimResult.contradictions,
    deduplication: { inputEntities: allEntities.length, outputEntities: deduplicated.entities.length, mergedEntities: allEntities.length - deduplicated.entities.length, duplicateEvidence: evidenceDeduplicated.duplicates, duplicateLeads: leadResult.duplicateLeads },
  };
}
