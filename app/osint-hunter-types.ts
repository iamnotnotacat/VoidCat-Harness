/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
export type HunterOsintDraft = {
  id: string;
  status: "draft-awaiting-provider-selection";
  seedKind: "aircraft" | "vessel" | "satellite" | "seismic" | "weather" | "geographic" | "object";
  seed: { type: string; value: string; label?: string; source: { kind: string; id: string; observationId?: string } };
  objective: string;
  requestedAt: string;
  originalHunterObservation?: {
    observationId: string;
    entityId: string;
    entityType: string;
    timestamp: string;
    provenance: { sourceFeedId: string; fetchedAt: string; receivedAt: string; upstreamTimestamp?: string; stalenessMs: number };
  };
  region?: { label: string; bounds: { west: number; south: number; east: number; north: number } };
  execution: { automatic: false; providerRequestsCreated: false; watchlistsCreated: false; triggerRulesCreated: false };
};

export type HunterOsintCandidate = {
  id: string;
  status: "candidate";
  sourceInvestigationId: string;
  providerId: string;
  submittedAt: string;
  lead: { id: string; reason: string; seed: { type: string; value: string; label?: string }; discoveredByEvidenceIds: string[] };
  hunterActions: { automatic: false; watchlistCreated: false; triggerRuleCreated: false; providerRequestCreated: false; protectedHistoryCreated: false };
};
