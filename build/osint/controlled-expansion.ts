/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import {
  validateInvestigationBudget,
  validateInvestigationSeed,
  validateOsintContract,
  type InvestigationBudget,
  type InvestigationSeed,
  type OsintAuthorizationMode,
  type OsintInvestigation,
  type OsintLead,
} from "./contracts.ts";
import { normalizeIdentifierValue, osintStableId, validateProviderDescriptor, type OsintProviderCapabilityId, type OsintProviderDescriptor } from "./provider-contracts.ts";

export const GATE6_MAXIMUM_DISCOVERY_DEPTH = 1;
export const GATE6_DEFAULT_MAXIMUM_FAN_OUT = 10;
export const GATE6_HARD_MAXIMUM_FAN_OUT = 25;
export const GATE6_EVIDENCE_RESERVATION_BYTES = 64 * 1024;
export const GATE6_RUNTIME_RESERVATION_MS = 10_000;

export type OsintExpansionUsage = {
  providerIds: string[];
  externalCalls: number;
  runtimeMs: number;
  entities: number;
  evidenceBytes: number;
};

export type OsintInvestigatedSeed = { investigationId: string; seed: InvestigationSeed };

export type OsintExpansionSuppressionReason =
  | "not-a-candidate"
  | "depth-limit"
  | "duplicate-candidate"
  | "already-investigated"
  | "cycle-detected"
  | "no-passive-provider"
  | "provider-budget-exhausted"
  | "external-call-budget-exhausted"
  | "runtime-budget-exhausted"
  | "entity-budget-exhausted"
  | "evidence-budget-exhausted"
  | "fan-out-limit";

export type OsintExpansionReservation = {
  providerId: string;
  capabilityId: OsintProviderCapabilityId;
  newProviderSlots: number;
  externalCalls: 1;
  runtimeMs: number;
  entities: 1;
  evidenceBytes: number;
};

export type OsintExpansionSuggestion = {
  id: string;
  investigationId: string;
  lead: OsintLead;
  seedKey: string;
  status: "eligible" | "suppressed";
  suppressionReasons: OsintExpansionSuppressionReason[];
  reservation?: OsintExpansionReservation;
  automatic: false;
  requiresExplicitApproval: true;
};

export type OsintControlledExpansionEvaluation = {
  version: "1.0.0";
  id: string;
  investigationId: string;
  authorizationMode: OsintAuthorizationMode;
  maximumDepth: 1;
  maximumFanOut: number;
  candidateCount: number;
  eligibleCount: number;
  suppressedCount: number;
  usageAtEvaluation: OsintExpansionUsage;
  reservedBySuggestions: OsintExpansionUsage;
  remainingAfterSuggestions: {
    providerSlots: number;
    externalCalls: number;
    runtimeMs: number;
    entities: number;
    evidenceBytes: number;
  };
  suggestions: OsintExpansionSuggestion[];
  execution: {
    automatic: false;
    requiresExplicitApproval: true;
    approvedStepStillRequiresPolicyEvaluation: true;
  };
};

export type OsintExpansionApproval = {
  investigationId: string;
  evaluationId: string;
  suggestionId: string;
  leadId: string;
  actor: "operator" | "hunter-seeker";
  actorId: string;
  confirmed: true;
  statement: string;
  approvedAt: string;
};

export type OsintApprovedExpansion = {
  version: "1.0.0";
  id: string;
  status: "approved-not-submitted";
  approval: OsintExpansionApproval;
  lead: OsintLead;
  nextRequest: {
    seed: InvestigationSeed;
    objective: string;
    authorizationMode: Exclude<OsintAuthorizationMode, "exposure-check">;
    budget: InvestigationBudget;
    requestedProviderIds: [string];
    requestedCapabilityIds: [OsintProviderCapabilityId];
  };
  automatic: false;
  submitted: false;
};

export type OsintControlledExpansionInput = {
  investigation: OsintInvestigation;
  leads: OsintLead[];
  providers: readonly OsintProviderDescriptor[];
  usage?: Partial<OsintExpansionUsage>;
  ancestry?: InvestigationSeed[];
  investigated?: OsintInvestigatedSeed[];
  maximumFanOut?: number;
};

const SEED_IDENTIFIER_TYPES: Partial<Record<InvestigationSeed["type"], Parameters<typeof normalizeIdentifierValue>[0]>> = {
  domain: "domain", "ip-address": "ipv4", "email-address": "email", username: "username", organization: "organization-name", certificate: "certificate-sha256",
  "autonomous-system": "asn", url: "url", aircraft: "aircraft-icao", vessel: "vessel-mmsi", satellite: "satellite-norad", "geographic-area": "geographic-label",
};

function seedKey(seedValue: InvestigationSeed) {
  const seed = validateInvestigationSeed(seedValue); const identifierType = SEED_IDENTIFIER_TYPES[seed.type];
  const normalized = identifierType ? normalizeIdentifierValue(identifierType, seed.value) : seed.value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
  return `${seed.type}:${normalized}`;
}

function nonNegativeInteger(value: unknown, label: string) {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative integer.`);
  return Number(value);
}

function normalizedUsage(investigation: OsintInvestigation, value: Partial<OsintExpansionUsage> | undefined): OsintExpansionUsage {
  const providerIds = [...new Set((value?.providerIds ?? []).map((item) => item.trim()).filter(Boolean))].sort();
  if (providerIds.some((id) => !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(id))) throw new Error("Expansion usage contains an invalid provider identifier.");
  return {
    providerIds,
    externalCalls: nonNegativeInteger(value?.externalCalls ?? investigation.counts.externalCalls, "externalCalls"),
    runtimeMs: nonNegativeInteger(value?.runtimeMs ?? 0, "runtimeMs"),
    entities: nonNegativeInteger(value?.entities ?? investigation.counts.entities, "entities"),
    evidenceBytes: nonNegativeInteger(value?.evidenceBytes ?? investigation.counts.evidenceBytes, "evidenceBytes"),
  };
}

function addUsage(left: OsintExpansionUsage, right: OsintExpansionUsage): OsintExpansionUsage {
  return {
    providerIds: [...new Set([...left.providerIds, ...right.providerIds])].sort(), externalCalls: left.externalCalls + right.externalCalls,
    runtimeMs: left.runtimeMs + right.runtimeMs, entities: left.entities + right.entities, evidenceBytes: left.evidenceBytes + right.evidenceBytes,
  };
}

function remainingUsage(budget: InvestigationBudget, baselineProviderCount: number, reservedProviderCount: number, used: OsintExpansionUsage): OsintControlledExpansionEvaluation["remainingAfterSuggestions"] {
  return {
    providerSlots: Math.max(0, budget.maximumProviders - baselineProviderCount - reservedProviderCount),
    externalCalls: Math.max(0, budget.maximumExternalCalls - used.externalCalls), runtimeMs: Math.max(0, budget.maximumRuntimeMs - used.runtimeMs),
    entities: Math.max(0, budget.maximumEntities - used.entities), evidenceBytes: Math.max(0, budget.maximumEvidenceBytes - used.evidenceBytes),
  };
}

function supportedCapabilities(provider: OsintProviderDescriptor, seed: InvestigationSeed, mode: OsintAuthorizationMode) {
  return provider.capabilities.filter((capability) => !capability.sensitive && capability.id !== "authorized-exposure-check" && capability.seedTypes.includes(seed.type) && capability.authorizationModes.includes(mode)).sort((left, right) => left.id.localeCompare(right.id));
}

function suppressed(investigationId: string, lead: OsintLead, key: string, reasons: OsintExpansionSuppressionReason[]): OsintExpansionSuggestion {
  return {
    id: osintStableId("expansion", { investigationId, leadId: lead.id, key }), investigationId, lead, seedKey: key, status: "suppressed",
    suppressionReasons: [...new Set(reasons)], automatic: false, requiresExplicitApproval: true,
  };
}

export function evaluateControlledExpansion(input: OsintControlledExpansionInput): OsintControlledExpansionEvaluation {
  const investigation = validateOsintContract("investigation", input.investigation); const budget = validateInvestigationBudget(investigation.budget);
  const maximumFanOut = input.maximumFanOut ?? GATE6_DEFAULT_MAXIMUM_FAN_OUT;
  if (!Number.isInteger(maximumFanOut) || maximumFanOut < 1 || maximumFanOut > GATE6_HARD_MAXIMUM_FAN_OUT) throw new Error(`maximumFanOut must be between 1 and ${GATE6_HARD_MAXIMUM_FAN_OUT}.`);
  const providers = input.providers.map(validateProviderDescriptor).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(providers.map(({ id }) => id)).size !== providers.length) throw new Error("Expansion provider identifiers must be unique.");
  const usageAtEvaluation = normalizedUsage(investigation, input.usage);
  const baselineProviderCount = Math.max(investigation.counts.providers, usageAtEvaluation.providerIds.length);
  const ancestryKeys = new Set([...(input.ancestry ?? []), investigation.seed].map(seedKey));
  const investigatedKeys = new Set((input.investigated ?? []).map(({ seed }) => seedKey(seed)));
  const leads = input.leads.map((lead) => validateOsintContract("lead", lead)).sort((left, right) => seedKey(left.seed).localeCompare(seedKey(right.seed)) || left.id.localeCompare(right.id));
  const seenCandidates = new Set<string>(); const reservedProviders = new Set<string>(); let reservedExternalCalls = 0; let reservedRuntimeMs = 0; let reservedEntities = 0; let reservedEvidenceBytes = 0; let eligibleCount = 0;
  const suggestions: OsintExpansionSuggestion[] = [];

  for (const lead of leads) {
    if (lead.investigationId !== investigation.id) throw new Error(`Lead ${lead.id} does not belong to investigation ${investigation.id}.`);
    const key = seedKey(lead.seed); const reasons: OsintExpansionSuppressionReason[] = [];
    if (lead.status !== "candidate") reasons.push("not-a-candidate");
    if (lead.depth < 1 || lead.depth > Math.min(GATE6_MAXIMUM_DISCOVERY_DEPTH, budget.maximumDiscoveryDepth)) reasons.push("depth-limit");
    if (ancestryKeys.has(key)) reasons.push("cycle-detected");
    else if (investigatedKeys.has(key)) reasons.push("already-investigated");
    if (seenCandidates.has(key)) reasons.push("duplicate-candidate"); else seenCandidates.add(key);
    if (reasons.length) { suggestions.push(suppressed(investigation.id, lead, key, reasons)); continue; }

    const providerChoices = providers.flatMap((provider) => supportedCapabilities(provider, lead.seed, investigation.authorizationMode).map((capability) => ({ provider, capability }))).sort((left, right) => {
      const leftKnown = usageAtEvaluation.providerIds.includes(left.provider.id) || reservedProviders.has(left.provider.id); const rightKnown = usageAtEvaluation.providerIds.includes(right.provider.id) || reservedProviders.has(right.provider.id);
      return Number(rightKnown) - Number(leftKnown) || left.provider.id.localeCompare(right.provider.id) || left.capability.id.localeCompare(right.capability.id);
    });
    if (!providerChoices.length) { suggestions.push(suppressed(investigation.id, lead, key, ["no-passive-provider"])); continue; }
    if (eligibleCount >= maximumFanOut) { suggestions.push(suppressed(investigation.id, lead, key, ["fan-out-limit"])); continue; }

    const usedProviderCount = baselineProviderCount + reservedProviders.size; const providerChoice = providerChoices.find(({ provider }) => usageAtEvaluation.providerIds.includes(provider.id) || reservedProviders.has(provider.id) || usedProviderCount < budget.maximumProviders);
    if (!providerChoice) { suggestions.push(suppressed(investigation.id, lead, key, ["provider-budget-exhausted"])); continue; }
    const alreadyCountedProvider = usageAtEvaluation.providerIds.includes(providerChoice.provider.id) || reservedProviders.has(providerChoice.provider.id); const newProviderSlots = alreadyCountedProvider ? 0 : 1;
    const budgetReasons: OsintExpansionSuppressionReason[] = [];
    if (usageAtEvaluation.externalCalls + reservedExternalCalls + 1 > budget.maximumExternalCalls) budgetReasons.push("external-call-budget-exhausted");
    if (usageAtEvaluation.runtimeMs + reservedRuntimeMs + GATE6_RUNTIME_RESERVATION_MS > budget.maximumRuntimeMs) budgetReasons.push("runtime-budget-exhausted");
    if (usageAtEvaluation.entities + reservedEntities + 1 > budget.maximumEntities) budgetReasons.push("entity-budget-exhausted");
    if (usageAtEvaluation.evidenceBytes + reservedEvidenceBytes + GATE6_EVIDENCE_RESERVATION_BYTES > budget.maximumEvidenceBytes) budgetReasons.push("evidence-budget-exhausted");
    if (budgetReasons.length) { suggestions.push(suppressed(investigation.id, lead, key, budgetReasons)); continue; }

    if (newProviderSlots) reservedProviders.add(providerChoice.provider.id);
    reservedExternalCalls += 1; reservedRuntimeMs += GATE6_RUNTIME_RESERVATION_MS; reservedEntities += 1; reservedEvidenceBytes += GATE6_EVIDENCE_RESERVATION_BYTES; eligibleCount += 1;
    const reservation: OsintExpansionReservation = { providerId: providerChoice.provider.id, capabilityId: providerChoice.capability.id, newProviderSlots, externalCalls: 1, runtimeMs: GATE6_RUNTIME_RESERVATION_MS, entities: 1, evidenceBytes: GATE6_EVIDENCE_RESERVATION_BYTES };
    suggestions.push({
      id: osintStableId("expansion", { investigationId: investigation.id, leadId: lead.id, key, reservation }), investigationId: investigation.id, lead, seedKey: key,
      status: "eligible", suppressionReasons: [], reservation, automatic: false, requiresExplicitApproval: true,
    });
  }

  const reservedBySuggestions: OsintExpansionUsage = { providerIds: [...reservedProviders].sort(), externalCalls: reservedExternalCalls, runtimeMs: reservedRuntimeMs, entities: reservedEntities, evidenceBytes: reservedEvidenceBytes };
  const totalUsage = addUsage(usageAtEvaluation, reservedBySuggestions); const remainingAfterSuggestions = remainingUsage(budget, baselineProviderCount, reservedProviders.size, totalUsage);
  const core = { investigationId: investigation.id, authorizationMode: investigation.authorizationMode, maximumDepth: GATE6_MAXIMUM_DISCOVERY_DEPTH, maximumFanOut, usageAtEvaluation, reservedBySuggestions, suggestions };
  return {
    version: "1.0.0", id: osintStableId("expansion-evaluation", core), investigationId: investigation.id, authorizationMode: investigation.authorizationMode, maximumDepth: GATE6_MAXIMUM_DISCOVERY_DEPTH, maximumFanOut,
    candidateCount: leads.length, eligibleCount, suppressedCount: leads.length - eligibleCount, usageAtEvaluation, reservedBySuggestions, remainingAfterSuggestions, suggestions,
    execution: { automatic: false, requiresExplicitApproval: true, approvedStepStillRequiresPolicyEvaluation: true },
  };
}

export function approveControlledExpansion(evaluation: OsintControlledExpansionEvaluation, approvalValue: OsintExpansionApproval, objective?: string): OsintApprovedExpansion {
  const approval = structuredClone(approvalValue); const statement = approval.statement.trim(); const actorId = approval.actorId.trim();
  if (approval.investigationId !== evaluation.investigationId || approval.evaluationId !== evaluation.id) throw new Error("Expansion approval does not match the evaluated investigation.");
  if (!approval.confirmed || !["operator", "hunter-seeker"].includes(approval.actor) || !actorId || actorId.length > 160 || statement.length < 12 || statement.length > 1_000 || !Number.isFinite(Date.parse(approval.approvedAt))) throw new Error("Expansion approval requires an explicit actor, confirmation statement, and valid timestamp.");
  const suggestion = evaluation.suggestions.find(({ id }) => id === approval.suggestionId);
  if (!suggestion || suggestion.lead.id !== approval.leadId) throw new Error("Expansion approval does not identify an evaluated candidate lead.");
  if (suggestion.status !== "eligible" || !suggestion.reservation) throw new Error("A suppressed candidate cannot be approved for expansion.");
  if (evaluation.authorizationMode === "exposure-check") throw new Error("Exposure checks require a new exact-target authorization and cannot use ordinary candidate expansion approval.");
  const nextObjective = (objective ?? `Perform one explicitly approved passive follow-up for ${suggestion.lead.seed.type} ${suggestion.lead.seed.value}.`).trim();
  if (!nextObjective || nextObjective.length > 2_000) throw new Error("Approved expansion objective must contain between 1 and 2,000 characters.");
  const seed = validateInvestigationSeed({ ...suggestion.lead.seed, source: { kind: "candidate-lead", id: suggestion.lead.id } });
  const budget = validateInvestigationBudget({ maximumProviders: 1, maximumExternalCalls: 1, maximumRuntimeMs: suggestion.reservation.runtimeMs, maximumEntities: 1, maximumEvidenceBytes: suggestion.reservation.evidenceBytes, maximumDiscoveryDepth: 0 });
  const normalizedApproval = { ...approval, actorId, statement };
  return {
    version: "1.0.0", id: osintStableId("expansion-approval", { evaluationId: evaluation.id, suggestionId: suggestion.id, actor: approval.actor, actorId, approvedAt: approval.approvedAt }),
    status: "approved-not-submitted", approval: normalizedApproval, lead: validateOsintContract("lead", { ...suggestion.lead, status: "approved", updatedAt: approval.approvedAt }),
    nextRequest: { seed, objective: nextObjective, authorizationMode: evaluation.authorizationMode, budget, requestedProviderIds: [suggestion.reservation.providerId], requestedCapabilityIds: [suggestion.reservation.capabilityId] },
    automatic: false, submitted: false,
  };
}

export function controlledExpansionSeedKey(seed: InvestigationSeed) { return seedKey(seed); }
