import { isIP } from "node:net";
import { voidcatJobManager, type VoidCatJobManager } from "../voidcat-job-manager.ts";
import {
  DEFAULT_INVESTIGATION_BUDGET,
  OSINT_SCHEMA_VERSION,
  validateInvestigationSeed,
  validateOsintContract,
  type InvestigationBudget,
  type InvestigationSeed,
  type OsintAuthorizationMode,
  type OsintInvestigation,
} from "./contracts.ts";
import { correlateOsintResults } from "./correlation-and-confidence.ts";
import { evaluateControlledExpansion } from "./controlled-expansion.ts";
import { LIVE_OSINT_PROVIDER_DESCRIPTORS, type LiveOsintProviderId } from "./live-provider-adapters.ts";
import type { MockInvestigationResult, OsintInvestigationReport } from "./mock-investigation-runtime.ts";
import { buildDeterministicInvestigationPlan, evaluateOsintPolicy, type DeterministicInvestigationPlan, type OsintPolicyDecision } from "./policy-and-planner.ts";
import { osintStableId, type NormalizedOsintProviderResult } from "./provider-contracts.ts";
import type { OsintStore } from "./osint-store.ts";

export const OSINT_INVESTIGATION_TYPES = ["domain", "ip-address", "username", "organization", "infrastructure", "hunter-event", "passive-web", "geographic-area", "authorized-exposure"] as const;
export type OsintInvestigationType = typeof OSINT_INVESTIGATION_TYPES[number];

export type OsintInvestigationWorkspaceInput = {
  type: OsintInvestigationType;
  seed: string;
  seedSubtype?: "domain" | "ip-address" | "email-address";
  objective: string;
  authorizationMode: OsintAuthorizationMode;
  exposureConfirmation?: { confirmed: boolean; exactTarget: string; statement: string };
};

export type OsintProviderExecution = (body: Record<string, unknown>, options: { investigationId: string; signal: AbortSignal }) => Promise<{ result: NormalizedOsintProviderResult }>;

export type OsintInvestigationPreview = {
  investigationId: string;
  seed: InvestigationSeed;
  objective: string;
  authorizationMode: OsintAuthorizationMode;
  budget: InvestigationBudget;
  policyDecision: OsintPolicyDecision;
  plan: DeterministicInvestigationPlan | null;
  providerIds: LiveOsintProviderId[];
  warnings: string[];
  sensitive: boolean;
};

function boundedText(value: string, label: string, maximum: number) {
  const normalized = value.trim(); if (!normalized || normalized.length > maximum) throw new Error(`${label} must contain between 1 and ${maximum.toLocaleString()} characters.`); return normalized;
}

function normalizedDomain(value: string) {
  const domain = boundedText(value, "Domain", 253).toLowerCase().replace(/\.$/, "");
  if (domain.includes("://") || domain.includes("/") || domain.includes("@") || !domain.includes(".") || domain.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error("Enter a plain fully qualified domain name.");
  return domain;
}

function normalizedInput(value: OsintInvestigationWorkspaceInput) {
  if (!OSINT_INVESTIGATION_TYPES.includes(value.type)) throw new Error("Select a supported investigation type.");
  const objective = boundedText(value.objective, "Objective", 2_000); const raw = boundedText(value.seed, "Investigation seed", 500);
  let seedType: InvestigationSeed["type"]; let seedValue = raw; let providerIds: LiveOsintProviderId[];
  if (value.type === "domain") { seedType = "domain"; seedValue = normalizedDomain(raw); providerIds = ["opensquat-local", "searxng"]; }
  else if (value.type === "ip-address") { if (!isIP(raw)) throw new Error("Enter a valid IPv4 or IPv6 address."); seedType = "ip-address"; providerIds = ["shodan", "censys"]; }
  else if (value.type === "username") { seedType = "username"; providerIds = ["searxng"]; }
  else if (value.type === "organization") { seedType = "organization"; providerIds = ["searxng"]; }
  else if (value.type === "infrastructure") { const subtype = value.seedSubtype === "ip-address" ? "ip-address" : "domain"; if (subtype === "ip-address" && !isIP(raw)) throw new Error("Enter a valid infrastructure IP address."); seedType = subtype; seedValue = subtype === "domain" ? normalizedDomain(raw) : raw; providerIds = ["shodan", "censys"]; }
  else if (value.type === "hunter-event") { seedType = "event"; providerIds = ["searxng"]; }
  else if (value.type === "passive-web") { seedType = "unknown"; providerIds = ["searxng"]; }
  else if (value.type === "geographic-area") { if (!/^-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?$/.test(raw)) throw new Error("A geographic seed requires south, west, north, east bounds."); seedType = "geographic-area"; providerIds = ["deflock", "searxng"]; }
  else { seedType = value.seedSubtype === "domain" ? "domain" : "email-address"; seedValue = seedType === "domain" ? normalizedDomain(raw) : raw.toLowerCase(); providerIds = ["hibp"]; }
  const authorizationMode = value.authorizationMode;
  if (value.type === "authorized-exposure") {
    if (authorizationMode !== "exposure-check") throw new Error("Authorized exposure investigations require exposure-check mode.");
    if (!value.exposureConfirmation?.confirmed || value.exposureConfirmation.exactTarget.trim().toLowerCase() !== seedValue.toLowerCase() || value.exposureConfirmation.statement.trim().length < 12) throw new Error("The exact exposure target requires an explicit authorization statement.");
  } else if (authorizationMode === "exposure-check") throw new Error("Exposure-check mode is restricted to the authorized exposure investigation type.");
  const seed: InvestigationSeed = { type: seedType, value: seedValue, label: seedValue, attributes: { investigationType: value.type }, source: { kind: "operator", id: "osint-investigation-interface" } };
  const exposureConfirmation = value.type === "authorized-exposure" ? { confirmed: true as const, exactTarget: seedValue, statement: value.exposureConfirmation!.statement.trim() } : undefined;
  validateInvestigationSeed(seed); return { type: value.type, seed, objective, authorizationMode, providerIds, exposureConfirmation };
}

function valueText(value: unknown) { return typeof value === "string" ? value : JSON.stringify(value); }
function citations(ids: readonly string[]) { return ids.map((id) => `[EV:${id}]`).join(" "); }

function createLiveReport(result: Omit<MockInvestigationResult, "report">): OsintInvestigationReport {
  const { investigation, plan, correlation, providerResults } = result; const generatedAt = investigation.completedAt ?? investigation.updatedAt;
  const entities = new Map(correlation.entities.map((entity) => [entity.id, entity])); const conclusions = new Map(correlation.conclusions.map((item) => [item.claimId, item]));
  const providerAttribution = LIVE_OSINT_PROVIDER_DESCRIPTORS.filter((provider) => plan.steps.some((step) => step.providerId === provider.id)).map((provider) => ({ providerId: provider.id, provider: provider.attribution.provider, documentationUrl: provider.attribution.documentationUrl }));
  const findings = correlation.claims.map((claim) => ({ claimId: claim.id, subjectEntityId: claim.subjectEntityId, subject: entities.get(claim.subjectEntityId)?.displayName ?? claim.subjectEntityId, predicate: claim.predicate, value: valueText(claim.value), status: claim.status, confidence: claim.confidence, confidenceCategory: claim.confidenceCategory, evidenceIds: claim.evidenceIds, observationIds: claim.observationIds, explanation: claim.explanation, conclusion: conclusions.get(claim.id)! }));
  const limitations = [...new Set([...providerResults.flatMap((item) => [...item.coverageLimitations, ...item.warnings]), ...investigation.warnings, "Passive provider coverage is incomplete and absence of evidence is not evidence of absence.", "Candidate leads remain unverified and were not expanded automatically."])];
  const counts = { entities: correlation.entities.length, observations: correlation.observations.length, claims: correlation.claims.length, relationships: correlation.relationships.length, evidence: correlation.evidence.length, evidenceBytes: correlation.evidence.reduce((sum, item) => sum + item.byteLength, 0), candidateLeads: correlation.leads.length, contradictions: correlation.contradictions.length, changes: correlation.changes.length };
  const markdown = [
    `# ${investigation.seed.label ?? investigation.seed.value} — OSINT Investigation`, "", `Generated: ${generatedAt}`, "", "## Executive summary", "", `Bounded passive investigation produced ${counts.evidence} evidence records, ${counts.entities} entities, ${counts.claims} claims, ${counts.relationships} relationships, and ${counts.candidateLeads} unexecuted candidate leads.`, "",
    "## Scope", "", `- Objective: ${investigation.objective}`, `- Authorization: ${investigation.authorizationMode}`, `- Providers: ${providerAttribution.map((item) => item.providerId).join(", ") || "none completed"}`, `- External-call budget: ${investigation.budget.maximumExternalCalls}`, "",
    "## Findings", "", ...(findings.length ? findings.flatMap((finding) => [`- ${finding.subject} / ${finding.predicate}: ${finding.value} (${finding.confidenceCategory}, ${Math.round(finding.confidence * 100)}%) ${citations(finding.evidenceIds) || "[UNSUPPORTED — NO EVIDENCE ID]"}`, `  - ${finding.explanation}`]) : ["- No evidence-backed claims were produced."]), "",
    "## Contradictions", "", ...(correlation.contradictions.length ? correlation.contradictions.map((item) => `- ${item.explanation} ${citations(item.evidenceIds)}`) : ["- None detected in available evidence."]), "",
    "## Relationships", "", ...(correlation.relationships.length ? correlation.relationships.map((item) => `- ${entities.get(item.sourceEntityId)?.displayName ?? item.sourceEntityId} —${item.type}→ ${entities.get(item.targetEntityId)?.displayName ?? item.targetEntityId} (${item.confidenceCategory}) ${citations(item.evidenceIds)}`) : ["- None produced."]), "",
    "## Candidate leads", "", ...(correlation.leads.length ? correlation.leads.map((item) => `- CANDIDATE ONLY: ${item.seed.type} ${item.seed.label ?? item.seed.value} — ${item.reason} ${citations(item.discoveredByEvidenceIds)}`) : ["- None produced."]), "",
    "## Evidence index", "", ...correlation.evidence.map((item) => `- [EV:${item.id}] ${item.providerId} — ${item.title} — cache ${item.cache.status}, age ${item.cache.ageMs} ms`), "", "## Limitations and warnings", "", ...limitations.map((item) => `- ${item}`), "",
  ].join("\n");
  return { version: "1.1.0", id: osintStableId("report", { investigationId: investigation.id, generatedAt, evidence: correlation.evidence.map(({ id, sha256 }) => ({ id, sha256 })) }), investigationId: investigation.id, title: `${investigation.seed.label ?? investigation.seed.value} — OSINT Investigation`, generatedAt, evidenceMode: "live-passive-providers", executiveSummary: `Bounded passive investigation correlated ${counts.evidence} evidence records into ${counts.claims} cited claims.`, scope: { seed: investigation.seed, objective: investigation.objective, authorizationMode: investigation.authorizationMode, providers: providerAttribution.map((item) => item.providerId), externalCalls: investigation.counts.externalCalls }, counts, findings, relationships: correlation.relationships.map(({ id, sourceEntityId, targetEntityId, type, confidence, confidenceCategory, evidenceIds }) => ({ id, sourceEntityId, targetEntityId, type, confidence, confidenceCategory, evidenceIds })), candidateLeads: correlation.leads.map(({ id, entityId, seed, reason, depth, status, discoveredByEvidenceIds }) => ({ id, entityId, seed, reason, depth, status, discoveredByEvidenceIds })), evidenceIndex: correlation.evidence.map(({ id, providerId, title, sourceRef, retrievedAt, sha256, byteLength }) => ({ id, providerId, title, sourceRef, retrievedAt, sha256, byteLength })), providerAttribution, limitations, markdown };
}

export function renderStoredInvestigationReport(view: NonNullable<ReturnType<OsintStore["getInvestigationView"]>>) {
  const investigation = view.investigation as { id: string; seed: InvestigationSeed; objective: string; authorizationMode: string; warnings: string[]; createdAt: string; counts: { externalCalls: number } };
  const entityNames = new Map(view.entities.map((entity) => [entity.id, entity.displayName]));
  const lines = [`# ${investigation.seed.label ?? investigation.seed.value} — OSINT Investigation`, "", `Investigation: ${investigation.id}`, `Created: ${investigation.createdAt}`, "", "## Objective", "", investigation.objective, "", "## Claims", ""];
  if (!view.claims.length) lines.push("- No evidence-backed claims were produced.");
  for (const claim of view.claims) lines.push(`- ${entityNames.get(claim.subjectEntityId) ?? claim.subjectEntityId} / ${claim.predicate}: ${valueText(claim.value)} (${claim.confidenceCategory}, ${Math.round(claim.confidence * 100)}%) ${citations(claim.evidenceIds) || "[UNSUPPORTED — NO EVIDENCE ID]"}`, `  - ${claim.explanation}`);
  lines.push("", "## Contradictions", "", ...(view.contradictions.length ? view.contradictions.map((item: { explanation?: string; evidenceIds?: string[] }) => `- ${item.explanation ?? "Conflicting evidence"} ${citations(item.evidenceIds ?? [])}`) : ["- None detected in available evidence."]), "", "## Relationships", "", ...(view.relationships.length ? view.relationships.map((item) => `- ${entityNames.get(item.sourceEntityId) ?? item.sourceEntityId} —${item.type}→ ${entityNames.get(item.targetEntityId) ?? item.targetEntityId} (${item.confidenceCategory}) ${citations(item.evidenceIds)}`) : ["- None produced."]), "", "## Candidate leads", "", ...(view.leads.length ? view.leads.map((item) => `- ${item.status.toUpperCase()}: ${item.seed.type} ${item.seed.label ?? item.seed.value} — ${item.reason} ${citations(item.discoveredByEvidenceIds)}`) : ["- None produced."]), "", "## Evidence index", "", ...view.evidence.map((item) => `- [EV:${item.id}] ${item.providerId} — ${item.title} — cache ${item.cache.status}, age ${item.cache.ageMs} ms`), "", "## Warnings", "", ...(investigation.warnings.length ? investigation.warnings.map((item) => `- ${item}`) : ["- Passive coverage is incomplete; absence of evidence is not evidence of absence."]), "");
  return lines.join("\n");
}

export class OsintInvestigationWorkspace {
  private readonly options: { executeProvider: OsintProviderExecution; store: () => Promise<OsintStore>; project?: () => { id: string; osintMemoryLimitBytes: number }; jobs?: VoidCatJobManager; now?: () => number };
  constructor(options: { executeProvider: OsintProviderExecution; store: () => Promise<OsintStore>; project?: () => { id: string; osintMemoryLimitBytes: number }; jobs?: VoidCatJobManager; now?: () => number }) { this.options = options; }

  preview(input: OsintInvestigationWorkspaceInput): OsintInvestigationPreview {
    const normalized = normalizedInput(input); const evaluatedAt = new Date((this.options.now ?? Date.now)()).toISOString(); const budget = { ...DEFAULT_INVESTIGATION_BUDGET };
    const investigationId = osintStableId("ui-inv", { seed: normalized.seed, objective: normalized.objective, authorizationMode: normalized.authorizationMode, evaluatedAt });
    const providers = LIVE_OSINT_PROVIDER_DESCRIPTORS.filter((provider) => normalized.providerIds.includes(provider.id as LiveOsintProviderId));
    const request = { seed: normalized.seed, objective: normalized.objective, authorizationMode: normalized.authorizationMode, budget, requestedProviderIds: normalized.providerIds, ...(normalized.exposureConfirmation ? { exposureConfirmation: normalized.exposureConfirmation } : {}) };
    const policyDecision = evaluateOsintPolicy(request, providers, evaluatedAt); const plan = policyDecision.outcome === "allow" ? buildDeterministicInvestigationPlan(request, providers, policyDecision, evaluatedAt) : null;
    const warnings = [...new Set([...(policyDecision.outcome === "allow" ? [] : policyDecision.reasons), ...(normalized.type === "authorized-exposure" ? ["Sensitive exposure results require exact-target authorization and cannot be forwarded automatically."] : []), "Passive results may be incomplete, stale, cached, or unavailable."])];
    return { investigationId, seed: normalized.seed, objective: normalized.objective, authorizationMode: normalized.authorizationMode, budget, policyDecision, plan, providerIds: normalized.providerIds, warnings, sensitive: normalized.type === "authorized-exposure" };
  }

  start(input: OsintInvestigationWorkspaceInput) {
    const preview = this.preview(input); if (!preview.plan || preview.policyDecision.outcome !== "allow") throw new Error(preview.policyDecision.reasons.join(" ") || "The investigation policy held this request.");
    const jobs = this.options.jobs ?? voidcatJobManager; const total = preview.plan.steps.length + 3;
    const handle = jobs.start<MockInvestigationResult>({ module: "osint-investigation-ui", name: "bounded-investigation", caps: { maxIterations: Math.max(16, preview.plan.steps.length * 4 + 8), timeoutMs: preview.budget.maximumRuntimeMs, maxExternalCalls: preview.budget.maximumExternalCalls }, run: async (context) => {
      const providerResults: NormalizedOsintProviderResult[] = []; const failures: string[] = [];
      context.reportProgress({ current: 0, total, message: "Executing approved passive plan" });
      for (const [index, step] of preview.plan!.steps.entries()) {
        context.checkpoint(); context.consumeIteration();
        try {
          const execution = await context.externalCall((signal) => this.options.executeProvider({ providerId: step.providerId, targetType: preview.seed.type, target: preview.seed.value, objective: preview.objective, authorizationMode: preview.authorizationMode, ...(input.exposureConfirmation ? { confirmed: true, exactTarget: input.exposureConfirmation.exactTarget, authorizationStatement: input.exposureConfirmation.statement } : {}) }, { investigationId: preview.investigationId, signal }));
          providerResults.push(execution.result);
        } catch (error) { failures.push(`${step.providerId}: ${error instanceof Error ? error.message : "provider unavailable"}`); }
        context.reportProgress({ current: index + 1, total, message: `Processed ${step.providerId}` });
      }
      context.checkpoint(); context.consumeIteration(); const correlation = correlateOsintResults({ investigationId: preview.investigationId, providerResults, providers: [...LIVE_OSINT_PROVIDER_DESCRIPTORS] });
      context.reportProgress({ current: preview.plan!.steps.length + 1, total, message: "Correlated entities, claims, contradictions, and relationships" });
      const evidenceBytes = correlation.evidence.reduce((sum, item) => sum + item.byteLength, 0); if (correlation.entities.length > preview.budget.maximumEntities || evidenceBytes > preview.budget.maximumEvidenceBytes) throw new Error("The normalized investigation exceeded its approved budget.");
      const completedAt = new Date((this.options.now ?? Date.now)()).toISOString(); const investigation = validateOsintContract("investigation", { schemaVersion: OSINT_SCHEMA_VERSION, id: preview.investigationId, seed: preview.seed, objective: preview.objective, authorizationMode: preview.authorizationMode, status: providerResults.length === preview.plan!.steps.length ? "completed" : "partial", budget: preview.budget, planId: preview.plan!.id, counts: { providers: providerResults.length, externalCalls: preview.plan!.reservations.externalCalls, entities: correlation.entities.length, evidenceBytes, leads: correlation.leads.length }, warnings: [...new Set([...failures, ...providerResults.flatMap((item) => item.warnings)])], createdAt: preview.plan!.createdAt, updatedAt: completedAt, completedAt }) as OsintInvestigation;
      const expansion = evaluateControlledExpansion({ investigation, leads: correlation.leads, providers: [...LIVE_OSINT_PROVIDER_DESCRIPTORS], usage: { providerIds: [...new Set(providerResults.map((item) => item.providerId))], externalCalls: investigation.counts.externalCalls, runtimeMs: 0, entities: investigation.counts.entities, evidenceBytes } });
      const core = { investigation, policyDecision: preview.policyDecision, plan: preview.plan!, providerResults, correlation, expansion }; const report = createLiveReport(core); const result = { ...core, report };
      context.reportProgress({ current: preview.plan!.steps.length + 2, total, message: "Saving bounded investigation and cited report" }); const store = await this.options.store(); const saved = await store.saveInvestigationBundle(result, { signal: context.signal }); const project = this.options.project?.(); if (project) store.assignInvestigationProject(investigation.id, project.id, saved.estimatedBytes, project.osintMemoryLimitBytes);
      context.consumeIteration(); context.reportProgress({ current: total, total, message: "Investigation complete" }); return result;
    } });
    void handle.result.catch(() => undefined); return { jobId: handle.id, investigationId: preview.investigationId, preview };
  }
}
