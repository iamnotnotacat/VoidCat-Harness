/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import type { HunterSeekerPublicObservation } from "../hunter-seeker/hunter-seeker-service.ts";
import { DEFAULT_INVESTIGATION_BUDGET, validateInvestigationSeed, validateOsintContract, type InvestigationSeed, type OsintLead } from "./contracts.ts";
import { HunterSeekerIntakeAdapter, type HunterSeekerIntakeResult, type HunterSeekerRegionSeed } from "./hunter-seeker-intake.ts";
import { osintStableId } from "./provider-contracts.ts";

export type HunterOsintSeedKind = "aircraft" | "vessel" | "satellite" | "seismic" | "weather" | "geographic" | "object";

export type HunterOsintInvestigationDraft = {
  version: "1.0.0";
  id: string;
  status: "draft-awaiting-provider-selection";
  seedKind: HunterOsintSeedKind;
  seed: InvestigationSeed;
  objective: string;
  authorizationMode: "public-research";
  budget: typeof DEFAULT_INVESTIGATION_BUDGET;
  requestedAt: string;
  requestedBy: { kind: "operator" | "hunter-seeker"; id: string };
  originalHunterObservation?: {
    observationId: string;
    entityId: string;
    entityType: string;
    timestamp: string;
    provenance: HunterSeekerPublicObservation["provenance"];
  };
  region?: HunterSeekerRegionSeed;
  intake?: HunterSeekerIntakeResult;
  execution: {
    automatic: false;
    providerRequestsCreated: false;
    watchlistsCreated: false;
    triggerRulesCreated: false;
  };
};

export type OsintHunterCandidateSubmission = {
  version: "1.0.0";
  id: string;
  status: "candidate";
  sourceInvestigationId: string;
  providerId: string;
  lead: OsintLead;
  submittedAt: string;
  submittedBy: { kind: "operator" | "hunter-seeker"; id: string };
  hunterActions: {
    automatic: false;
    watchlistCreated: false;
    triggerRuleCreated: false;
    providerRequestCreated: false;
    protectedHistoryCreated: false;
  };
  allowedNextActions: ["review", "dismiss", "explicit-watchlist-request", "explicit-osint-approval"];
};

function validTimestamp(value: string, label: string) { if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp.`); }
function actor(value: { kind: "operator" | "hunter-seeker"; id: string }) {
  const id = value.id.trim(); if (!id || id.length > 160 || !["operator", "hunter-seeker"].includes(value.kind)) throw new Error("Hunter/OSINT handoff requires an explicit bounded actor.");
  return { kind: value.kind, id };
}

function observationSeedKind(observation: HunterSeekerPublicObservation): HunterOsintSeedKind {
  const type = observation.entityType.toLocaleLowerCase("en-US"); const source = observation.provenance.sourceFeedId.toLocaleLowerCase("en-US");
  if (type.includes("aircraft")) return "aircraft";
  if (type.includes("vessel") || type.includes("maritime") || type.includes("ship")) return "vessel";
  if (type.includes("satellite") || type.includes("space-station") || type.includes("orbital")) return "satellite";
  if (type.includes("earthquake") || type.includes("seismic") || source.includes("usgs")) return "seismic";
  if (type.includes("weather") || type.includes("alert") || source.includes("weather") || source.includes("nws")) return "weather";
  return "object";
}

export function hunterRegionAroundPoint(latitude: number, longitude: number, radiusKm = 25): HunterSeekerRegionSeed {
  if (![latitude, longitude, radiusKm].every(Number.isFinite) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 || radiusKm < 1 || radiusKm > 2_000) throw new Error("Hunter-Seeker region center and radius are invalid.");
  const latitudeDelta = radiusKm / 111.32; const longitudeDelta = Math.min(180, radiusKm / Math.max(1, 111.32 * Math.cos(latitude * Math.PI / 180)));
  return { label: `${radiusKm.toFixed(0)} km region near ${latitude.toFixed(4)}, ${longitude.toFixed(4)}`, bounds: { west: Math.max(-180, longitude - longitudeDelta), south: Math.max(-90, latitude - latitudeDelta), east: Math.min(180, longitude + longitudeDelta), north: Math.min(90, latitude + latitudeDelta) } };
}

export function createHunterOsintInvestigationDraft(input: { observation: HunterSeekerPublicObservation } | { region: HunterSeekerRegionSeed }, context: { requestedAt: string; requestedBy: { kind: "operator" | "hunter-seeker"; id: string }; objective?: string }): HunterOsintInvestigationDraft {
  validTimestamp(context.requestedAt, "requestedAt"); const requestedBy = actor(context.requestedBy); const adapter = new HunterSeekerIntakeAdapter();
  const sourceIdentity = "observation" in input ? { observationId: input.observation.observationId, sourceFeedId: input.observation.provenance.sourceFeedId } : { region: input.region };
  const id = osintStableId("hunter-osint-draft", { sourceIdentity, requestedAt: context.requestedAt, requestedBy });
  const intake = "observation" in input ? adapter.adaptObservation(input.observation, { investigationId: id, receivedAt: context.requestedAt }) : undefined;
  const seed = validateInvestigationSeed("observation" in input ? intake!.seed : adapter.adaptRegion(input.region)); const seedKind = "observation" in input ? observationSeedKind(input.observation) : "geographic";
  const objective = (context.objective ?? `Investigate this Hunter-Seeker ${seedKind} seed using explicitly selected passive OSINT providers.`).trim();
  if (!objective || objective.length > 2_000) throw new Error("Hunter/OSINT investigation objective must contain between 1 and 2,000 characters.");
  return {
    version: "1.0.0", id, status: "draft-awaiting-provider-selection", seedKind, seed, objective, authorizationMode: "public-research", budget: { ...DEFAULT_INVESTIGATION_BUDGET }, requestedAt: context.requestedAt, requestedBy,
    ...(intake && "observation" in input ? { originalHunterObservation: { observationId: input.observation.observationId, entityId: input.observation.entityId, entityType: input.observation.entityType, timestamp: input.observation.timestamp, provenance: structuredClone(input.observation.provenance) }, intake } : {}),
    ...(input && "region" in input ? { region: structuredClone(input.region) } : {}),
    execution: { automatic: false, providerRequestsCreated: false, watchlistsCreated: false, triggerRulesCreated: false },
  };
}

export function submitOsintCandidateLeadToHunter(input: { investigationId: string; providerId: string; lead: OsintLead; submittedAt: string; submittedBy: { kind: "operator" | "hunter-seeker"; id: string } }): OsintHunterCandidateSubmission {
  const investigationId = input.investigationId.trim(); const providerId = input.providerId.trim(); const submittedBy = actor(input.submittedBy); validTimestamp(input.submittedAt, "submittedAt");
  if (!investigationId || investigationId.length > 160 || !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(providerId)) throw new Error("OSINT candidate handoff identifiers are invalid.");
  const lead = validateOsintContract("lead", input.lead);
  if (lead.investigationId !== investigationId || lead.status !== "candidate" || lead.depth !== 1) throw new Error("Only a depth-one candidate from the exact OSINT investigation can be submitted to Hunter-Seeker.");
  return {
    version: "1.0.0", id: osintStableId("hunter-candidate", { investigationId, providerId, leadId: lead.id, submittedAt: input.submittedAt }), status: "candidate", sourceInvestigationId: investigationId, providerId,
    lead: structuredClone(lead), submittedAt: input.submittedAt, submittedBy,
    hunterActions: { automatic: false, watchlistCreated: false, triggerRuleCreated: false, providerRequestCreated: false, protectedHistoryCreated: false },
    allowedNextActions: ["review", "dismiss", "explicit-watchlist-request", "explicit-osint-approval"],
  };
}

export class HunterOsintCandidateInbox {
  private readonly entries = new Map<string, OsintHunterCandidateSubmission>();
  private readonly maximumEntries: number;
  constructor(maximumEntries = 100) { if (!Number.isInteger(maximumEntries) || maximumEntries < 1 || maximumEntries > 1_000) throw new Error("Hunter OSINT candidate inbox limit must be between 1 and 1,000."); this.maximumEntries = maximumEntries; }
  submit(value: OsintHunterCandidateSubmission) {
    const candidate = structuredClone(value); if (candidate.status !== "candidate" || candidate.hunterActions.automatic || candidate.hunterActions.watchlistCreated || candidate.hunterActions.triggerRuleCreated || candidate.hunterActions.providerRequestCreated) throw new Error("Hunter inbox accepts candidate-only, side-effect-free handoffs.");
    this.entries.delete(candidate.id); this.entries.set(candidate.id, candidate); while (this.entries.size > this.maximumEntries) this.entries.delete(this.entries.keys().next().value as string); return structuredClone(candidate);
  }
  list() { return [...this.entries.values()].sort((left, right) => right.submittedAt.localeCompare(left.submittedAt) || left.id.localeCompare(right.id)).map((item) => structuredClone(item)); }
  dismiss(id: string) { return this.entries.delete(id); }
}
