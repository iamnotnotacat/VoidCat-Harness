import { AsyncLocalStorage } from "node:async_hooks";
import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import { voidcatJobManager, type ManagedJobContext, type VoidCatJobManager } from "../voidcat-job-manager.ts";
import { voidcatToolRegistry, type DiscoveredTool, type ToolDefinition, type ToolInvocationCaller, type VoidCatToolRegistry } from "../voidcat-tool-registry.ts";
import { DEFAULT_INVESTIGATION_BUDGET, OSINT_SCHEMA_VERSION, validateOsintContract, type InvestigationSeed, type OsintInvestigation } from "./contracts.ts";
import { correlateOsintResults, type OsintCorrelationResult } from "./correlation-and-confidence.ts";
import { evaluateControlledExpansion } from "./controlled-expansion.ts";
import { createHunterOsintInvestigationDraft } from "./hunter-seeker-bridge.ts";
import { LIVE_OSINT_PROVIDER_DESCRIPTORS, type LiveOsintProviderId } from "./live-provider-adapters.ts";
import { osintStableId, type NormalizedOsintProviderResult } from "./provider-contracts.ts";
import type { HunterSeekerPublicObservation } from "../hunter-seeker/hunter-seeker-service.ts";

export type LiveUnitProviderResult = { investigationId: string; result: NormalizedOsintProviderResult; hunterForwarding: string };

type StoredUnitInvestigation = {
  id: string;
  toolName: string;
  objective: string;
  seed: InvestigationSeed;
  investigation: OsintInvestigation;
  correlation: OsintCorrelationResult;
  providerIds: LiveOsintProviderId[];
  failures: string[];
  createdAt: string;
};

export type OsintUnitToolResult = {
  status: "completed" | "partial" | "held" | "approval-required" | "candidate-awaiting-operator-approval";
  tool: string;
  investigationId?: string;
  summary: string;
  entities: Array<{ id: string; type: string; displayName: string }>;
  claims: Array<{ id: string; statement: string; confidence: number; confidenceCategory: string; evidenceIds: string[]; observationIds: string[]; explanation: string }>;
  relationships: Array<{ id: string; type: string; sourceEntityId: string; targetEntityId: string; confidence: number; evidenceIds: string[] }>;
  evidence: Array<{ id: string; providerId: string; title: string; excerpt: string; sourceRef: string; retrievedAt: string; sensitivity: string }>;
  candidateLeads: Array<{ id: string; type: string; value: string; label?: string; reason: string; status: "candidate"; evidenceIds: string[] }>;
  citations: Array<{ evidenceId: string; marker: string; providerId: string; title: string }>;
  coverageLimitations: string[];
  unsupportedConclusions: string[];
  nextAction?: string;
};

type ExposureApproval = { id: string; targetType: "email-address" | "domain"; exactTarget: string; statement: string; createdAt: string; expiresAt: string };
type ExecutionScope = { job: ManagedJobContext; maximumOutputTokens: number };

const executionScope = new AsyncLocalStorage<ExecutionScope>();
function emptyResult() { return { entities: [], claims: [], relationships: [], evidence: [], candidateLeads: [], citations: [], unsupportedConclusions: [] }; }
const SIMPLE_TEXT = { type: "string" as const, minLength: 1, maxLength: 500 };
const OBJECTIVE = { type: "string" as const, minLength: 1, maxLength: 2_000 };

function objectSchema(properties: Record<string, object>, required: string[]) {
  return { type: "object" as const, additionalProperties: false, properties, required };
}

function normalizeDomain(value: string) {
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  if (domain.length > 253 || domain.includes("://") || domain.includes("/") || domain.includes("@") || !domain.includes(".") || domain.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error("A plain fully qualified domain is required.");
  return domain;
}

function normalizeUsername(value: string) {
  const username = value.trim(); if (!/^[\p{L}\p{N}_.@-]{2,100}$/u.test(username)) throw new Error("The username contains unsupported characters."); return username;
}

function normalizeOrganization(value: string) { const organization = value.trim(); if (organization.length < 2 || organization.length > 200) throw new Error("The organization must contain 2 to 200 characters."); return organization; }
function objective(value: unknown, fallback: string) { return typeof value === "string" && value.trim() ? value.trim().slice(0, 2_000) : fallback; }
function evidenceMarker(id: string) { return `[EV:${id}]`; }
function boundedUnique(values: string[], maximum = 100) { return [...new Set(values.filter(Boolean))].slice(0, maximum); }
function safeError(error: unknown) { return (error instanceof Error ? error.message : "Provider unavailable.").replace(/((?:api[_ -]?key|authorization|bearer))\s*[:=]\s*\S+/gi, "$1 [REDACTED]").slice(0, 300); }

function resultFromRecord(record: StoredUnitInvestigation): OsintUnitToolResult {
  const entityById = new Map(record.correlation.entities.map((entity) => [entity.id, entity]));
  const conclusions = new Map(record.correlation.conclusions.map((item) => [item.claimId, item]));
  const evidence = record.correlation.evidence.slice(0, 40);
  const claims = record.correlation.claims.slice(0, 40).map((claim) => {
    const conclusion = conclusions.get(claim.id);
    const subject = entityById.get(claim.subjectEntityId)?.displayName ?? claim.subjectEntityId;
    return { id: claim.id, statement: `${subject} / ${claim.predicate}: ${typeof claim.value === "string" ? claim.value : JSON.stringify(claim.value)}`, confidence: claim.confidence, confidenceCategory: claim.confidenceCategory, evidenceIds: claim.evidenceIds, observationIds: claim.observationIds, explanation: conclusion?.confidence.explanation ?? claim.explanation };
  });
  const limitations = boundedUnique([...record.failures.map((failure) => `Provider unavailable: ${failure}`), ...record.correlation.observations.flatMap((item) => item.coverageLimitations), ...record.correlation.conclusions.flatMap((item) => item.coverageLimitations)], 50);
  const status = evidence.length ? record.failures.length ? "partial" : "completed" : "held";
  return {
    status, tool: record.toolName, investigationId: record.id,
    summary: evidence.length ? `${record.providerIds.length} fixed passive provider path(s) produced ${record.correlation.entities.length} entities, ${claims.length} cited claims, and ${record.correlation.leads.length} candidate leads.` : "No cited provider evidence was available; no factual conclusion was produced.",
    entities: record.correlation.entities.slice(0, 50).map(({ id, type, displayName }) => ({ id, type, displayName })), claims,
    relationships: record.correlation.relationships.slice(0, 50).map(({ id, type, sourceEntityId, targetEntityId, confidence, evidenceIds }) => ({ id, type, sourceEntityId, targetEntityId, confidence, evidenceIds })),
    evidence: evidence.map(({ id, providerId, title, excerpt, sourceRef, retrievedAt, sensitivity }) => ({ id, providerId, title, excerpt: excerpt ?? "", sourceRef, retrievedAt, sensitivity })),
    candidateLeads: record.correlation.leads.slice(0, 50).map((lead) => ({ id: lead.id, type: lead.seed.type, value: lead.seed.value, ...(lead.seed.label ? { label: lead.seed.label } : {}), reason: lead.reason, status: "candidate", evidenceIds: lead.discoveredByEvidenceIds })),
    citations: evidence.map(({ id, providerId, title }) => ({ evidenceId: id, marker: evidenceMarker(id), providerId, title })), coverageLimitations: limitations.length ? limitations : ["Passive providers do not establish exhaustive coverage."], unsupportedConclusions: [],
  };
}

function boundResult(result: OsintUnitToolResult, maximumOutputTokens: number) {
  const maximumBytes = Math.max(8_000, Math.min(256_000, Math.floor(maximumOutputTokens * 3.5)));
  const bounded = structuredClone(result);
  const bytes = () => Buffer.byteLength(JSON.stringify(bounded));
  while (bytes() > maximumBytes && bounded.evidence.length > 4) { const removed = bounded.evidence.pop(); if (removed) bounded.citations = bounded.citations.filter(({ evidenceId }) => evidenceId !== removed.id); }
  while (bytes() > maximumBytes && bounded.claims.length > 4) bounded.claims.pop();
  while (bytes() > maximumBytes && bounded.entities.length > 4) bounded.entities.pop();
  while (bytes() > maximumBytes && bounded.relationships.length) bounded.relationships.pop();
  while (bytes() > maximumBytes && bounded.candidateLeads.length > 4) bounded.candidateLeads.pop();
  bounded.coverageLimitations = bounded.coverageLimitations.slice(0, 12);
  return bounded;
}

export class OsintUnitToolRuntime {
  private readonly registry: VoidCatToolRegistry;
  private readonly jobs: VoidCatJobManager;
  private readonly executeProvider: (body: Record<string, unknown>, options: { investigationId: string; signal?: AbortSignal }) => Promise<LiveUnitProviderResult>;
  private readonly resolveHunterObservation: (observationId: string) => Promise<HunterSeekerPublicObservation | undefined>;
  private readonly rememberInvestigation?: (record: { id: string; toolName: string; output: OsintUnitToolResult }) => Promise<void>;
  private readonly investigations = new Map<string, StoredUnitInvestigation>();
  private readonly approvals = new Map<string, ExposureApproval>();
  private readonly unregister: Array<() => boolean> = [];

  constructor(options: { registry?: VoidCatToolRegistry; jobs?: VoidCatJobManager; executeProvider: OsintUnitToolRuntime["executeProvider"]; resolveHunterObservation: OsintUnitToolRuntime["resolveHunterObservation"]; rememberInvestigation?: OsintUnitToolRuntime["rememberInvestigation"] }) {
    this.registry = options.registry ?? voidcatToolRegistry; this.jobs = options.jobs ?? voidcatJobManager; this.executeProvider = options.executeProvider; this.resolveHunterObservation = options.resolveHunterObservation; this.rememberInvestigation = options.rememberInvestigation;
    this.registerTools();
  }

  discover(): DiscoveredTool[] { return this.registry.discover({ module: "osint-unit" }); }
  dispose() { while (this.unregister.length) this.unregister.pop()?.(); }

  authorizeExposure(input: { targetType: "email-address" | "domain"; exactTarget: string; statement: string }, now = Date.now()) {
    const exactTarget = input.targetType === "domain" ? normalizeDomain(input.exactTarget) : input.exactTarget.trim().toLowerCase();
    if (input.targetType === "email-address" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(exactTarget)) throw new Error("A valid exact email address is required.");
    const statement = input.statement.trim(); if (statement.length < 12 || statement.length > 500) throw new Error("State the authorization for this exact target in 12 to 500 characters.");
    this.pruneApprovals(now); const approval = { id: randomUUID(), targetType: input.targetType, exactTarget, statement, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 5 * 60_000).toISOString() };
    this.approvals.set(`${input.targetType}:${exactTarget}`, approval); return { id: approval.id, targetType: approval.targetType, exactTarget: approval.exactTarget, expiresAt: approval.expiresAt, oneTime: true };
  }

  startInvocation(name: string, argumentsValue: Record<string, unknown>, options: { caller: ToolInvocationCaller; maximumOutputTokens: number; parentSignal?: AbortSignal }) {
    const discovered = this.discover(); if (!discovered.some((tool) => tool.name === name)) throw new Error("The UNIT requested a tool outside the approved OSINT registry.");
    const handle = this.jobs.start<OsintUnitToolResult>({
      module: "osint-unit", name: name.split(".").at(-1) ?? "tool-invocation", caps: { maxIterations: 16, timeoutMs: 2 * 60_000, maxExternalCalls: 3 },
      run: async (job) => {
        const abort = () => handle.cancel(); options.parentSignal?.addEventListener("abort", abort, { once: true });
        try {
          job.consumeIteration(); job.reportProgress({ current: 0, total: 4, message: "Validating bounded OSINT tool request" });
          const result = await executionScope.run({ job, maximumOutputTokens: options.maximumOutputTokens }, () => this.registry.invoke<OsintUnitToolResult>(name, argumentsValue, { caller: options.caller, signal: job.signal }));
          job.consumeIteration(); job.reportUsage({ outputTokens: Math.ceil(JSON.stringify(result).length / 4), units: 1 }); job.reportProgress({ current: 4, total: 4, message: "Citations and evidence identifiers ready" }); return boundResult(result, options.maximumOutputTokens);
        } finally { options.parentSignal?.removeEventListener("abort", abort); }
      },
    });
    return handle;
  }

  private registerTools() {
    const definitions: ToolDefinition[] = [
      this.investigationDefinition("osint-unit.investigate-domain", "Investigate one exact domain through fixed passive domain and web-discovery policy paths.", objectSchema({ domain: { ...SIMPLE_TEXT, maxLength: 253 }, objective: OBJECTIVE }, ["domain"]), (args) => this.runInvestigation("osint-unit.investigate-domain", { type: "domain", value: normalizeDomain(String(args.domain)), label: normalizeDomain(String(args.domain)), attributes: {}, source: { kind: "agent", id: "active-unit" } }, ["opensquat-local", "searxng"], objective(args.objective, "Passive domain investigation."))),
      this.investigationDefinition("osint-unit.investigate-ip", "Investigate one exact IP address through fixed passive infrastructure intelligence paths.", objectSchema({ ipAddress: SIMPLE_TEXT, objective: OBJECTIVE }, ["ipAddress"]), (args) => { const ip = String(args.ipAddress).trim(); if (!isIP(ip)) throw new Error("A valid IPv4 or IPv6 address is required."); return this.runInvestigation("osint-unit.investigate-ip", { type: "ip-address", value: ip, label: ip, attributes: {}, source: { kind: "agent", id: "active-unit" } }, ["shodan", "censys"], objective(args.objective, "Passive IP investigation.")); }),
      this.investigationDefinition("osint-unit.investigate-username", "Investigate one exact username through a fixed passive web-discovery policy path.", objectSchema({ username: SIMPLE_TEXT, objective: OBJECTIVE }, ["username"]), (args) => { const value = normalizeUsername(String(args.username)); return this.runInvestigation("osint-unit.investigate-username", { type: "username", value, label: value, attributes: {}, source: { kind: "agent", id: "active-unit" } }, ["searxng"], objective(args.objective, "Passive username investigation.")); }),
      this.investigationDefinition("osint-unit.investigate-organization", "Investigate one exact organization name through a fixed passive web-discovery policy path.", objectSchema({ organization: SIMPLE_TEXT, objective: OBJECTIVE }, ["organization"]), (args) => { const value = normalizeOrganization(String(args.organization)); return this.runInvestigation("osint-unit.investigate-organization", { type: "organization", value, label: value, attributes: {}, source: { kind: "agent", id: "active-unit" } }, ["searxng"], objective(args.objective, "Passive organization investigation.")); }),
      this.investigationDefinition("osint-unit.investigate-infrastructure", "Investigate an exact domain or IP through fixed passive Shodan and Censys intelligence paths.", objectSchema({ targetType: { type: "string", enum: ["domain", "ip-address"] }, target: SIMPLE_TEXT, objective: OBJECTIVE }, ["targetType", "target"]), (args) => { const type = String(args.targetType) as "domain" | "ip-address"; const value = type === "domain" ? normalizeDomain(String(args.target)) : String(args.target).trim(); if (type === "ip-address" && !isIP(value)) throw new Error("A valid IP address is required."); return this.runInvestigation("osint-unit.investigate-infrastructure", { type, value, label: value, attributes: {}, source: { kind: "agent", id: "active-unit" } }, ["shodan", "censys"], objective(args.objective, "Passive infrastructure investigation.")); }),
      this.investigationDefinition("osint-unit.authorized-exposure-check", "Run one exact exposure check only after a separate one-time operator authorization exists for that target.", objectSchema({ targetType: { type: "string", enum: ["email-address", "domain"] }, exactTarget: SIMPLE_TEXT }, ["targetType", "exactTarget"]), (args) => this.runExposure(String(args.targetType) as "email-address" | "domain", String(args.exactTarget))),
      this.investigationDefinition("osint-unit.investigate-hunter-event", "Investigate one exact current Hunter-Seeker observation while retaining its original observation identifier and provenance.", objectSchema({ observationId: { ...SIMPLE_TEXT, maxLength: 160 }, objective: OBJECTIVE }, ["observationId"]), (args) => this.runHunterEvent(String(args.observationId), objective(args.objective, "Passive Hunter-Seeker event investigation."))),
      this.investigationDefinition("osint-unit.search-passive-web-sources", "Search configured passive web sources for one bounded exact query without allowing provider selection.", objectSchema({ query: SIMPLE_TEXT, objective: OBJECTIVE }, ["query"]), (args) => { const value = String(args.query).trim(); return this.runInvestigation("osint-unit.search-passive-web-sources", { type: "unknown", value, label: value, attributes: {}, source: { kind: "agent", id: "active-unit" } }, ["searxng"], objective(args.objective, "Bounded passive web discovery.")); }),
      this.localDefinition("osint-unit.expand-entity", "Evaluate one candidate entity for bounded expansion without executing it or contacting another provider.", objectSchema({ investigationId: { ...SIMPLE_TEXT, maxLength: 160 }, leadId: { ...SIMPLE_TEXT, maxLength: 160 } }, ["investigationId", "leadId"]), (args) => this.expandEntity(String(args.investigationId), String(args.leadId))),
      this.localDefinition("osint-unit.retrieve-evidence", "Retrieve cited evidence records from one known bounded OSINT investigation by exact identifiers.", objectSchema({ investigationId: { ...SIMPLE_TEXT, maxLength: 160 }, evidenceIds: { type: "array", minItems: 1, maxItems: 20, items: { ...SIMPLE_TEXT, maxLength: 160 } } }, ["investigationId", "evidenceIds"]), (args) => this.retrieveEvidence(String(args.investigationId), args.evidenceIds as string[])),
      this.localDefinition("osint-unit.explain-claim-or-confidence", "Explain one exact claim and confidence score using its supporting and contradicting evidence identifiers.", objectSchema({ investigationId: { ...SIMPLE_TEXT, maxLength: 160 }, claimId: { ...SIMPLE_TEXT, maxLength: 160 } }, ["investigationId", "claimId"]), (args) => this.explainClaim(String(args.investigationId), String(args.claimId))),
      this.localDefinition("osint-unit.list-candidate-leads", "List bounded unexecuted candidate leads from one known OSINT investigation with their evidence identifiers.", objectSchema({ investigationId: { ...SIMPLE_TEXT, maxLength: 160 }, limit: { type: "integer", minimum: 1, maximum: 50 } }, ["investigationId"]), (args) => this.listLeads(String(args.investigationId), typeof args.limit === "number" ? args.limit : 20)),
    ];
    definitions.forEach((definition) => this.unregister.push(this.registry.register(definition)));
  }

  private investigationDefinition(name: string, description: string, inputSchema: ToolDefinition["inputSchema"], handler: (args: Readonly<Record<string, unknown>>) => Promise<OsintUnitToolResult>): ToolDefinition {
    return { name, module: "osint-unit", description, inputSchema, rateLimit: { invocations: 12, windowMs: 60_000, maxConcurrent: 1 }, maxInputBytes: 8_192, maxOutputBytes: 512_000, tags: ["osint", "passive", "unit"], handler };
  }
  private localDefinition(name: string, description: string, inputSchema: ToolDefinition["inputSchema"], handler: (args: Readonly<Record<string, unknown>>) => Promise<OsintUnitToolResult> | OsintUnitToolResult): ToolDefinition { return this.investigationDefinition(name, description, inputSchema, async (args) => handler(args)); }

  private async callProvider(providerId: LiveOsintProviderId, body: Record<string, unknown>, investigationId: string) {
    const scope = executionScope.getStore(); if (!scope) throw new Error("OSINT provider execution requires a managed job context.");
    scope.job.checkpoint(); scope.job.consumeIteration(); scope.job.reportProgress({ current: 1, total: 4, message: `Querying fixed passive path ${providerId}` });
    return scope.job.externalCall((signal) => this.executeProvider(body, { investigationId, signal }));
  }

  private async runInvestigation(toolName: string, seed: InvestigationSeed, providerIds: LiveOsintProviderId[], purpose: string, options: { authorizationMode?: "public-research" | "exposure-check"; exposure?: ExposureApproval; hunterObservation?: HunterSeekerPublicObservation } = {}) {
    const createdAt = new Date().toISOString(); const investigationId = osintStableId("unit-inv", { toolName, seed, createdAt }); const results: NormalizedOsintProviderResult[] = []; const failures: string[] = [];
    for (const providerId of providerIds.slice(0, DEFAULT_INVESTIGATION_BUDGET.maximumProviders)) {
      try {
        const live = await this.callProvider(providerId, { providerId, targetType: seed.type, target: seed.value, objective: purpose, authorizationMode: options.authorizationMode ?? "public-research", ...(options.exposure ? { confirmed: true, exactTarget: options.exposure.exactTarget, authorizationStatement: options.exposure.statement } : {}) }, investigationId);
        results.push(live.result);
      } catch (error) { if (executionScope.getStore()?.job.signal.aborted) throw error; failures.push(`${providerId}: ${safeError(error)}`); }
    }
    const intake = options.hunterObservation ? createHunterOsintInvestigationDraft({ observation: options.hunterObservation }, { requestedAt: createdAt, requestedBy: { kind: "hunter-seeker", id: "active-unit-tool" }, objective: purpose }).intake : undefined;
    const descriptors = LIVE_OSINT_PROVIDER_DESCRIPTORS.filter(({ id }) => providerIds.includes(id as LiveOsintProviderId));
    const correlation = correlateOsintResults({ investigationId, providerResults: results, providers: descriptors, ...(intake ? { seedRecords: { entities: [intake.entity], evidence: [intake.evidence], observations: [intake.observation] } } : {}) });
    const evidenceBytes = correlation.evidence.reduce((sum, item) => sum + item.byteLength, 0);
    if (correlation.entities.length > DEFAULT_INVESTIGATION_BUDGET.maximumEntities || evidenceBytes > DEFAULT_INVESTIGATION_BUDGET.maximumEvidenceBytes) throw new Error("The fixed OSINT tool result exceeded the shared investigation budget.");
    const investigation = validateOsintContract("investigation", { schemaVersion: OSINT_SCHEMA_VERSION, id: investigationId, seed, objective: purpose, authorizationMode: options.authorizationMode ?? "public-research", status: results.length ? "completed" : "partial", budget: DEFAULT_INVESTIGATION_BUDGET, planId: osintStableId("unit-plan", { investigationId, providerIds }), counts: { providers: results.length, externalCalls: results.length, entities: correlation.entities.length, evidenceBytes, leads: correlation.leads.length }, warnings: failures, createdAt, updatedAt: new Date().toISOString(), completedAt: new Date().toISOString() });
    const record = { id: investigationId, toolName, objective: purpose, seed, investigation, correlation, providerIds: providerIds.slice(0, DEFAULT_INVESTIGATION_BUDGET.maximumProviders), failures, createdAt };
    this.investigations.set(investigationId, record); while (this.investigations.size > 100) this.investigations.delete(this.investigations.keys().next().value as string);
    const output = resultFromRecord(record); await this.rememberInvestigation?.({ id: investigationId, toolName, output }); return output;
  }

  private async runExposure(targetType: "email-address" | "domain", rawTarget: string) {
    const exactTarget = targetType === "domain" ? normalizeDomain(rawTarget) : rawTarget.trim().toLowerCase(); this.pruneApprovals(); const approval = this.approvals.get(`${targetType}:${exactTarget}`);
    if (!approval) return { ...emptyResult(), status: "approval-required" as const, tool: "osint-unit.authorized-exposure-check", summary: "No unexpired one-time operator authorization exists for this exact target.", coverageLimitations: ["Exposure checks require an explicit operator action in OSINT Provider Settings for the exact target."], nextAction: "Open OSINT Providers, select HIBP, enter the exact target and authorization statement, then choose AUTHORIZE NEXT UNIT CHECK." };
    this.approvals.delete(`${targetType}:${exactTarget}`);
    return this.runInvestigation("osint-unit.authorized-exposure-check", { type: targetType, value: exactTarget, label: exactTarget, attributes: {}, source: { kind: "operator", id: `one-time-approval:${approval.id}` } }, ["hibp"], "Explicitly authorized exact-target exposure check.", { authorizationMode: "exposure-check", exposure: approval });
  }

  private async runHunterEvent(observationId: string, purpose: string) { const observation = await this.resolveHunterObservation(observationId.trim()); if (!observation) throw new Error("The exact Hunter-Seeker observation is no longer available."); const draft = createHunterOsintInvestigationDraft({ observation }, { requestedAt: new Date().toISOString(), requestedBy: { kind: "hunter-seeker", id: "active-unit-tool" }, objective: purpose }); return this.runInvestigation("osint-unit.investigate-hunter-event", draft.seed, ["searxng"], purpose, { hunterObservation: observation }); }

  private requireRecord(id: string) { const record = this.investigations.get(id.trim()); if (!record) throw new Error("The bounded OSINT investigation is unknown or expired."); return record; }
  private expandEntity(investigationId: string, leadId: string): OsintUnitToolResult {
    const record = this.requireRecord(investigationId); const lead = record.correlation.leads.find((item) => item.id === leadId); if (!lead) throw new Error("The candidate lead does not belong to that investigation.");
    const evaluation = evaluateControlledExpansion({ investigation: record.investigation, leads: [lead], providers: LIVE_OSINT_PROVIDER_DESCRIPTORS, usage: { providerIds: record.providerIds, externalCalls: record.investigation.counts.externalCalls, runtimeMs: 0, entities: record.investigation.counts.entities, evidenceBytes: record.investigation.counts.evidenceBytes } }); const suggestion = evaluation.suggestions[0];
    const evidence = record.correlation.evidence.filter((item) => lead.discoveredByEvidenceIds.includes(item.id));
    return { ...emptyResult(), status: "candidate-awaiting-operator-approval", tool: "osint-unit.expand-entity", investigationId, summary: suggestion?.status === "eligible" ? "The entity is eligible for one bounded next step, but no provider was contacted." : `Expansion remains suppressed: ${suggestion?.suppressionReasons.join(" ") ?? "No eligible suggestion."}`, evidence: evidence.map(({ id, providerId, title, excerpt, sourceRef, retrievedAt, sensitivity }) => ({ id, providerId, title, excerpt: excerpt ?? "", sourceRef, retrievedAt, sensitivity })), candidateLeads: [{ id: lead.id, type: lead.seed.type, value: lead.seed.value, ...(lead.seed.label ? { label: lead.seed.label } : {}), reason: lead.reason, status: "candidate", evidenceIds: lead.discoveredByEvidenceIds }], citations: evidence.map(({ id, providerId, title }) => ({ evidenceId: id, marker: evidenceMarker(id), providerId, title })), coverageLimitations: ["A UNIT cannot approve its own expansion. Operator approval is required before any next provider request."], nextAction: "Review and approve the candidate through the controlled expansion interface." };
  }

  private retrieveEvidence(investigationId: string, evidenceIds: string[]): OsintUnitToolResult { const record = this.requireRecord(investigationId); const requested = new Set(evidenceIds); const evidence = record.correlation.evidence.filter((item) => requested.has(item.id)).slice(0, 20); if (!evidence.length) throw new Error("None of the requested evidence identifiers belong to that investigation."); return { ...emptyResult(), status: "completed", tool: "osint-unit.retrieve-evidence", investigationId, summary: `Retrieved ${evidence.length} exact evidence record(s).`, evidence: evidence.map(({ id, providerId, title, excerpt, sourceRef, retrievedAt, sensitivity }) => ({ id, providerId, title, excerpt: excerpt ?? "", sourceRef, retrievedAt, sensitivity })), citations: evidence.map(({ id, providerId, title }) => ({ evidenceId: id, marker: evidenceMarker(id), providerId, title })), coverageLimitations: ["Evidence retrieval is limited to the current bounded in-memory investigation set."] }; }

  private explainClaim(investigationId: string, claimId: string): OsintUnitToolResult { const record = this.requireRecord(investigationId); const claim = record.correlation.claims.find((item) => item.id === claimId); const conclusion = record.correlation.conclusions.find((item) => item.claimId === claimId); if (!claim || !conclusion) throw new Error("The exact claim is not available in that investigation."); const evidenceIds = new Set([...conclusion.supportingEvidenceIds, ...conclusion.contradictingEvidenceIds]); const evidence = record.correlation.evidence.filter((item) => evidenceIds.has(item.id)); return { ...emptyResult(), status: "completed", tool: "osint-unit.explain-claim-or-confidence", investigationId, summary: conclusion.statement, claims: [{ id: claim.id, statement: conclusion.statement, confidence: conclusion.confidence.score, confidenceCategory: conclusion.confidence.category, evidenceIds: [...evidenceIds], observationIds: conclusion.supportingObservationIds, explanation: conclusion.confidence.explanation }], evidence: evidence.map(({ id, providerId, title, excerpt, sourceRef, retrievedAt, sensitivity }) => ({ id, providerId, title, excerpt: excerpt ?? "", sourceRef, retrievedAt, sensitivity })), citations: evidence.map(({ id, providerId, title }) => ({ evidenceId: id, marker: evidenceMarker(id), providerId, title })), coverageLimitations: conclusion.coverageLimitations }; }

  private listLeads(investigationId: string, limit: number): OsintUnitToolResult { const record = this.requireRecord(investigationId); const leads = record.correlation.leads.slice(0, Math.max(1, Math.min(50, limit))); const evidenceIds = new Set(leads.flatMap((lead) => lead.discoveredByEvidenceIds)); const evidence = record.correlation.evidence.filter((item) => evidenceIds.has(item.id)); return { ...emptyResult(), status: "completed", tool: "osint-unit.list-candidate-leads", investigationId, summary: `${leads.length} candidate lead(s) listed; none were executed.`, candidateLeads: leads.map((lead) => ({ id: lead.id, type: lead.seed.type, value: lead.seed.value, ...(lead.seed.label ? { label: lead.seed.label } : {}), reason: lead.reason, status: "candidate", evidenceIds: lead.discoveredByEvidenceIds })), citations: evidence.map(({ id, providerId, title }) => ({ evidenceId: id, marker: evidenceMarker(id), providerId, title })), coverageLimitations: ["Candidate leads are unverified and cannot run automatically."] }; }
  private pruneApprovals(now = Date.now()) { for (const [key, approval] of this.approvals) if (Date.parse(approval.expiresAt) <= now) this.approvals.delete(key); }
}
