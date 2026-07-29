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
