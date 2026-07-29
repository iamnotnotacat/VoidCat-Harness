import type { HunterSeekerPublicObservation } from "../hunter-seeker/hunter-seeker-service.ts";
import { VoidCatJobManager, voidcatJobManager, type ManagedJobHandle } from "../voidcat-job-manager.ts";
import {
  OSINT_SCHEMA_VERSION,
  validateInvestigationBudget,
  validateInvestigationSeed,
  validateOsintContract,
  type InvestigationBudget,
  type InvestigationSeed,
  type OsintAuthorizationMode,
  type OsintClaim,
  type OsintEvidence,
  type OsintInvestigation,
  type OsintLead,
  type OsintRelationship,
} from "./contracts.ts";
import { correlateOsintResults, type OsintConclusion, type OsintCorrelationResult } from "./correlation-and-confidence.ts";
import { evaluateControlledExpansion, type OsintControlledExpansionEvaluation } from "./controlled-expansion.ts";
import { HunterSeekerIntakeAdapter, type HunterSeekerIntakeResult } from "./hunter-seeker-intake.ts";
import { MockProviderExecutor, MOCK_INVESTIGATION_BUDGET } from "./mock-providers.ts";
import { buildDeterministicInvestigationPlan, evaluateOsintPolicy, type DeterministicInvestigationPlan, type OsintPolicyDecision } from "./policy-and-planner.ts";
import { normalizeProviderResult, osintStableId, type NormalizedOsintProviderResult } from "./provider-contracts.ts";

export type MockInvestigationInput = {
  objective: string;
  authorizationMode?: Exclude<OsintAuthorizationMode, "exposure-check">;
  budget?: InvestigationBudget;
} & ({
  kind: "domain";
  domain: string;
} | {
  kind: "hunter-observation";
  observation: HunterSeekerPublicObservation;
});

export type OsintReportFinding = {
  claimId: string;
  subjectEntityId: string;
  subject: string;
  predicate: string;
  value: string;
  status: OsintClaim["status"];
  confidence: number;
  confidenceCategory: OsintClaim["confidenceCategory"];
  evidenceIds: string[];
  observationIds: string[];
  explanation: string;
  conclusion: OsintConclusion;
};

export type OsintInvestigationReport = {
  version: "1.1.0";
  id: string;
  investigationId: string;
  title: string;
  generatedAt: string;
  evidenceMode: "deterministic-offline-fixtures" | "live-passive-providers";
  executiveSummary: string;
  scope: {
    seed: InvestigationSeed;
    objective: string;
    authorizationMode: OsintAuthorizationMode;
    providers: string[];
    externalCalls: number;
  };
  counts: {
    entities: number;
    observations: number;
    claims: number;
    relationships: number;
    evidence: number;
    evidenceBytes: number;
    candidateLeads: number;
    contradictions: number;
    changes: number;
  };
  findings: OsintReportFinding[];
  relationships: Array<Pick<OsintRelationship, "id" | "sourceEntityId" | "targetEntityId" | "type" | "confidence" | "confidenceCategory" | "evidenceIds">>;
  candidateLeads: Array<Pick<OsintLead, "id" | "entityId" | "seed" | "reason" | "depth" | "status" | "discoveredByEvidenceIds">>;
  evidenceIndex: Array<Pick<OsintEvidence, "id" | "providerId" | "title" | "sourceRef" | "retrievedAt" | "sha256" | "byteLength">>;
  providerAttribution: Array<{ providerId: string; provider: string; documentationUrl: string }>;
  limitations: string[];
  markdown: string;
};

export type MockInvestigationResult = {
  investigation: OsintInvestigation;
  policyDecision: OsintPolicyDecision;
  plan: DeterministicInvestigationPlan;
  providerResults: NormalizedOsintProviderResult[];
  correlation: OsintCorrelationResult;
  expansion: OsintControlledExpansionEvaluation;
  report: OsintInvestigationReport;
};

export type MockInvestigationHandle = {
  jobId: string;
  result: Promise<MockInvestigationResult>;
  cancel(): boolean;
  snapshot: ManagedJobHandle<MockInvestigationResult>["snapshot"];
};

function normalizeDomain(value: string) {
  const domain = value.trim().toLocaleLowerCase("en-US").replace(/\.$/, "");
  if (!domain || domain.length > 253 || domain.includes("://") || domain.includes("/") || domain.includes("@") || !domain.includes(".")) throw new Error("A domain investigation requires a plain fully qualified domain name.");
  const labels = domain.split(".");
  if (labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) throw new Error("The domain contains an invalid label.");
  return domain;
}

function validateInput(input: MockInvestigationInput) {
  const objective = input.objective.trim();
  if (!objective || objective.length > 2_000) throw new Error("Mock investigation objective must contain between 1 and 2,000 characters.");
  const authorizationMode = input.authorizationMode ?? "public-research";
  const budget = validateInvestigationBudget(input.budget ?? MOCK_INVESTIGATION_BUDGET);
  if (input.kind === "domain") return { objective, authorizationMode, budget, identity: { kind: input.kind, domain: normalizeDomain(input.domain) } } as const;
  return { objective, authorizationMode, budget, identity: { kind: input.kind, observationId: input.observation.observationId, sourceId: input.observation.provenance.sourceFeedId } } as const;
}

function valueText(value: unknown) {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function citations(ids: string[]) {
  return ids.map((id) => `[EV:${id}]`).join(" ");
}

function createReport(
  investigation: OsintInvestigation,
  plan: DeterministicInvestigationPlan,
  correlation: OsintCorrelationResult,
  providerResults: NormalizedOsintProviderResult[],
  executor: MockProviderExecutor,
  generatedAt: string,
): OsintInvestigationReport {
  const entityById = new Map(correlation.entities.map((entity) => [entity.id, entity]));
  const conclusionByClaim = new Map(correlation.conclusions.map((conclusion) => [conclusion.claimId, conclusion]));
  const findings = correlation.claims.map((claim) => ({
    claimId: claim.id, subjectEntityId: claim.subjectEntityId, subject: entityById.get(claim.subjectEntityId)?.displayName ?? claim.subjectEntityId,
    predicate: claim.predicate, value: valueText(claim.value), status: claim.status, confidence: claim.confidence, confidenceCategory: claim.confidenceCategory,
    evidenceIds: claim.evidenceIds, observationIds: claim.observationIds, explanation: claim.explanation, conclusion: conclusionByClaim.get(claim.id)!,
  }));
  const limitations = [...new Set([
    "MOCK EVIDENCE ONLY: this report contains deterministic offline fixtures and must not be interpreted as current real-world intelligence.",
    ...providerResults.flatMap(({ coverageLimitations, warnings }) => [...coverageLimitations, ...warnings]),
    ...correlation.observations.flatMap(({ coverageLimitations }) => coverageLimitations),
    "Candidate leads were not queried, submitted, watched, or expanded automatically.",
  ])].sort();
  const counts = {
    entities: correlation.entities.length, observations: correlation.observations.length, claims: correlation.claims.length,
    relationships: correlation.relationships.length, evidence: correlation.evidence.length,
    evidenceBytes: correlation.evidence.reduce((total, item) => total + item.byteLength, 0), candidateLeads: correlation.leads.length,
    contradictions: correlation.contradictions.length, changes: correlation.changes.length,
  };
  const providerAttribution = executor.list().filter((provider) => plan.steps.some((step) => step.providerId === provider.descriptor.id)).map((provider) => ({
    providerId: provider.descriptor.id, provider: provider.descriptor.attribution.provider, documentationUrl: provider.descriptor.attribution.documentationUrl,
  })).sort((left, right) => left.providerId.localeCompare(right.providerId));
  const executiveSummary = `The bounded offline investigation correlated ${counts.evidence} fixture evidence records from ${providerAttribution.length} mock providers into ${counts.entities} deduplicated entities, ${counts.claims} cited claims, ${counts.relationships} relationships, and ${counts.candidateLeads} unexecuted candidate leads.`;
  const lines = [
    `# ${investigation.seed.label ?? investigation.seed.value} — Mock OSINT Investigation`, "",
    "> MOCK EVIDENCE ONLY — deterministic offline fixtures; no live provider was contacted.", "",
    "## Executive summary", "", executiveSummary, "",
    "## Scope", "", `- Objective: ${investigation.objective}`, `- Authorization: ${investigation.authorizationMode}`, `- Providers: ${providerAttribution.map(({ providerId }) => providerId).join(", ") || "none"}`, `- External fixture calls: ${plan.reservations.externalCalls}`, "",
    "## Findings", "",
    ...findings.flatMap((finding) => [
      `- **Claim:** ${finding.subject} / ${finding.predicate}: ${finding.value}`,
      `  - Supports: ${finding.conclusion.supportingEvidenceIds.length ? citations(finding.conclusion.supportingEvidenceIds) : "none"}`,
      `  - Contradicts: ${finding.conclusion.contradictingEvidenceIds.length ? citations(finding.conclusion.contradictingEvidenceIds) : "none detected"}`,
      `  - Freshness: ${finding.conclusion.freshness.category}${finding.conclusion.freshness.newestObservedAt ? `; newest ${finding.conclusion.freshness.newestObservedAt}` : ""}`,
      `  - Confidence: ${finding.conclusion.confidence.explanation}`,
      `  - Coverage: ${finding.conclusion.coverageLimitations.length ? finding.conclusion.coverageLimitations.join(" ") : "No provider established exhaustive coverage."}`,
    ]),
    "", "## Relationships", "",
    ...correlation.relationships.map((relationship) => `- ${entityById.get(relationship.sourceEntityId)?.displayName ?? relationship.sourceEntityId} —${relationship.type}→ ${entityById.get(relationship.targetEntityId)?.displayName ?? relationship.targetEntityId} (${relationship.confidenceCategory}) ${citations(relationship.evidenceIds)}`),
    "", "## Temporal changes", "", ...(correlation.changes.length ? correlation.changes.map((change) => `- ${change.changeType.toUpperCase()}: ${change.entityId} / ${change.predicate} changed from ${valueText(change.fromValue)} to ${valueText(change.toValue)} at ${change.observedAt} ${citations(change.evidenceIds)}`) : ["- None detected."]),
    "", "## Contradictions", "", ...(correlation.contradictions.length ? correlation.contradictions.map((contradiction) => `- ${contradiction.subjectEntityId} / ${contradiction.predicate}: ${contradiction.explanation} ${citations(contradiction.evidenceIds)}`) : ["- None detected."]),
    "", "## Candidate leads", "",
    ...(correlation.leads.length ? correlation.leads.map((lead) => `- CANDIDATE ONLY: ${lead.seed.type} ${lead.seed.value} — ${lead.reason} ${citations(lead.discoveredByEvidenceIds)}`) : ["- None."]),
    "", "## Limitations", "", ...limitations.map((limitation) => `- ${limitation}`), "",
    "## Evidence index", "", ...correlation.evidence.map((item) => `- [EV:${item.id}] ${item.providerId} — ${item.title} — SHA-256 ${item.sha256}`), "",
  ];
  const reportCore = { investigationId: investigation.id, generatedAt, counts, findings, relationships: correlation.relationships, leads: correlation.leads, evidence: correlation.evidence.map(({ id, sha256 }) => ({ id, sha256 })) };
  return {
    version: "1.1.0", id: osintStableId("report", reportCore), investigationId: investigation.id, title: `${investigation.seed.label ?? investigation.seed.value} — Mock OSINT Investigation`,
    generatedAt, evidenceMode: "deterministic-offline-fixtures", executiveSummary,
    scope: { seed: investigation.seed, objective: investigation.objective, authorizationMode: investigation.authorizationMode, providers: providerAttribution.map(({ providerId }) => providerId), externalCalls: plan.reservations.externalCalls },
    counts, findings,
    relationships: correlation.relationships.map(({ id, sourceEntityId, targetEntityId, type, confidence, confidenceCategory, evidenceIds }) => ({ id, sourceEntityId, targetEntityId, type, confidence, confidenceCategory, evidenceIds })),
    candidateLeads: correlation.leads.map(({ id, entityId, seed, reason, depth, status, discoveredByEvidenceIds }) => ({ id, entityId, seed, reason, depth, status, discoveredByEvidenceIds })),
    evidenceIndex: correlation.evidence.map(({ id, providerId, title, sourceRef, retrievedAt, sha256, byteLength }) => ({ id, providerId, title, sourceRef, retrievedAt, sha256, byteLength })),
    providerAttribution, limitations, markdown: lines.join("\n"),
  };
}

export class MockOsintInvestigationRuntime {
  private readonly jobs: VoidCatJobManager;
  private readonly executor: MockProviderExecutor;
  private readonly hunterIntake: HunterSeekerIntakeAdapter;
  private readonly now: () => number;

  constructor(options: { jobs?: VoidCatJobManager; executor?: MockProviderExecutor; hunterIntake?: HunterSeekerIntakeAdapter; now?: () => number } = {}) {
    this.jobs = options.jobs ?? voidcatJobManager; this.executor = options.executor ?? new MockProviderExecutor(); this.hunterIntake = options.hunterIntake ?? new HunterSeekerIntakeAdapter(); this.now = options.now ?? Date.now;
  }

  start(input: MockInvestigationInput): MockInvestigationHandle {
    const normalized = validateInput(input); const createdAt = new Date(this.now()).toISOString();
    const investigationId = osintStableId("inv", { identity: normalized.identity, objective: normalized.objective, authorizationMode: normalized.authorizationMode });
    let intake: HunterSeekerIntakeResult | undefined;
    const investigationSeed: InvestigationSeed = input.kind === "domain"
      ? (() => { const domain = normalizeDomain(input.domain); return { type: "domain" as const, value: domain, label: domain, attributes: {}, source: { kind: "operator" as const, id: "operator-domain-seed" } }; })()
      : (intake = this.hunterIntake.adaptObservation(input.observation, { investigationId, receivedAt: createdAt })).seed;
    validateInvestigationSeed(investigationSeed);
    const providers = this.executor.list(); const descriptors = providers.map(({ descriptor }) => descriptor);
    const request = { seed: investigationSeed, objective: normalized.objective, authorizationMode: normalized.authorizationMode, budget: normalized.budget };
    const decision = evaluateOsintPolicy(request, descriptors, createdAt);
    if (decision.outcome !== "allow") throw new Error(`Mock investigation was held by policy: ${decision.reasons.join(" ")}`);
    const plan = buildDeterministicInvestigationPlan(request, descriptors, decision, createdAt);
    const initialInvestigation = validateOsintContract("investigation", {
      schemaVersion: OSINT_SCHEMA_VERSION, id: investigationId, seed: investigationSeed, objective: normalized.objective, authorizationMode: normalized.authorizationMode,
      status: "planned", budget: normalized.budget, planId: plan.id, counts: { providers: 0, externalCalls: 0, entities: 0, evidenceBytes: 0, leads: 0 }, warnings: [], createdAt, updatedAt: createdAt,
    });
    const totalProgress = plan.steps.length + 3;
    const job = this.jobs.start<MockInvestigationResult>({
      module: "osint-investigation", name: "mock-vertical-slice",
      caps: { maxIterations: Math.max(12, plan.steps.length * 4 + 8), timeoutMs: normalized.budget.maximumRuntimeMs, maxExternalCalls: normalized.budget.maximumExternalCalls },
      run: async (context) => {
        const providerResults: NormalizedOsintProviderResult[] = [];
        context.consumeIteration(); context.reportProgress({ current: 0, total: totalProgress, message: "Executing bounded offline provider plan" });
        for (const [index, step] of plan.steps.entries()) {
          context.checkpoint(); context.consumeIteration();
          const provider = this.executor.resolve(step.providerId);
          const support = provider.supports(investigationSeed, normalized.authorizationMode);
          if (!support.supported || !support.capabilityIds.includes(step.capabilityId)) throw new Error(`Mock provider ${step.providerId} no longer supports planned capability ${step.capabilityId}.`);
          const raw = await context.externalCall((signal) => Promise.resolve(this.executor.query(step.query, signal)));
          context.consumeIteration(); const draft = provider.normalize(raw, { investigationId, query: step.query, provider: provider.descriptor, retrievedAt: createdAt, budget: normalized.budget, cache: { status: "fixture", ageMs: 0 } });
          providerResults.push(normalizeProviderResult(draft, { investigationId, query: step.query, provider: provider.descriptor, retrievedAt: createdAt, budget: normalized.budget, cache: { status: "fixture", ageMs: 0 } }));
          context.reportUsage({ units: 1 }); context.reportProgress({ current: index + 1, total: totalProgress, message: `Normalized ${step.providerId}` });
        }
        context.checkpoint(); context.consumeIteration();
        const correlation = correlateOsintResults({
          investigationId, providerResults, providers: descriptors,
          ...(intake ? { seedRecords: { entities: [intake.entity], evidence: [intake.evidence], observations: [intake.observation] } } : {}),
        });
        context.reportProgress({ current: plan.steps.length + 1, total: totalProgress, message: "Correlated entities, claims, and relationships" });
        const evidenceBytes = correlation.evidence.reduce((total, evidence) => total + evidence.byteLength, 0);
        if (correlation.entities.length > normalized.budget.maximumEntities || evidenceBytes > normalized.budget.maximumEvidenceBytes || correlation.leads.some(({ depth }) => depth > normalized.budget.maximumDiscoveryDepth)) throw new Error("Correlated fixture results exceeded the approved investigation budget.");
        context.checkpoint(); context.consumeIteration();
        const completedAt = new Date(this.now()).toISOString();
        const investigation = validateOsintContract("investigation", {
          ...initialInvestigation, status: "completed", counts: { providers: plan.reservations.providers, externalCalls: plan.reservations.externalCalls, entities: correlation.entities.length, evidenceBytes, leads: correlation.leads.length },
          warnings: [...new Set(providerResults.flatMap(({ warnings }) => warnings))], updatedAt: completedAt, completedAt,
        });
        const report = createReport(investigation, plan, correlation, providerResults, this.executor, createdAt);
        const expansion = evaluateControlledExpansion({
          investigation, leads: correlation.leads, providers: descriptors,
          usage: { providerIds: [...new Set(plan.steps.map(({ providerId }) => providerId))], externalCalls: investigation.counts.externalCalls, runtimeMs: 0, entities: investigation.counts.entities, evidenceBytes: investigation.counts.evidenceBytes },
        });
        context.reportProgress({ current: plan.steps.length + 2, total: totalProgress, message: "Generated cited deterministic report" });
        context.consumeIteration(); context.reportProgress({ current: totalProgress, total: totalProgress, message: "Mock investigation complete" });
        return { investigation, policyDecision: decision, plan, providerResults, correlation, expansion, report };
      },
    });
    return { jobId: job.id, result: job.result, cancel: () => job.cancel(), snapshot: job.snapshot };
  }
}
