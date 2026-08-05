/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */

type Entity = { id: string; type: string; displayName: string; identifiers: unknown[] };
type Claim = { id: string; subjectEntityId: string; predicate: string; value: unknown; status: string; confidence: number; confidenceCategory: string; evidenceIds: string[] };
type Relationship = { id: string; sourceEntityId: string; targetEntityId: string; type: string; status: string; confidence: number; confidenceCategory: string; evidenceIds: string[] };
export type TemporalInvestigationView = { investigation: { id: string; createdAt: string; updatedAt: string; seed: { type: string; value: string } }; entities: Entity[]; claims: Claim[]; relationships: Relationship[]; evidence: Array<{ id: string; providerId: string }> };

export type TemporalChange = {
  id: string;
  kind: "entity-added" | "entity-removed" | "claim-added" | "claim-removed" | "claim-changed" | "relationship-added" | "relationship-removed" | "confidence-changed";
  subject: string;
  predicate?: string;
  before?: unknown;
  after?: unknown;
  confidenceBefore?: number;
  confidenceAfter?: number;
  baselineEvidenceIds: string[];
  currentEvidenceIds: string[];
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function entityKeys(entity: Entity) {
  const identifiers = entity.identifiers.filter((item): item is { type: string; normalizedValue: string } => Boolean(item) && typeof item === "object" && typeof (item as { type?: unknown }).type === "string" && typeof (item as { normalizedValue?: unknown }).normalizedValue === "string").map((item) => `${entity.type}|${item.type}|${item.normalizedValue.toLowerCase()}`);
  return identifiers.length ? identifiers.sort() : [`${entity.type}|name|${entity.displayName.trim().toLowerCase()}`];
}

function entityIndex(views: readonly TemporalInvestigationView[]) {
  const alias = new Map<string, string>();
  for (const view of views) for (const entity of view.entities) {
    const keys = entityKeys(entity); const existing = keys.map((key) => alias.get(key)).find(Boolean); const identity = existing ?? keys[0];
    for (const key of keys) alias.set(key, identity);
    alias.set(entity.id, identity);
  }
  return alias;
}

function changeId(kind: string, key: string) {
  let hash = 2166136261;
  for (const character of `${kind}|${key}`) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return `delta-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function compareInvestigations(baseline: TemporalInvestigationView, current: TemporalInvestigationView) {
  if (baseline.investigation.id === current.investigation.id) throw new Error("Choose two different investigations to compare.");
  const identities = entityIndex([baseline, current]); const entityName = new Map([...baseline.entities, ...current.entities].map((entity) => [identities.get(entity.id) ?? entity.id, entity.displayName]));
  const changes: TemporalChange[] = [];
  const baselineEntities = new Set(baseline.entities.map((entity) => identities.get(entity.id) ?? entity.id)); const currentEntities = new Set(current.entities.map((entity) => identities.get(entity.id) ?? entity.id));
  for (const identity of currentEntities) if (!baselineEntities.has(identity)) changes.push({ id: changeId("entity-added", identity), kind: "entity-added", subject: entityName.get(identity) ?? identity, baselineEvidenceIds: [], currentEvidenceIds: current.claims.filter((claim) => (identities.get(claim.subjectEntityId) ?? claim.subjectEntityId) === identity).flatMap((claim) => claim.evidenceIds) });
  for (const identity of baselineEntities) if (!currentEntities.has(identity)) changes.push({ id: changeId("entity-removed", identity), kind: "entity-removed", subject: entityName.get(identity) ?? identity, baselineEvidenceIds: baseline.claims.filter((claim) => (identities.get(claim.subjectEntityId) ?? claim.subjectEntityId) === identity).flatMap((claim) => claim.evidenceIds), currentEvidenceIds: [] });
  const claimMap = (view: TemporalInvestigationView) => new Map(view.claims.map((claim) => [`${identities.get(claim.subjectEntityId) ?? claim.subjectEntityId}|${claim.predicate}`, claim]));
  const baselineClaims = claimMap(baseline); const currentClaims = claimMap(current);
  for (const [key, claim] of currentClaims) {
    const previous = baselineClaims.get(key); const identity = identities.get(claim.subjectEntityId) ?? claim.subjectEntityId; const subject = entityName.get(identity) ?? identity;
    if (!previous) changes.push({ id: changeId("claim-added", key), kind: "claim-added", subject, predicate: claim.predicate, after: claim.value, confidenceAfter: claim.confidence, baselineEvidenceIds: [], currentEvidenceIds: claim.evidenceIds });
    else if (canonical(previous.value) !== canonical(claim.value) || previous.status !== claim.status) changes.push({ id: changeId("claim-changed", key), kind: "claim-changed", subject, predicate: claim.predicate, before: previous.value, after: claim.value, confidenceBefore: previous.confidence, confidenceAfter: claim.confidence, baselineEvidenceIds: previous.evidenceIds, currentEvidenceIds: claim.evidenceIds });
    else if (Math.abs(previous.confidence - claim.confidence) >= 0.05 || previous.confidenceCategory !== claim.confidenceCategory) changes.push({ id: changeId("confidence-changed", key), kind: "confidence-changed", subject, predicate: claim.predicate, before: previous.confidenceCategory, after: claim.confidenceCategory, confidenceBefore: previous.confidence, confidenceAfter: claim.confidence, baselineEvidenceIds: previous.evidenceIds, currentEvidenceIds: claim.evidenceIds });
  }
  for (const [key, claim] of baselineClaims) if (!currentClaims.has(key)) { const identity = identities.get(claim.subjectEntityId) ?? claim.subjectEntityId; changes.push({ id: changeId("claim-removed", key), kind: "claim-removed", subject: entityName.get(identity) ?? identity, predicate: claim.predicate, before: claim.value, confidenceBefore: claim.confidence, baselineEvidenceIds: claim.evidenceIds, currentEvidenceIds: [] }); }
  const relationshipMap = (view: TemporalInvestigationView) => new Map(view.relationships.map((item) => [`${identities.get(item.sourceEntityId) ?? item.sourceEntityId}|${item.type}|${identities.get(item.targetEntityId) ?? item.targetEntityId}`, item]));
  const baselineRelationships = relationshipMap(baseline); const currentRelationships = relationshipMap(current);
  for (const [key, relationship] of currentRelationships) if (!baselineRelationships.has(key)) changes.push({ id: changeId("relationship-added", key), kind: "relationship-added", subject: key.replaceAll("|", " → "), after: relationship.status, confidenceAfter: relationship.confidence, baselineEvidenceIds: [], currentEvidenceIds: relationship.evidenceIds });
  for (const [key, relationship] of baselineRelationships) if (!currentRelationships.has(key)) changes.push({ id: changeId("relationship-removed", key), kind: "relationship-removed", subject: key.replaceAll("|", " → "), before: relationship.status, confidenceBefore: relationship.confidence, baselineEvidenceIds: relationship.evidenceIds, currentEvidenceIds: [] });
  const baselineProviders = new Set(baseline.evidence.map((item) => item.providerId)); const currentProviders = new Set(current.evidence.map((item) => item.providerId));
  return { generatedAt: new Date().toISOString(), baseline: { id: baseline.investigation.id, at: baseline.investigation.updatedAt }, current: { id: current.investigation.id, at: current.investigation.updatedAt }, sameSeed: baseline.investigation.seed.type === current.investigation.seed.type && baseline.investigation.seed.value.toLowerCase() === current.investigation.seed.value.toLowerCase(), summary: { total: changes.length, added: changes.filter((item) => item.kind.endsWith("added")).length, removed: changes.filter((item) => item.kind.endsWith("removed")).length, changed: changes.filter((item) => item.kind.includes("changed")).length, providersAdded: [...currentProviders].filter((id) => !baselineProviders.has(id)), providersRemoved: [...baselineProviders].filter((id) => !currentProviders.has(id)) }, changes };
}
