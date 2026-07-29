/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import { createHash } from "node:crypto";
import {
  DEFAULT_INVESTIGATION_BUDGET,
  validateInvestigationBudget,
  validateInvestigationSeed,
  type InvestigationBudget,
  type InvestigationSeed,
  type OsintAuthorizationMode,
  type OsintJsonRecord,
} from "./contracts.ts";
import {
  OSINT_PROVIDER_CAPABILITIES,
  validateProviderDescriptor,
  type OsintProviderCapabilityId,
  type OsintProviderDescriptor,
  type OsintProviderQuery,
} from "./provider-contracts.ts";

export type OsintInvestigationRequest = {
  seed: InvestigationSeed;
  objective: string;
  authorizationMode: OsintAuthorizationMode;
  budget?: InvestigationBudget;
  requestedProviderIds?: string[];
  requestedCapabilityIds?: OsintProviderCapabilityId[];
  exposureConfirmation?: {
    confirmed: true;
    exactTarget: string;
    statement: string;
  };
};

export type OsintPolicyRuleResult = {
  ruleId: string;
  outcome: "allow" | "deny" | "require-confirmation" | "not-applicable";
  reason: string;
};

export type OsintPolicyDecision = {
  id: string;
  outcome: "allow" | "deny" | "require-confirmation";
  evaluatedAt: string;
  rules: OsintPolicyRuleResult[];
  effectiveBudget: InvestigationBudget;
  allowedProviderIds: string[];
  allowedCapabilityIds: OsintProviderCapabilityId[];
  deniedCapabilityIds: OsintProviderCapabilityId[];
  reasons: string[];
  requiresOperatorConfirmation: boolean;
};

export type OsintPlanStep = {
  id: string;
  order: number;
  providerId: string;
  capabilityId: OsintProviderCapabilityId;
  operation: string;
  purpose: string;
  dependsOn: string[];
  query: OsintProviderQuery;
  budgetReservation: {
    externalCalls: number;
    maximumEvidenceBytes: number;
    maximumEntities: number;
  };
  expansion: {
    depth: number;
    automatic: false;
    discoveredEntitiesBecome: "candidate-leads";
  };
};

export type DeterministicInvestigationPlan = {
  version: "1.0.0";
  id: string;
  policyDecisionId: string;
  seed: InvestigationSeed;
  objective: string;
  authorizationMode: OsintAuthorizationMode;
  budget: InvestigationBudget;
  steps: OsintPlanStep[];
  reservations: {
    providers: number;
    externalCalls: number;
    maximumEvidenceBytes: number;
    maximumEntities: number;
    maximumDiscoveryDepth: number;
  };
  execution: {
    ordering: "sequential-deterministic";
    stopOnBudgetExhaustion: true;
    followCandidateLeadsAutomatically: false;
  };
  createdAt: string;
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

function stableId(prefix: string, value: unknown) {
  return `${prefix}_${createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 24)}`;
}

function validateRequest(request: OsintInvestigationRequest) {
  validateInvestigationSeed(request.seed);
  const objective = request.objective.trim();
  if (!objective || objective.length > 2_000) throw new Error("Investigation objective must contain between 1 and 2,000 characters.");
  if (!["public-research", "owned-asset", "authorized-client", "exposure-check"].includes(request.authorizationMode)) throw new Error("Investigation authorization mode is invalid.");
  if (request.requestedProviderIds && (request.requestedProviderIds.length > 50 || request.requestedProviderIds.some((id) => !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(id)))) throw new Error("Requested provider identifiers are invalid.");
  if (request.requestedCapabilityIds?.some((id) => !OSINT_PROVIDER_CAPABILITIES.includes(id))) throw new Error("Requested provider capabilities are invalid.");
  return { ...request, objective, budget: validateInvestigationBudget(request.budget ?? DEFAULT_INVESTIGATION_BUDGET) };
}

function normalizeTarget(value: string) {
  return value.trim().toLocaleLowerCase("en-US");
}

function capabilityAllowed(capabilityId: OsintProviderCapabilityId, request: ReturnType<typeof validateRequest>) {
  if (capabilityId !== "authorized-exposure-check") return true;
  return request.authorizationMode === "exposure-check"
    && (request.seed.type === "email-address" || request.seed.type === "domain")
    && request.exposureConfirmation?.confirmed === true
    && normalizeTarget(request.exposureConfirmation.exactTarget) === normalizeTarget(request.seed.value)
    && request.exposureConfirmation.statement.trim().length >= 12;
}

export function evaluateOsintPolicy(requestValue: OsintInvestigationRequest, providerValues: readonly OsintProviderDescriptor[], evaluatedAt: string): OsintPolicyDecision {
  const request = validateRequest(requestValue);
  if (!Number.isFinite(Date.parse(evaluatedAt))) throw new Error("Policy evaluation time must be an ISO timestamp.");
  const providers = providerValues.map(validateProviderDescriptor).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(providers.map(({ id }) => id)).size !== providers.length) throw new Error("Provider identifiers must be unique.");
  const rules: OsintPolicyRuleResult[] = [
    { ruleId: "passive-only", outcome: "allow", reason: "Every registered provider declares the enforced passive-only contract." },
    { ruleId: "bounded-budget", outcome: "allow", reason: "The requested budget is within the application hard limits." },
    { ruleId: "controlled-expansion", outcome: "allow", reason: "Discovered entities remain candidate leads and are not followed automatically." },
  ];

  const requestedProviders = request.requestedProviderIds ? new Set(request.requestedProviderIds) : null;
  const requestedCapabilities = request.requestedCapabilityIds ? new Set(request.requestedCapabilityIds) : null;
  const allowedCapabilities = new Set<OsintProviderCapabilityId>();
  const deniedCapabilities = new Set<OsintProviderCapabilityId>();
  const providerCandidates: Array<{ provider: OsintProviderDescriptor; capabilities: OsintProviderCapabilityId[] }> = [];

  for (const provider of providers) {
    if (requestedProviders && !requestedProviders.has(provider.id)) continue;
    const supported = provider.capabilities.filter((capability) => capability.seedTypes.includes(request.seed.type)
      && capability.authorizationModes.includes(request.authorizationMode)
      && (!requestedCapabilities || requestedCapabilities.has(capability.id)));
    const permitted = supported.filter((capability) => capabilityAllowed(capability.id, request));
    supported.filter((capability) => !permitted.includes(capability)).forEach(({ id }) => deniedCapabilities.add(id));
    if (permitted.length) providerCandidates.push({ provider, capabilities: permitted.map(({ id }) => id).sort() });
  }

  const exposureRequested = request.authorizationMode === "exposure-check" || requestedCapabilities?.has("authorized-exposure-check") === true;
  const exposureConfirmed = capabilityAllowed("authorized-exposure-check", request);
  if (exposureRequested && !exposureConfirmed) {
    rules.push({ ruleId: "exact-exposure-authorization", outcome: "require-confirmation", reason: "Exposure checks require an email or domain seed and a fresh exact-target authorization statement." });
  } else {
    rules.push({ ruleId: "exact-exposure-authorization", outcome: exposureRequested ? "allow" : "not-applicable", reason: exposureRequested ? "The exact exposure target is explicitly confirmed." : "No exposure capability was requested." });
  }

  const selectedProviders = providerCandidates.slice(0, request.budget.maximumProviders);
  selectedProviders.forEach(({ capabilities }) => capabilities.forEach((capability) => allowedCapabilities.add(capability)));
  const unknownRequestedProviders = request.requestedProviderIds?.filter((id) => !providers.some((provider) => provider.id === id)) ?? [];
  if (unknownRequestedProviders.length) rules.push({ ruleId: "registered-providers-only", outcome: "deny", reason: `Unregistered providers were requested: ${unknownRequestedProviders.join(", ")}.` });
  else rules.push({ ruleId: "registered-providers-only", outcome: "allow", reason: "The plan may use only registered provider descriptors." });

  let outcome: OsintPolicyDecision["outcome"] = "allow";
  if (unknownRequestedProviders.length || (!selectedProviders.length && (!exposureRequested || exposureConfirmed))) outcome = "deny";
  else if (exposureRequested && !exposureConfirmed) outcome = "require-confirmation";
  const reasons = rules.filter((rule) => rule.outcome === "deny" || rule.outcome === "require-confirmation").map(({ reason }) => reason);
  if (!selectedProviders.length && !reasons.length) reasons.push("No registered provider supports this seed and authorization mode.");

  const decisionCore = {
    outcome, effectiveBudget: request.budget, allowedProviderIds: selectedProviders.map(({ provider }) => provider.id),
    allowedCapabilityIds: [...allowedCapabilities].sort(), deniedCapabilityIds: [...deniedCapabilities].sort(), rules,
  };
  return {
    id: stableId("policy", decisionCore), ...decisionCore, evaluatedAt, reasons,
    requiresOperatorConfirmation: outcome === "require-confirmation",
  };
}

function queryParameters(seed: InvestigationSeed): OsintJsonRecord {
  return { seedType: seed.type, seedValue: seed.value, sourceKind: seed.source.kind };
}

export function buildDeterministicInvestigationPlan(
  requestValue: OsintInvestigationRequest,
  providerValues: readonly OsintProviderDescriptor[],
  decision: OsintPolicyDecision,
  createdAt: string,
): DeterministicInvestigationPlan {
  const request = validateRequest(requestValue);
  const verifiedDecision = evaluateOsintPolicy(requestValue, providerValues, decision.evaluatedAt);
  if (verifiedDecision.id !== decision.id || stableJson(verifiedDecision) !== stableJson(decision)) throw new Error("The supplied OSINT policy decision does not match the request and registered providers.");
  if (verifiedDecision.outcome !== "allow") throw new Error(`Policy decision ${verifiedDecision.id} does not permit an investigation plan.`);
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error("Plan creation time must be an ISO timestamp.");
  const providers = providerValues.map(validateProviderDescriptor).filter(({ id }) => verifiedDecision.allowedProviderIds.includes(id)).sort((left, right) => left.id.localeCompare(right.id));
  const candidates = providers.flatMap((provider) => provider.capabilities
    .filter((capability) => verifiedDecision.allowedCapabilityIds.includes(capability.id) && capability.seedTypes.includes(request.seed.type) && capability.authorizationModes.includes(request.authorizationMode))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((capability) => ({ provider, capability })));
  const maximumViableSteps = Math.min(verifiedDecision.effectiveBudget.maximumExternalCalls, verifiedDecision.effectiveBudget.maximumEvidenceBytes, verifiedDecision.effectiveBudget.maximumEntities);
  const limited = candidates.slice(0, maximumViableSteps);
  const perStepEvidence = limited.length ? Math.floor(verifiedDecision.effectiveBudget.maximumEvidenceBytes / limited.length) : 0;
  const perStepEntities = limited.length ? Math.max(1, Math.floor(verifiedDecision.effectiveBudget.maximumEntities / limited.length)) : 0;
  const steps: OsintPlanStep[] = limited.map(({ provider, capability }, index) => {
    const queryCore = { providerId: provider.id, capabilityId: capability.id, seed: request.seed, objective: request.objective };
    const query: OsintProviderQuery = {
      id: stableId("query", queryCore), providerId: provider.id, capabilityId: capability.id, operation: capability.id,
      seed: structuredClone(request.seed), parameters: queryParameters(request.seed), purpose: request.objective,
      cacheKey: stableId("cache", { providerId: provider.id, capabilityId: capability.id, seed: request.seed }), estimatedExternalCalls: 1,
      maximumResponseBytes: Math.max(1, perStepEvidence),
    };
    const id = stableId("step", queryCore);
    return {
      id, order: index + 1, providerId: provider.id, capabilityId: capability.id, operation: capability.id, purpose: request.objective,
      dependsOn: [], query, budgetReservation: { externalCalls: 1, maximumEvidenceBytes: Math.max(1, perStepEvidence), maximumEntities: perStepEntities },
      expansion: { depth: 0, automatic: false, discoveredEntitiesBecome: "candidate-leads" },
    };
  });
  const planCore = { policyDecisionId: verifiedDecision.id, seed: request.seed, objective: request.objective, authorizationMode: request.authorizationMode, budget: verifiedDecision.effectiveBudget, steps };
  return {
    version: "1.0.0", id: stableId("plan", planCore), ...planCore,
    reservations: { providers: new Set(steps.map(({ providerId }) => providerId)).size, externalCalls: steps.length, maximumEvidenceBytes: steps.reduce((total, step) => total + step.budgetReservation.maximumEvidenceBytes, 0), maximumEntities: steps.reduce((total, step) => total + step.budgetReservation.maximumEntities, 0), maximumDiscoveryDepth: verifiedDecision.effectiveBudget.maximumDiscoveryDepth },
    execution: { ordering: "sequential-deterministic", stopOnBudgetExhaustion: true, followCandidateLeadsAutomatically: false }, createdAt,
  };
}

export function validateDeterministicPlan(plan: DeterministicInvestigationPlan) {
  validateInvestigationSeed(plan.seed); validateInvestigationBudget(plan.budget);
  const issues: string[] = [];
  if (plan.version !== "1.0.0") issues.push("unsupported plan version");
  if (!plan.objective.trim()) issues.push("objective is required");
  if (plan.steps.length > plan.budget.maximumExternalCalls) issues.push("steps exceed external-call budget");
  if (new Set(plan.steps.map(({ providerId }) => providerId)).size > plan.budget.maximumProviders) issues.push("steps exceed provider budget");
  if (plan.reservations.maximumEvidenceBytes > plan.budget.maximumEvidenceBytes) issues.push("evidence reservation exceeds budget");
  if (plan.reservations.maximumEntities > plan.budget.maximumEntities) issues.push("entity reservation exceeds budget");
  if (plan.steps.some((step, index) => step.order !== index + 1 || step.expansion.automatic !== false || step.expansion.discoveredEntitiesBecome !== "candidate-leads")) issues.push("steps are not deterministically ordered or controlled");
  if (issues.length) throw new Error(`Invalid deterministic OSINT plan: ${issues.join("; ")}.`);
  return structuredClone(plan);
}
