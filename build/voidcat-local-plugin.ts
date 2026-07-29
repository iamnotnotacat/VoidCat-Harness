import type { IncomingMessage, ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants as fsConstants, promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import Busboy from "busboy";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import type { Plugin, ViteDevServer } from "vite";
import { hunterSeekerService, type HunterSeekerPublicObservation } from "./hunter-seeker/hunter-seeker-service";
import { HunterHistoryStore } from "./hunter-seeker/hunter-history-store";
import { HunterReplayManager, HunterStageFiveStore, type TriggerEvent, type WatchlistKind } from "./hunter-seeker/hunter-stage-five";
import { HunterSeekerToolRuntime } from "./hunter-seeker/hunter-seeker-tools";
import { boundHunterToolResult, fitMessagesToContext, hunterToolAlias, hunterToolSystemBoundary, hunterToolsForModel, markUncitedHunterFindings, registryNameForHunterAlias, renderHunterEvidenceFallback, safeHunterCitationFailure, validateHunterCitations } from "./hunter-seeker/hunter-seeker-chat-tools";
import { JobManagerError, voidcatJobManager } from "./voidcat-job-manager";
import { StorageBudgetError, VoidCatStorageBudgetManager, storageWriteActivity, type StorageBudgetId } from "./voidcat-storage-budget-manager";
import { ToolRegistryError, voidcatToolRegistry, type DiscoveredTool, type ToolJsonSchema } from "./voidcat-tool-registry";
import { DEFAULT_INVESTIGATION_BUDGET, type InvestigationSeed, type OsintAuthorizationMode, type OsintLead } from "./osint/contracts";
import { evaluateOsintPolicy, type OsintInvestigationRequest } from "./osint/policy-and-planner";
import { LIVE_OSINT_PROVIDER_ADAPTERS, LIVE_OSINT_PROVIDER_DESCRIPTORS, generateOpenSquatStyleCandidates, normalizeLiveProviderResult, type LiveOsintProviderId } from "./osint/live-provider-adapters";
import { osintStableId } from "./osint/provider-contracts";
import { OsintStore, OsintStoreError } from "./osint/osint-store";
import { HunterOsintCandidateInbox, createHunterOsintInvestigationDraft, hunterRegionAroundPoint, submitOsintCandidateLeadToHunter } from "./osint/hunter-seeker-bridge";
import { OsintUnitToolRuntime } from "./osint/osint-unit-tools";
import { inferredOsintToolCall, markUncitedOsintConclusions, osintToolSystemBoundary, osintToolsForModel, registryNameForOsintAlias, renderOsintEvidenceFallback, validateOsintCitations } from "./osint/osint-unit-chat-tools";
import { OsintInvestigationWorkspace, renderStoredInvestigationReport, type OsintInvestigationWorkspaceInput } from "./osint/osint-investigation-workspace";
import { discoverWebSearchResults, fetchSelectedWebpages, type WebSearchHit } from "./voidcat-web";
import { newsCatalog, refreshNews } from "./voidcat-news";
import { describeOsintDirectoryEntry, searchOsintDirectory } from "../app/osint4all-links";
import {
  addMessage, beginRagFolderScan, cancelRagFolderScan, createConversation, createDocument, createProject, deleteConversation, deleteDocument, deleteMemory,
  deleteProfile, deleteRagFolder, finishRagFolderScan, getConversation, getFolderDocumentSource, getMemoryCandidates,
  exportActiveProject, getActiveProject, getActiveProjectId, getMemoryRecord, getRagCitation, getRagFolder, getRagVectorIndexStats, getSettings, getState, importProjectArchive, indexDocumentVectors,
  indexPendingRagVectors, listProjects, listRagFolders, listStaleFolderDocumentSources, registerRagFolder, saveMemory, saveProfile, saveSettings, selectProject,
  searchRagVectorIndex, setMemoryEmbedding, touchDocumentSource, updateConversation, updateDocument, updateRagFolder,
  updateProject, updateRagFolderScanProgress, upsertFolderDocument,
  type MemoryInput, type ProfileInput, type ProjectInput, type SettingsInput, type WebMode,
} from "./voidcat-database";

const execFileAsync = promisify(execFile);
const LMS_PATH = path.join(os.homedir(), ".lmstudio", "bin", "lms.exe");
const API_BASE = "http://127.0.0.1:1234";
const EMBEDDING_MODEL = "text-embedding-nomic-embed-text-v1.5";
const RAG_EXTENSIONS = new Set([".pdf", ".docx", ".txt", ".md"]);
const RAG_IGNORED_DIRECTORIES = new Set([".git", ".voidcat", "node_modules", "$recycle.bin", "system volume information"]);
const MAX_REGISTERED_FOLDER_FILES = 2_000;
const MAX_REGISTERED_FOLDER_DIRECTORIES = 5_000;
const MAX_REGISTERED_FOLDER_ENTRIES = 50_000;
const MAX_REGISTERED_FOLDER_SOURCE_BYTES = 10 * 1024 ** 3;
const MAX_FOLDER_ENUMERATION_MS = 60_000;
const MAX_RAG_CHUNKS_PER_DOCUMENT = 4_096;
const RAG_MEMORY_RESERVE_BYTES = 512 * 1024 * 1024;
const RAG_DISK_RESERVE_BYTES = 2 * 1024 ** 3;
const OSINT_BROKER_PORT = Number(process.env.VOIDCAT_OSINT_BROKER_PORT);
const OSINT_HUNTER_HANDOFF_TTL_MS = 30 * 60_000;
const OSINT_HUNTER_HANDOFF_LIMIT = 100;
const modelSearchCache = new Map<string, { at: number; results: unknown[] }>();
const modelFileCache = new Map<string, { at: number; results: unknown[] }>();
let lastModelSearchAt = 0;
let commandKnowledgeToolsRegistered = false;

function commandToolAlias(name: string) { return name.replace(/^voidcat\./, "voidcat_").replaceAll("-", "_"); }
function commandToolsForModel(tools: DiscoveredTool[]) { return tools.map((tool) => ({ type: "function" as const, function: { name: commandToolAlias(tool.name), description: tool.description, parameters: tool.inputSchema } })); }
function commandRegistryName(alias: string, tools: DiscoveredTool[]) { return tools.find((tool) => commandToolAlias(tool.name) === alias)?.name; }
function commandToolBoundary(tools: DiscoveredTool[]) { return ["VOIDCAT LOCAL KNOWLEDGE BOUNDARY:", "Only call the enabled functions below. Cite factual results with their supplied [VC:record-id] markers. Never invent a directory entry, memory, document passage, historical record, or news item.", "News Headlines is external and may only be used when that exact feature is enabled. Other tools read inspectable local stores.", ...tools.map((tool) => `- ${commandToolAlias(tool.name)}: ${tool.description}`)].join("\n"); }

function registerCommandKnowledgeTools() {
  if (commandKnowledgeToolsRegistered) return;
  const textQuery = { type: "object", properties: { query: { type: "string", minLength: 2, maxLength: 500 } }, required: ["query"], additionalProperties: false } satisfies ToolJsonSchema;
  voidcatToolRegistry.register({ name: "voidcat.search-project-memory", module: "voidcat-knowledge", description: "Search approved memories in the active project by relevance and importance.", inputSchema: textQuery, rateLimit: { invocations: 30, windowMs: 60_000, maxConcurrent: 1 }, tags: ["local", "read-only", "project-scoped"], handler: async (args) => { const results = await searchMemories(String(args.query)); return { scope: getActiveProjectId(), results: results.slice(0, 8).map((item) => ({ ...item, citation: `[VC:${item.id}]` })), citations: results.slice(0, 8).map((item) => item.id), limitations: ["Only explicit enabled memories in the active project are searched."] }; } });
  voidcatToolRegistry.register({ name: "voidcat.search-rag-library", module: "voidcat-knowledge", description: "Search the local RAG vector index for relevant document passages and source paths.", inputSchema: textQuery, rateLimit: { invocations: 20, windowMs: 60_000, maxConcurrent: 1 }, tags: ["local", "read-only", "rag"], handler: async (args) => { const results = await searchDocuments(String(args.query)); return { results: results.map((item) => ({ ...item, citation: `[VC:${item.id}]` })), citations: results.map((item) => item.id), limitations: ["Only enabled indexed documents are searched; missing passages are not evidence of absence."] }; } });
  voidcatToolRegistry.register({ name: "voidcat.search-hunter-history", module: "voidcat-knowledge", description: "Search opt-in Hunter-Seeker summaries and derived events, cross-referenced with selected RAG libraries.", inputSchema: textQuery, rateLimit: { invocations: 12, windowMs: 60_000, maxConcurrent: 1 }, tags: ["local", "read-only", "historical"], handler: async (args) => { const value = await searchHistory(String(args.query)); const historical = value.historical.map((item) => ({ ...item, citation: `[VC:${item.id}]` })); const documents = value.documents.map((item) => ({ ...item, citation: `[VC:${item.id}]` })); return { ...value, historical, documents, citations: [...historical, ...documents].map((item) => item.id) }; } });
  voidcatToolRegistry.register({ name: "voidcat.search-osint-directory", module: "voidcat-knowledge", description: "Search the captured OSINT4ALL directory locally by tool name, category, description, or hostname.", inputSchema: textQuery, rateLimit: { invocations: 60, windowMs: 60_000, maxConcurrent: 2 }, tags: ["local", "read-only", "directory"], handler: (args) => { const results = searchOsintDirectory(String(args.query), 20).map((entry) => ({ ...entry, description: describeOsintDirectoryEntry(entry), citation: `[VC:${entry.id}]` })); return { results, citations: results.map((item) => item.id), limitations: ["Directory entries are discovery links, not validated evidence about a target."] }; } });
  voidcatToolRegistry.register({ name: "voidcat.news-headlines", module: "voidcat-knowledge", description: "Pull or reuse bounded cached headlines from operator-selected fixed RSS sources; this is an external request.", inputSchema: { type: "object", properties: { sourceIds: { type: "array", minItems: 1, maxItems: 5, items: { type: "string", enum: newsCatalog().map(({ id }) => id) } } }, required: ["sourceIds"], additionalProperties: false }, rateLimit: { invocations: 6, windowMs: 10 * 60_000, maxConcurrent: 1 }, tags: ["external", "read-only", "news"], handler: async (args, context) => { context.reportCost({ units: 1 }); const value = await refreshNews(args.sourceIds as string[]); return { ...value, items: value.items.slice(0, 50).map((item) => ({ ...item, citation: `[VC:${item.id}]` })), citations: value.items.slice(0, 50).map((item) => item.id), limitations: ["Headlines are unverified publisher summaries and may be incomplete, delayed, duplicated, or unavailable."] }; } });
  commandKnowledgeToolsRegistered = true;
}

type LiveCandidateSource = { providerId: LiveOsintProviderId; createdAt: string; leads: OsintLead[] };
const liveCandidateSources = new Map<string, LiveCandidateSource>();
const hunterOsintCandidateInbox = new HunterOsintCandidateInbox(OSINT_HUNTER_HANDOFF_LIMIT);

function pruneLiveCandidateSources(nowMs = Date.now()) {
  for (const [id, entry] of liveCandidateSources) if (nowMs - Date.parse(entry.createdAt) > OSINT_HUNTER_HANDOFF_TTL_MS) liveCandidateSources.delete(id);
  while (liveCandidateSources.size > OSINT_HUNTER_HANDOFF_LIMIT) liveCandidateSources.delete(liveCandidateSources.keys().next().value as string);
}

function rememberLiveCandidateSource(investigationId: string, providerId: LiveOsintProviderId, createdAt: string, leads: readonly OsintLead[]) {
  if (providerId === "hibp" || !leads.length) return;
  pruneLiveCandidateSources();
  liveCandidateSources.delete(investigationId);
  liveCandidateSources.set(investigationId, { providerId, createdAt, leads: leads.map((lead) => structuredClone(lead)) });
  pruneLiveCandidateSources();
}

async function osintBrokerRequest(route: "/status" | "/query", init: RequestInit = {}) {
  const token = process.env.VOIDCAT_DESKTOP_TOKEN;
  if (!token || !Number.isInteger(OSINT_BROKER_PORT) || OSINT_BROKER_PORT < 1 || OSINT_BROKER_PORT > 65_535) throw new Error("The protected OSINT provider broker is unavailable. Restart the desktop app.");
  const response = await fetch(`http://127.0.0.1:${OSINT_BROKER_PORT}${route}`, { ...init, redirect: "error", signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000), headers: { "X-VoidCat-Desktop-Token": token, ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) } });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "The protected OSINT provider broker rejected the request.");
  return result;
}

function liveProviderId(value: unknown): LiveOsintProviderId {
  if (typeof value !== "string" || !LIVE_OSINT_PROVIDER_DESCRIPTORS.some(({ id }) => id === value)) throw new Error("A registered live OSINT provider is required.");
  return value as LiveOsintProviderId;
}

function exactGeographicBounds(value: string) {
  const [south, west, north, east, ...extra] = value.split(",").map((part) => Number(part.trim()));
  if (extra.length || ![south, west, north, east].every(Number.isFinite) || south < -90 || north > 90 || west < -180 || east > 180 || south > north || west > east) throw new Error("The passive geographic lookup requires exact south, west, north, east bounds.");
  return { south, west, north, east };
}

async function runLiveProviderQuery(body: Record<string, unknown>, options: { investigationId?: string; signal?: AbortSignal } = {}) {
  if (options.signal?.aborted) throw options.signal.reason;
  const providerId = liveProviderId(body.providerId);
  const adapter = LIVE_OSINT_PROVIDER_ADAPTERS.find((candidate) => candidate.descriptor.id === providerId)!;
  const targetType = body.targetType;
  const target = typeof body.target === "string" ? body.target.trim() : "";
  const authorizationMode = body.authorizationMode as OsintAuthorizationMode;
  if (!adapter.descriptor.capabilities.some((item) => item.seedTypes.includes(targetType as never))) throw new Error(`${adapter.descriptor.displayName} does not support this target type.`);
  const seed: InvestigationSeed = { type: targetType as InvestigationSeed["type"], value: target, attributes: {}, source: { kind: "operator", id: "voidcat-osint-interface" } };
  const request: OsintInvestigationRequest = {
    seed, objective: typeof body.objective === "string" && body.objective.trim() ? body.objective.trim() : `Passive exact-target lookup for ${targetType}.`, authorizationMode,
    requestedProviderIds: [providerId],
    ...(providerId === "hibp" ? { requestedCapabilityIds: ["authorized-exposure-check" as const] } : {}),
    ...(providerId === "hibp" && body.confirmed === true ? { exposureConfirmation: { confirmed: true, exactTarget: typeof body.exactTarget === "string" ? body.exactTarget : "", statement: typeof body.authorizationStatement === "string" ? body.authorizationStatement : "" } } : {}),
  };
  const now = new Date().toISOString();
  const policy = evaluateOsintPolicy(request, [adapter.descriptor], now);
  const investigationId = options.investigationId && /^[a-z0-9][a-z0-9_-]{7,159}$/i.test(options.investigationId) ? options.investigationId : osintStableId("inv", { providerId, targetType, target, evaluatedAt: now });
  await queueOsintStoreWrite((store) => store.appendDecisionLog({
    investigationId,
    decisionType: "live-provider-policy",
    decisionId: policy.id,
    outcome: policy.outcome,
    createdAt: policy.evaluatedAt,
    detail: { providerId, targetType, authorizationMode, reasons: policy.reasons, requiresOperatorConfirmation: policy.requiresOperatorConfirmation },
  }));
  if (policy.outcome !== "allow") throw new Error(policy.reasons.join(" ") || "The provider policy did not authorize this request.");
  const queries = adapter.plan(seed, { investigationId, objective: request.objective, authorizationMode, budget: DEFAULT_INVESTIGATION_BUDGET });
  const query = queries[0]; if (!query) throw new Error("The provider did not produce a bounded exact-target query.");
  const startedAt = Date.now();
  try {
    let raw: unknown; let cache: { status: "live" | "cached" | "fixture"; ageMs: number; expiresAt?: string } = { status: "live", ageMs: 0 };
    if (providerId === "opensquat-local") raw = generateOpenSquatStyleCandidates(target);
    else if (providerId === "deflock") {
      const bounds = exactGeographicBounds(target);
      const snapshot = await hunterSeekerService.setDeflockViewport({ ...bounds, zoom: 10 }, { refresh: true });
      raw = snapshot.observations.filter((observation) => observation.provenance.sourceFeedId === "deflock.osm-alpr"
        && observation.position.latitude >= bounds.south && observation.position.latitude <= bounds.north
        && observation.position.longitude >= bounds.west && observation.position.longitude <= bounds.east);
    }
    else {
      const broker = await osintBrokerRequest("/query", { method: "POST", body: JSON.stringify({ providerId, operation: query.operation, targetType, target, authorizationMode, confirmed: body.confirmed === true, exactTarget: body.exactTarget }), signal: options.signal });
      raw = broker.data;
      const brokerCache = broker.cache as { status?: unknown; ageMs?: unknown; expiresAt?: unknown } | undefined;
      cache = { status: brokerCache?.status === "cached" ? "cached" : "live", ageMs: typeof brokerCache?.ageMs === "number" ? brokerCache.ageMs : 0, ...(typeof brokerCache?.expiresAt === "string" ? { expiresAt: brokerCache.expiresAt } : {}) };
    }
    if (options.signal?.aborted) throw options.signal.reason;
    const result = normalizeLiveProviderResult(providerId, raw, { investigationId, query, provider: adapter.descriptor, retrievedAt: now, budget: DEFAULT_INVESTIGATION_BUDGET, cache });
    const expiresAt = cache.expiresAt ?? new Date(Date.parse(now) + adapter.descriptor.cache.ttlMs).toISOString();
    await queueOsintStoreWrite(async (store) => {
      await store.putProviderCache({ cacheKey: query.cacheKey, providerId, queryId: query.id, storedAt: now, expiresAt, sourceRetrievedAt: now, result, provenance: { provider: adapter.descriptor.attribution.provider, sourceRefs: [adapter.descriptor.attribution.documentationUrl], ...(adapter.descriptor.attribution.termsUrl ? { termsUrl: adapter.descriptor.attribution.termsUrl } : {}) } });
      await store.putRateLimitState({ providerId, windowStartedAt: now, used: cache.status === "live" && adapter.descriptor.transport !== "local" ? 1 : 0, limit: adapter.descriptor.rateLimit.requests, resetAt: new Date(Date.parse(now) + adapter.descriptor.rateLimit.windowMs).toISOString(), updatedAt: new Date().toISOString() });
      await store.appendInvocationLog({ investigationId, providerId, action: query.operation, status: "completed", startedAt: now, completedAt: new Date().toISOString(), durationMs: Math.max(0, Date.now() - startedAt), externalCalls: adapter.descriptor.transport === "local" || cache.status === "cached" ? 0 : 1, requestCost: 0, cacheStatus: cache.status, metadata: { queryId: query.id, targetType } });
    });
    rememberLiveCandidateSource(investigationId, providerId, now, result.leads);
    return { investigationId, policy, query: { id: query.id, providerId: query.providerId, capabilityId: query.capabilityId, operation: query.operation }, result, hunterForwarding: providerId === "hibp" ? "blocked-pending-approval" : "not-sensitive" };
  } catch (error) {
    try {
      await queueOsintStoreWrite((store) => store.appendInvocationLog({ investigationId, providerId, action: query.operation, status: "failed", startedAt: now, completedAt: new Date().toISOString(), durationMs: Math.max(0, Date.now() - startedAt), externalCalls: adapter.descriptor.transport === "local" ? 0 : 1, requestCost: 0, errorCode: error instanceof OsintStoreError ? error.code : "PROVIDER_QUERY_FAILED", metadata: { queryId: query.id, targetType } }));
    } catch { /* the original provider/storage error remains authoritative */ }
    throw error;
  }
}

type LmsModel = {
  type: "llm" | "embedding";
  modelKey: string;
  displayName: string;
  publisher: string;
  path: string;
  sizeBytes: number;
  paramsString?: string;
  architecture?: string;
  quantization?: { name?: string; bits?: number };
  vision?: boolean;
  trainedForToolUse?: boolean;
  maxContextLength?: number;
};

type RegisteredFolder = {
  id: string;
  name: string;
  path: string;
  recursive: boolean;
  enabled: boolean;
};

type FolderScanJob = {
  controller: AbortController;
  startedAt: string;
};

const folderScanJobs = new Map<string, FolderScanJob>();
const storageBudgetManager = new VoidCatStorageBudgetManager({
  initialConfigs: getSettings().storageBudgetSettings,
  activitySnapshot: () => storageWriteActivity.snapshot(),
});
storageWriteActivity.subscribe(() => storageBudgetManager.notifyActivityChanged());
let osintStore: OsintStore | null = null;
let osintStoreReady: Promise<OsintStore> | null = null;
let osintStoreWriteQueue = Promise.resolve();

async function ensureOsintStore() {
  if (osintStoreReady) return osintStoreReady;
  const candidate = new OsintStore({
    dataRoot: path.join(process.cwd(), ".voidcat", "data"),
    mode: "production",
    writeGuard: async (estimatedBytes, signal) => storageBudgetManager.ensureWriteAllowed("osint-investigations", estimatedBytes, signal),
  });
  osintStoreReady = candidate.initialize().then(() => {
    osintStore = candidate;
    return candidate;
  }).catch((error) => {
    candidate.close();
    osintStore = null;
    osintStoreReady = null;
    throw error;
  });
  return osintStoreReady;
}

function queueOsintStoreWrite<T>(operation: (store: OsintStore) => Promise<T>) {
  const queued = osintStoreWriteQueue.then(async () => operation(await ensureOsintStore()));
  osintStoreWriteQueue = queued.then(() => undefined, () => undefined);
  return queued;
}
const osintInvestigationWorkspace = new OsintInvestigationWorkspace({ executeProvider: runLiveProviderQuery, store: ensureOsintStore, project: () => { const project = getActiveProject() as { id: string; osintMemoryLimitBytes: number } | null; return project ?? { id: "default", osintMemoryLimitBytes: 1024 * 1024 ** 2 }; } });
const hunterHistoryStore = new HunterHistoryStore({
  ensureWriteAllowed: (estimatedBytes) => storageBudgetManager.ensureWriteAllowed("hunter-observations", estimatedBytes).then(() => undefined),
});
const hunterStageFiveStore = new HunterStageFiveStore({
  databasePath: hunterHistoryStore.databasePath,
  ensureWriteAllowed: (estimatedBytes) => storageBudgetManager.ensureWriteAllowed("hunter-observations", estimatedBytes).then(() => undefined),
});
const hunterReplayManager = new HunterReplayManager({
  replayRoot: hunterHistoryStore.replayRoot,
  ensureWriteAllowed: (estimatedBytes) => storageBudgetManager.ensureWriteAllowed("hunter-observations", estimatedBytes).then(() => undefined),
});
const hunterTriggerListeners = new Set<(events: TriggerEvent[]) => void>();
let hunterHistoryWriteQueue = Promise.resolve();
let hunterHistoryLastError: string | null = null;

function enqueueHistoricalObservations(observations: readonly HunterSeekerPublicObservation[]) {
  if (!observations.length) return;
  const snapshot = observations.map((observation) => structuredClone(observation));
  hunterHistoryWriteQueue = hunterHistoryWriteQueue.then(async () => {
    await ensureHunterStageReady();
    await withStorageWrite("hunter", async () => {
      if (getSettings().hunterHistory.enabled) await hunterHistoryStore.ingest(snapshot);
      await hunterReplayManager.capture(snapshot);
      const triggered = await hunterStageFiveStore.evaluate(snapshot);
      if (getSettings().hunterHistory.enabled) triggered.protectedObservationIds.forEach((observationId) => hunterHistoryStore.protectObservation(observationId, "trigger"));
      if (triggered.events.length) for (const listener of hunterTriggerListeners) { try { listener(structuredClone(triggered.events)); } catch { /* notification listeners cannot interrupt feeds */ } }
    });
    hunterHistoryLastError = null;
  }).catch((error) => {
    hunterHistoryLastError = error instanceof Error ? error.message : "Hunter persistence processing failed safely.";
  });
}

hunterSeekerService.subscribeObservations((_sourceId, observations) => enqueueHistoricalObservations(observations));
let hunterStageReadyPromise: Promise<void> | null = null;
function ensureHunterStageReady() {
  if (!hunterStageReadyPromise) hunterStageReadyPromise = (async () => {
    await hunterHistoryStore.initialize();
    if (getSettings().hunterHistory.enabled) await hunterHistoryStore.enable();
    await hunterStageFiveStore.initialize();
  })().catch((error) => {
    hunterHistoryLastError = error instanceof Error ? error.message : "Hunter storage could not be initialized.";
    hunterStageReadyPromise = null;
    throw error;
  });
  return hunterStageReadyPromise;
}

async function withStorageWrite<T>(kind: "hunter" | "rag", operation: () => T | Promise<T>) {
  const finish = storageWriteActivity.begin(kind);
  try { return await operation(); } finally { finish(); }
}
let embeddingReady = false;
let embeddingLoadPromise: Promise<void> | null = null;
let embeddingUnloadPromise: Promise<void> | null = null;
let activeEmbeddingUsers = 0;

async function runLms(args: string[], timeout = 120_000) {
  const result = await execFileAsync(LMS_PATH, args, {
    cwd: path.dirname(LMS_PATH), timeout, windowsHide: true, maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function lmsJson<T>(args: string[], timeout?: number): Promise<T> {
  const output = await runLms(args, timeout);
  return JSON.parse(output || "[]") as T;
}

function classify(model: LmsModel) {
  const value = `${model.modelKey} ${model.displayName}`.toLowerCase();
  if (model.type === "embedding") return "embedding";
  if (value.includes("coder") || value.includes("coding")) return "code";
  if (value.includes("reason") || value.includes("r1") || value.includes("think")) return "reasoning";
  return "chat";
}

async function scanModels() {
  const entries = await lmsJson<LmsModel[]>(["ls", "--json"]);
  const external = await readExternalModelCatalog();
  const knownSignatures = new Set(entries.map((model) => `${model.sizeBytes}:${path.basename(model.path).toLowerCase()}`));
  const externalModels = external.models.filter((model) => !knownSignatures.has(`${model.sizeBytes}:${path.basename(model.path).toLowerCase()}`)).map((model) => externalCatalogModel(model));
  return {
    models: [...entries.map((model) => ({
      id: model.modelKey,
      modelKey: model.modelKey,
      name: model.displayName,
      publisher: model.publisher,
      path: model.path,
      sizeBytes: model.sizeBytes,
      size: `${(model.sizeBytes / 1024 ** 3).toFixed(model.sizeBytes > 10 * 1024 ** 3 ? 1 : 2)} GB`,
      quantization: model.quantization?.name ?? "GGUF",
      kind: classify(model),
      vision: Boolean(model.vision),
      toolUse: Boolean(model.trainedForToolUse),
      parameters: model.paramsString ?? "—",
      architecture: model.architecture ?? "unknown",
      maxContextLength: model.maxContextLength ?? 8192,
      status: "ready",
    })), ...externalModels],
    scannedAt: new Date().toISOString(),
    roots: [...new Set([path.join(os.homedir(), ".lmstudio", "hub", "models"), ...external.roots])],
  };
}

type ExternalModelRecord = { path: string; sizeBytes: number; modifiedAt?: string; root?: string };
async function readExternalModelCatalog(): Promise<{ roots: string[]; models: ExternalModelRecord[] }> {
  try {
    const parsedCatalogs = await Promise.all(["model-library-catalog.json", "model-download-catalog.json"].map(async (name) => { try { return JSON.parse(await fs.readFile(path.join(process.cwd(), ".voidcat", name), "utf8")) as Record<string, unknown>; } catch { return {}; } }));
    const models = parsedCatalogs.flatMap((parsed) => Array.isArray(parsed.models) ? parsed.models : []).filter((value): value is ExternalModelRecord => { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const model = value as ExternalModelRecord; const shard = typeof model.path === "string" ? model.path.match(/-(\d{5})-of-\d{5}\.gguf$/i) : null; return typeof model.path === "string" && path.isAbsolute(model.path) && Number.isFinite(model.sizeBytes) && model.path.toLowerCase().endsWith(".gguf") && (!shard || shard[1] === "00001"); }).slice(0, 5_000);
    const roots = parsedCatalogs.flatMap((parsed) => Array.isArray(parsed.roots) ? parsed.roots : []).filter((value): value is string => typeof value === "string" && path.isAbsolute(value)).slice(0, 64);
    return { roots: [...new Set(roots)], models: [...new Map(models.map((model) => [path.resolve(model.path).toLowerCase(), model])).values()] };
  } catch { return { roots: [], models: [] }; }
}

function externalModelKey(filePath: string) { return `external:${createHash("sha256").update(path.resolve(filePath).toLowerCase()).digest("hex").slice(0, 24)}`; }
function inferredQuantization(name: string) { return name.match(/(?:^|[-_.])(IQ\d(?:_[A-Z0-9]+)?|Q\d(?:_[A-Z0-9]+)?|F16|F32)(?:[-_.]|$)/i)?.[1]?.toUpperCase() ?? "GGUF"; }
function externalCatalogModel(model: ExternalModelRecord) {
  const stem = path.basename(model.path, path.extname(model.path)); const kind = classify({ type: "llm", modelKey: stem, displayName: stem, publisher: "LOCAL DISCOVERY", path: model.path, sizeBytes: model.sizeBytes });
  return { id: externalModelKey(model.path), modelKey: externalModelKey(model.path), name: stem.replaceAll(/[-_]+/g, " "), publisher: "LOCAL DISCOVERY", path: model.path, sizeBytes: model.sizeBytes, size: `${(model.sizeBytes / 1024 ** 3).toFixed(model.sizeBytes > 10 * 1024 ** 3 ? 1 : 2)} GB`, quantization: inferredQuantization(stem), kind, vision: /(?:vision|vl|mmproj)/i.test(stem), toolUse: /(?:instruct|tool|function)/i.test(stem), parameters: stem.match(/\b\d+(?:\.\d+)?[bm]\b/i)?.[0]?.toUpperCase() ?? "—", architecture: "gguf", maxContextLength: 8192, status: "discovered", external: true };
}

async function resolveLoadableModelKey(requestedKey: string) {
  if (!requestedKey.startsWith("external:")) return requestedKey;
  const catalog = await readExternalModelCatalog(); const record = catalog.models.find((model) => externalModelKey(model.path) === requestedKey);
  if (!record) throw new Error("This discovered UNIT is no longer present in the protected scan catalog. Run a targeted scan again.");
  const stat = await fs.stat(record.path); if (!stat.isFile() || stat.size !== record.sizeBytes) throw new Error("The discovered UNIT changed after it was scanned. Run the scan again before loading it.");
  const before = await lmsJson<LmsModel[]>(["ls", "--json"]); const basename = path.basename(record.path).toLowerCase();
  const existing = before.find((model) => model.sizeBytes === record.sizeBytes && path.basename(model.path).toLowerCase() === basename); if (existing) return existing.modelKey;
  const repository = `voidcat-local/${path.basename(record.path, path.extname(record.path)).toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "discovered-unit"}`;
  let lastError: unknown;
  for (const linkFlag of ["--symbolic-link", "--hard-link"]) {
    try { await runLms(["import", record.path, "--yes", linkFlag, "--user-repo", repository], 5 * 60_000); lastError = null; break; }
    catch (error) { lastError = error; }
  }
  if (lastError) throw new Error("VoidCat found this GGUF but could not register a non-copying link with the local runtime. Choose a model folder on the same drive as LM Studio or enable Windows Developer Mode for symbolic links.");
  const after = await lmsJson<LmsModel[]>(["ls", "--json"]); const added = after.find((model) => !before.some((previous) => previous.modelKey === model.modelKey)) ?? after.find((model) => model.sizeBytes === record.sizeBytes && path.basename(model.path).toLowerCase() === basename);
  if (!added) throw new Error("The local runtime accepted the GGUF link but did not publish it to the UNIT catalog.");
  return added.modelKey;
}

async function readBody(request: IncomingMessage, maxBytes = 1_000_000) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("The local request exceeded the 1 MB safety limit.");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

function sendJson(response: ServerResponse, status: number, data: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(data));
}

async function runtimeStatus(timeout = 120_000) {
  try {
    const loaded = await lmsJson<Array<Record<string, unknown>>>(["ps", "--json"], timeout);
    return { online: loaded.length > 0, loaded, error: null as string | null };
  } catch (error) {
    return { online: false, loaded: [], error: error instanceof Error ? error.message : "UNIT runtime status failed." };
  }
}

async function ensureApiServer() {
  try {
    await fetch(`${API_BASE}/v1/models`, { signal: AbortSignal.timeout(1_000) });
  } catch {
    try { await runLms(["server", "start", "--port", "1234", "--bind", "127.0.0.1"], 30_000); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes("already")) throw error;
    }
  }
}

async function ensureEmbeddingModel() {
  if (embeddingUnloadPromise) await embeddingUnloadPromise;
  if (embeddingReady) return;
  if (!embeddingLoadPromise) {
    embeddingLoadPromise = (async () => {
      await ensureApiServer();
      const status = await runtimeStatus();
      if (!status.loaded.some((entry) => entry.identifier === "voidcat-embed")) {
        await runLms(["load", EMBEDDING_MODEL, "--yes", "--identifier", "voidcat-embed", "--context-length", "2048"], 5 * 60_000);
      }
      embeddingReady = true;
    })();
  }
  try { await embeddingLoadPromise; } finally { embeddingLoadPromise = null; }
}

async function releaseEmbeddingModelIfIdle() {
  if (!embeddingReady || activeEmbeddingUsers > 0 || embeddingUnloadPromise) return;
  embeddingReady = false;
  embeddingUnloadPromise = runLms(["unload", "voidcat-embed"], 120_000).then(() => undefined).catch(() => undefined);
  try { await embeddingUnloadPromise; } finally { embeddingUnloadPromise = null; }
}

async function embedTexts(texts: string[], signal?: AbortSignal) {
  activeEmbeddingUsers += 1;
  try {
    await ensureEmbeddingModel();
    const embeddings: number[][] = [];
    for (let index = 0; index < texts.length; index += 16) {
      if (signal?.aborted) throw abortedError();
      const batch = texts.slice(index, index + 16);
      const timeout = AbortSignal.timeout(5 * 60_000);
      const response = await fetch(`${API_BASE}/v1/embeddings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "voidcat-embed", input: batch }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!response.ok) throw new Error(`Embedding failed: ${await response.text()}`);
      const data = await response.json() as { data?: Array<{ index: number; embedding: number[] }> };
      const ordered = (data.data ?? []).sort((a, b) => a.index - b.index).map((item) => item.embedding);
      if (ordered.length !== batch.length) throw new Error("The embedding runtime returned an incomplete batch.");
      embeddings.push(...ordered);
    }
    return embeddings;
  } finally {
    activeEmbeddingUsers = Math.max(0, activeEmbeddingUsers - 1);
  }
}

function chunkText(input: string) {
  const normalized = input.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const paragraphs = normalized.split(/\n\n+/).filter(Boolean);
  const chunks: string[] = []; let current = "";
  for (const paragraph of paragraphs) {
    if (current.length + paragraph.length + 2 <= 1400) { current += `${current ? "\n\n" : ""}${paragraph}`; continue; }
    if (current) chunks.push(current);
    if (paragraph.length <= 1400) current = paragraph;
    else {
      for (let offset = 0; offset < paragraph.length; offset += 1200) chunks.push(paragraph.slice(offset, offset + 1400));
      current = "";
    }
  }
  if (current) chunks.push(current);
  return chunks.filter((chunk) => chunk.trim().length >= 20);
}

async function extractText(filename: string, buffer: Buffer) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".txt" || extension === ".md") return buffer.toString("utf8");
  if (extension === ".docx") return (await mammoth.extractRawText({ buffer })).value;
  if (extension === ".pdf") {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try { return (await parser.getText()).text; } finally { await parser.destroy(); }
  }
  throw new Error("Unsupported document format. Use PDF, DOCX, TXT, or Markdown.");
}

function readUpload(request: IncomingMessage) {
  return new Promise<{ filename: string; mimeType: string; buffer: Buffer }>((resolve, reject) => {
    let settled = false;
    try {
      const parser = Busboy({ headers: request.headers, limits: { files: 1, fields: 2 } });
      parser.on("file", (_field, stream, info) => {
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        stream.on("data", (chunk: Buffer) => {
          if (settled) return;
          receivedBytes += chunk.length;
          if (os.freemem() < RAG_MEMORY_RESERVE_BYTES + receivedBytes * 4) {
            settled = true;
            chunks.length = 0;
            reject(new Error("The document upload stopped to preserve a safe amount of free memory."));
            return;
          }
          chunks.push(chunk);
        });
        stream.on("end", () => { if (!settled) { settled = true; resolve({ filename: path.basename(info.filename), mimeType: info.mimeType, buffer: Buffer.concat(chunks) }); } });
      });
      parser.on("error", reject); parser.on("finish", () => { if (!settled) reject(new Error("No document was attached.")); });
      request.pipe(parser);
    } catch (error) { reject(error); }
  });
}

async function ingestDocument(request: IncomingMessage) {
  const finishStorageWrite = storageWriteActivity.begin("rag");
  try {
  const upload = await readUpload(request);
  const extension = path.extname(upload.filename).toLowerCase();
  if (![".pdf", ".docx", ".txt", ".md"].includes(extension)) throw new Error("Unsupported document format. Use PDF, DOCX, TXT, or Markdown.");
  ensureRagHeadroom(upload.buffer.length);
  const text = await extractText(upload.filename, upload.buffer);
  const chunks = chunkText(text);
  if (!chunks.length) throw new Error("No readable text was found in this document.");
  if (chunks.length > MAX_RAG_CHUNKS_PER_DOCUMENT) throw new Error(`This document produced more than ${MAX_RAG_CHUNKS_PER_DOCUMENT.toLocaleString()} passages. Split it into smaller documents before indexing.`);
  ensureRagHeadroom(upload.buffer.length, text.length * 2 + chunks.length * 4096 * 8);
  const estimatedStorageBytes = estimateRagStorageBytes(upload.buffer.length, text.length, chunks.length, true);
  await ensureRagDiskHeadroom(estimatedStorageBytes);
  const embeddings = await embedTexts(chunks);
  await ensureRagDiskHeadroom(estimatedStorageBytes);
  const documentId = randomUUID();
  const libraryDirectory = path.resolve(process.cwd(), ".voidcat", "library", "files");
  await fs.mkdir(libraryDirectory, { recursive: true });
  const storedPath = path.join(libraryDirectory, `${documentId}${extension}`);
  await fs.writeFile(storedPath, upload.buffer);
  let document: ReturnType<typeof createDocument>;
  try {
    document = createDocument({ id: documentId, name: upload.filename, extension, storedPath, sizeBytes: upload.buffer.length }, chunks.map((content, index) => ({ content, embedding: embeddings[index] })));
  } catch (error) {
    await fs.rm(storedPath, { force: true });
    throw error;
  }
  const indexedChunks = await indexDocumentCompletely(document.id);
  return { ...document, indexedChunks };
  } finally { finishStorageWrite(); }
}

function cosine(left: number[], right: number[]) {
  let dot = 0; let leftNorm = 0; let rightNorm = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) { dot += left[index] * right[index]; leftNorm += left[index] ** 2; rightNorm += right[index] ** 2; }
  return leftNorm && rightNorm ? dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)) : 0;
}

function abortedError() {
  const error = new Error("The folder scan was canceled safely.");
  error.name = "AbortError";
  return error;
}

async function yieldToEventLoop() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function indexDocumentCompletely(documentId: string, signal?: AbortSignal) {
  let indexedChunks = 0;
  while (true) {
    if (signal?.aborted) throw abortedError();
    const batch = indexDocumentVectors(documentId, { limit: 24 });
    indexedChunks += batch.indexed;
    if (!batch.batchFull || batch.scanned === 0) return indexedChunks;
    await yieldToEventLoop();
  }
}

async function searchDocuments(query: string) {
  const finishStorageWrite = storageWriteActivity.begin("rag");
  try {
  const stats = getRagVectorIndexStats();
  if (!stats.enabledChunks) return [];
  // Older library records are migrated incrementally, never in an unbounded
  // startup job. Newly added files are indexed completely during ingestion.
  for (let batchNumber = 0; batchNumber < 8; batchNumber += 1) {
    const batch = indexPendingRagVectors({ limit: 24 });
    if (!batch.batchFull || batch.scanned === 0) break;
    await yieldToEventLoop();
  }
  const [queryEmbedding] = await embedTexts([query]);
  return searchRagVectorIndex(queryEmbedding, { limit: 6, candidateLimit: 192, minScore: 0.2, probeRadius: 1 })
    .map(({ chunkId, ...result }) => ({ id: chunkId, ...result }));
  } finally { finishStorageWrite(); }
}

async function historyStatusSnapshot() {
  await ensureHunterStageReady();
  return { ...(await hunterHistoryStore.status()), error: hunterHistoryLastError };
}

let hunterHealthLastPersistAt = 0;
async function hunterSnapshotWithHistory(snapshot: Awaited<ReturnType<typeof hunterSeekerService.snapshot>>) {
  const history = await historyStatusSnapshot();
  if (Date.now() - hunterHealthLastPersistAt >= 5 * 60_000) {
    const maritimeHealth = maritimeBridgeData().healthSources.map((health) => ({
      sourceId: health.id, at: snapshot.generatedAt, status: health.status, errorRate: health.errorRate ?? 0,
      recordsPerHour: health.recordsPerHour ?? health.cachedObservations, expectedBaseline: health.expectedBaseline ?? 1,
      silentZero: health.silentZero ?? false, aiContextEligible: health.aiContextEligible ?? false, message: health.message,
    }));
    await withStorageWrite("hunter", () => hunterStageFiveStore.recordHealth([...snapshot.sources.map(({ descriptor, health }) => ({
      sourceId: descriptor.id, at: snapshot.generatedAt, status: health.status,
      errorRate: health.metrics.errorRate, recordsPerHour: health.metrics.recordsPerHour,
      expectedBaseline: health.metrics.expectedBaseline, silentZero: health.metrics.silentZero,
      aiContextEligible: health.metrics.aiContextEligible, message: health.message ?? "No source error.",
    })), ...maritimeHealth]));
    hunterHealthLastPersistAt = Date.now();
  }
  const watchlists = hunterStageFiveStore.listWatchlists(); const triggers = hunterStageFiveStore.listTriggers(100);
  return { ...snapshot, retention: history.enabled ? "live-and-history" : "memory-only", history, stageFive: {
    watchlistCount: watchlists.length, enabledWatchlistCount: watchlists.filter((rule) => rule.enabled).length,
    unacknowledgedTriggerCount: triggers.filter((event) => !event.acknowledged).length,
    activeReplay: hunterReplayManager.activeSnapshot(),
  } };
}

async function searchHistory(query: string) {
  const trimmed = query.trim().slice(0, 500);
  if (!trimmed) throw new Error("A historical question is required.");
  await ensureHunterStageReady();
  if (!hunterHistoryStore.isInitialized()) throw new Error("No historical records exist yet. Enable recording and allow live sources to publish first.");
  const finish = storageWriteActivity.begin("rag");
  try {
    await hunterHistoryStore.refreshRollingSummaries();
    const pending = hunterHistoryStore.listPendingRagRecords(24);
    if (pending.length) {
      const embeddings = await embedTexts(pending.map((record) => `${record.title}\n${record.content}`));
      await hunterHistoryStore.indexRagRecords(pending.map((record, index) => ({ id: record.id, embedding: embeddings[index] })));
    }
    const [queryEmbedding] = await embedTexts([trimmed]);
    const settings = getSettings().hunterHistory;
    const historical = hunterHistoryStore.search(queryEmbedding, 8);
    const documents = (!settings.selectedLibraryIds.length && !settings.includeUploads) ? [] : searchRagVectorIndex(queryEmbedding, {
      limit: 6, candidateLimit: 192, minScore: 0.2, probeRadius: 1,
      folderIds: settings.selectedLibraryIds,
      includeUploads: settings.includeUploads,
      onlyUploads: settings.includeUploads && settings.selectedLibraryIds.length === 0,
    }).map(({ chunkId, ...result }) => ({ id: chunkId, type: "document" as const, ...result }));
    return {
      query: trimmed,
      historical: historical.map((record) => ({ ...record, type: "history" as const, mode: "HISTORICAL" as const })),
      documents,
      coverage: {
        note: "History results cover only the period after opt-in recording was enabled. Missing records are not evidence that an event did not occur.",
        indexedRecordTypes: ["summary", "derived"],
        rawPositionsIndexed: false,
        selectedLibraryIds: settings.selectedLibraryIds,
        includeUploads: settings.includeUploads,
      },
    };
  } finally { finish(); }
}

function isInsideFolder(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function collectFolderFiles(root: string, recursive: boolean, signal: AbortSignal) {
  const files: string[] = [];
  const pendingDirectories = [root];
  const enumerationStartedAt = Date.now();
  let discoveredDirectories = 1;
  let discoveredEntries = 0;
  let totalSourceBytes = 0;
  while (pendingDirectories.length) {
    if (signal.aborted) throw abortedError();
    if (Date.now() - enumerationStartedAt > MAX_FOLDER_ENUMERATION_MS) throw new Error("Folder enumeration exceeded the 60 second safety budget. Register a smaller knowledge folder.");
    const current = pendingDirectories.shift()!;
    const realCurrent = await fs.realpath(current);
    if (!isInsideFolder(root, realCurrent)) continue;
    const directory = await fs.opendir(realCurrent);
    for await (const entry of directory) {
      if (signal.aborted) throw abortedError();
      if (Date.now() - enumerationStartedAt > MAX_FOLDER_ENUMERATION_MS) throw new Error("Folder enumeration exceeded the 60 second safety budget. Register a smaller knowledge folder.");
      discoveredEntries += 1;
      if (discoveredEntries > MAX_REGISTERED_FOLDER_ENTRIES) throw new Error(`This folder contains more than ${MAX_REGISTERED_FOLDER_ENTRIES.toLocaleString()} entries. Register a smaller knowledge folder.`);
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(realCurrent, entry.name);
      if (entry.isDirectory()) {
        if (recursive && !RAG_IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) {
          discoveredDirectories += 1;
          if (discoveredDirectories > MAX_REGISTERED_FOLDER_DIRECTORIES) throw new Error(`This folder contains more than ${MAX_REGISTERED_FOLDER_DIRECTORIES.toLocaleString()} directories. Register a smaller knowledge folder.`);
          pendingDirectories.push(entryPath);
        }
        continue;
      }
      if (!entry.isFile() || !RAG_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const realFile = await fs.realpath(entryPath);
      if (!isInsideFolder(root, realFile)) continue;
      totalSourceBytes += (await fs.stat(realFile)).size;
      if (totalSourceBytes > MAX_REGISTERED_FOLDER_SOURCE_BYTES) throw new Error("Supported files in this folder exceed the 10 GB cumulative scan safety budget.");
      files.push(realFile);
      if (files.length > MAX_REGISTERED_FOLDER_FILES) {
        throw new Error(`This folder contains more than ${MAX_REGISTERED_FOLDER_FILES.toLocaleString()} supported files. Register a smaller knowledge folder to keep scanning safe.`);
      }
    }
    await yieldToEventLoop();
  }
  return files;
}

function ensureRagHeadroom(fileSize: number, extraBytes = 0) {
  const estimatedWorkingBytes = Math.max(64 * 1024 * 1024, fileSize * 6 + extraBytes);
  if (os.freemem() < RAG_MEMORY_RESERVE_BYTES + estimatedWorkingBytes) {
    throw new Error("The document could not be processed with a safe amount of free memory.");
  }
}

function estimateRagStorageBytes(fileSize: number, textCharacters: number, chunkCount: number, includesStoredCopy: boolean) {
  const storedCopyBytes = includesStoredCopy ? fileSize : 0;
  const textBytes = textCharacters * 2;
  const worstCaseEmbeddingJsonBytes = chunkCount * 4096 * 16;
  // SQLite WAL and transaction pages can temporarily require substantially
  // more room than the final rows alone.
  return Math.ceil((storedCopyBytes + textBytes + worstCaseEmbeddingJsonBytes) * 2.5);
}

async function ensureRagDiskHeadroom(estimatedWriteBytes: number) {
  try {
    const stats = await fs.statfs(process.cwd());
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    if (!Number.isFinite(availableBytes) || availableBytes < RAG_DISK_RESERVE_BYTES + estimatedWriteBytes) {
      throw new Error("Indexing stopped because VoidCat could not preserve at least 2 GB of free disk space.");
    }
  } catch (error) {
    const diskError = new Error(error instanceof Error ? error.message : "VoidCat could not verify safe free disk space.");
    diskError.name = "RagDiskSafetyError";
    throw diskError;
  }
}

async function scanFolderFile(folder: RegisteredFolder, root: string, filePath: string, startedAt: string, signal: AbortSignal) {
  const relativePath = path.relative(root, filePath).split(path.sep).join("/");
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  let fingerprint: string;
  let chunks: string[];
  try {
    stat = await fs.stat(filePath);
    fingerprint = `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
    const existing = getFolderDocumentSource(folder.id, relativePath) as { documentId?: string; fingerprint?: string } | undefined;
    if (existing?.documentId && existing.fingerprint === fingerprint) {
      touchDocumentSource(existing.documentId, { sourcePath: filePath, modifiedAtMs: stat.mtimeMs, sizeBytes: stat.size, fingerprint, seenAt: startedAt });
      return;
    }
    ensureRagHeadroom(stat.size);
    const buffer = await fs.readFile(filePath);
    if (signal.aborted) throw abortedError();
    const text = await extractText(filePath, buffer);
    chunks = chunkText(text);
    if (!chunks.length) throw new Error("No readable text was found.");
    if (chunks.length > MAX_RAG_CHUNKS_PER_DOCUMENT) throw new Error(`The file produced more than ${MAX_RAG_CHUNKS_PER_DOCUMENT.toLocaleString()} passages.`);
    ensureRagHeadroom(stat.size, text.length * 2 + chunks.length * 4096 * 8);
    await ensureRagDiskHeadroom(estimateRagStorageBytes(stat.size, text.length, chunks.length, false));
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw abortedError();
    if (error instanceof Error && error.name === "RagDiskSafetyError") throw error;
    const fileError = new Error(error instanceof Error ? error.message : "The file could not be read safely.");
    fileError.name = "RagFileError";
    throw fileError;
  }
  const embeddings = await embedTexts(chunks, signal);
  if (signal.aborted) throw abortedError();
  await ensureRagDiskHeadroom(estimateRagStorageBytes(stat.size, chunks.reduce((total, chunk) => total + chunk.length, 0), chunks.length, false));
  const document = upsertFolderDocument({
    folderId: folder.id,
    sourcePath: filePath,
    relativePath,
    modifiedAtMs: stat.mtimeMs,
    fingerprint,
    seenAt: startedAt,
    name: path.basename(filePath),
    extension: path.extname(filePath).toLowerCase(),
    storedPath: filePath,
    sizeBytes: stat.size,
  }, chunks.map((content, index) => ({ content, embedding: embeddings[index] })));
  await indexDocumentCompletely(document.id, signal);
}

async function executeFolderScan(folderId: string, startedAt: string, signal: AbortSignal) {
  const finishStorageWrite = storageWriteActivity.begin("rag");
  try {
  const folder = getRagFolder(folderId) as RegisteredFolder | null;
  if (!folder) throw new Error("Registered folder was not found.");
  const root = await fs.realpath(folder.path);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new Error("The registered path is no longer a folder.");
  await ensureRagDiskHeadroom(0);
  const files = await collectFolderFiles(root, folder.recursive, signal);
  updateRagFolderScanProgress(folderId, { totalFileCount: files.length, indexedFileCount: 0, skippedFileCount: 0 });

  let indexedFileCount = 0;
  let skippedFileCount = 0;
  for (const filePath of files) {
    if (signal.aborted) throw abortedError();
    const relativePath = path.relative(root, filePath).split(path.sep).join("/");
    const existing = getFolderDocumentSource(folder.id, relativePath) as { documentId?: string } | undefined;
    try {
      await scanFolderFile(folder, root, filePath, startedAt, signal);
      indexedFileCount += 1;
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw abortedError();
      if (!(error instanceof Error) || error.name !== "RagFileError") throw error;
      if (existing?.documentId) touchDocumentSource(existing.documentId, { seenAt: startedAt });
      skippedFileCount += 1;
    }
    updateRagFolderScanProgress(folderId, { totalFileCount: files.length, indexedFileCount, skippedFileCount });
    await yieldToEventLoop();
  }

  while (true) {
    if (signal.aborted) throw abortedError();
    const stale = listStaleFolderDocumentSources(folderId, startedAt, 100);
    if (!stale.length) break;
    stale.forEach(({ documentId }) => { deleteDocument(documentId); });
    await yieldToEventLoop();
  }
  } finally { finishStorageWrite(); }
}

function startFolderScan(folderId: string) {
  if (folderScanJobs.size > 0) throw new Error("Another folder scan is already active. Wait for it to finish or cancel it first.");
  const { startedAt } = beginRagFolderScan(folderId);
  const controller = new AbortController();
  folderScanJobs.set(folderId, { controller, startedAt });
  void executeFolderScan(folderId, startedAt, controller.signal)
    .then(() => { finishRagFolderScan(folderId, { startedAt }); })
    .catch((error: unknown) => {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) cancelRagFolderScan(folderId, startedAt);
      else finishRagFolderScan(folderId, { startedAt, error: error instanceof Error ? error.message : "Folder scan failed." });
    })
    .finally(async () => {
      await releaseEmbeddingModelIfIdle();
      folderScanJobs.delete(folderId);
    });
  return getRagFolder(folderId);
}

async function registerFolder(folderPath: string) {
  const resolved = await fs.realpath(path.resolve(folderPath));
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new Error("The selected path is not a folder.");
  if (resolved === path.parse(resolved).root) throw new Error("Register a knowledge folder, not an entire drive.");
  return registerRagFolder({ path: resolved, name: path.basename(resolved), recursive: true, enabled: true });
}

async function quickCheckDatabase(databasePath: string) {
  const script = "const { DatabaseSync } = require('node:sqlite'); const database = new DatabaseSync(process.argv[1], { readOnly: true }); try { const row = database.prepare('PRAGMA quick_check(1)').get(); process.stdout.write(String(Object.values(row)[0] || 'unknown')); } finally { database.close(); }";
  const result = await execFileAsync(process.execPath, ["-e", script, databasePath], {
    timeout: 5_000, windowsHide: true, maxBuffer: 64 * 1024,
  });
  return result.stdout.trim();
}

async function collectDiagnostics() {
  const databasePath = path.resolve(process.cwd(), ".voidcat", "data", "voidcat.db");
  const logPath = path.resolve(process.cwd(), ".voidcat", "desktop-server-error.log");
  let cliAvailable = false;
  let writable = false;
  let databaseSizeBytes = 0;
  let databaseIssue: string | null = null;
  let documentCount = 0;
  let folderCount = 0;
  let ragIndex = { totalChunks: 0, indexedChunks: 0, indexedEnabledChunks: 0, pendingEnabledChunks: 0, failedEnabledChunks: 0, coverage: 0 };
  try { await fs.access(LMS_PATH, fsConstants.F_OK); cliAvailable = true; } catch { /* reported below */ }
  try { await fs.access(databasePath, fsConstants.R_OK | fsConstants.W_OK); writable = true; } catch { /* reported below */ }
  try { databaseSizeBytes = (await fs.stat(databasePath)).size; } catch { /* reported below */ }
  if (databaseSizeBytes > 0) {
    try {
      const integrity = await quickCheckDatabase(databasePath);
      if (integrity.toLowerCase() !== "ok") databaseIssue = `SQLite quick check reported: ${integrity}`;
    } catch (error) { databaseIssue = error instanceof Error ? error.message : "SQLite quick check failed."; }
  } else databaseIssue = "The local database file was not found.";
  try {
    const state = getState();
    documentCount = state.documents.length;
    folderCount = state.ragFolders.length;
    ragIndex = getRagVectorIndexStats();
  } catch (error) {
    databaseIssue ||= error instanceof Error ? error.message : "The local database could not be read.";
  }
  const runtime = cliAvailable ? await runtimeStatus(5_000) : { online: false, loaded: [], error: "UNIT CLI unavailable." };
  const loaded = runtime.loaded.find((entry) => entry.identifier === "voidcat-core");
  const loadedUnit = typeof loaded?.modelKey === "string" ? loaded.modelKey : typeof loaded?.path === "string" ? path.basename(loaded.path) : null;
  const runtimeStatusValue = cliAvailable && !runtime.error ? "ok" : "warning";
  const storageStatus = writable && !databaseIssue ? "ok" : "error";
  const ragStatus = databaseIssue || ragIndex.failedEnabledChunks > 0 ? "error" : ragIndex.pendingEnabledChunks > 0 || folderScanJobs.size > 0 ? "warning" : "ok";
  let version = "0.1.0";
  try { version = (JSON.parse(await fs.readFile(path.resolve(process.cwd(), "package.json"), "utf8")) as { version?: string }).version || version; } catch { /* fallback above */ }
  const checks = [
    { id: "unit-cli", label: "UNIT RUNTIME", status: runtimeStatusValue, summary: runtimeStatusValue === "ok" ? "The local UNIT command service responded." : "The local UNIT command service did not respond cleanly.", detail: runtime.error || LMS_PATH },
    { id: "storage", label: "LOCAL DATABASE", status: storageStatus, summary: storageStatus === "ok" ? "The database is writable and passed a bounded SQLite quick check." : "The local database needs attention.", detail: databaseIssue || databasePath },
    { id: "vector-index", label: "VECTOR INDEX", status: ragStatus, summary: ragIndex.pendingEnabledChunks ? `${ragIndex.pendingEnabledChunks} chunks await bounded indexing.` : `${ragIndex.indexedEnabledChunks} enabled chunks are indexed.`, detail: `${Math.round(ragIndex.coverage * 100)}% coverage // ${ragIndex.failedEnabledChunks} quarantined` },
    { id: "folder-jobs", label: "FOLDER SCANNER", status: folderScanJobs.size ? "warning" : "ok", summary: folderScanJobs.size ? "A user-started folder scan is active." : "No folder scans are running.", detail: "Folder scans run one at a time and can be canceled." },
  ] as const;
  return {
    checkedAt: new Date().toISOString(),
    app: { version, platform: process.platform, architecture: process.arch, uptimeSeconds: process.uptime() },
    unitRuntime: { status: runtimeStatusValue, cliAvailable, loadedUnit },
    storage: { status: storageStatus, databasePath, databaseSizeBytes, writable },
    rag: { status: ragStatus, documentCount, folderCount,
      chunkCount: ragIndex.totalChunks, vectorCount: ragIndex.indexedChunks, indexKind: "SQLite SimHash LSH + cosine rerank", pendingJobs: folderScanJobs.size },
    checks,
    logPath,
  };
}

async function saveIndexedMemory(input: MemoryInput) {
  if (!input.content?.trim()) return saveMemory(input);
  const existing = input.id ? getMemoryRecord(input.id) : undefined;
  if (existing?.content === input.content.trim() && existing.embedding) return saveMemory(input);
  const [embedding] = await embedTexts([input.content.trim()]);
  return saveMemory({ ...input, embedding });
}

async function searchMemories(query: string) {
  const candidates = getMemoryCandidates();
  if (!candidates.length) return [];
  const missing = candidates.filter((memory) => !memory.embedding);
  const embeddings = await embedTexts([query, ...missing.map((memory) => memory.content)]);
  missing.forEach((memory, index) => {
    memory.embedding = JSON.stringify(embeddings[index + 1]);
    setMemoryEmbedding(memory.id, embeddings[index + 1]);
  });
  const queryEmbedding = embeddings[0];
  return candidates.map((memory) => {
    const relevance = cosine(queryEmbedding, JSON.parse(memory.embedding || "[]") as number[]);
    const score = relevance * 0.78 + (memory.importance / 5) * 0.22;
    return { id: memory.id, content: memory.content, category: memory.category, importance: memory.importance, relevance, score };
  }).filter((memory) => memory.relevance >= 0.18).sort((left, right) => right.score - left.score).slice(0, 6);
}

async function searchWeb(query: string) {
  const settings = getSettings();
  const discovery = await discoverWeb(query);
  return fetchWebSelection(query, discovery.results.slice(0, settings.maxWebPages));
}

async function discoverWeb(query: string) {
  const settings = getSettings();
  const results = await discoverWebSearchResults(query, {
    provider: settings.webProvider,
    apiKey: settings.webApiKey,
    maxResults: 8,
    maxResponseBytes: Math.min(settings.maxWebBytes, 1_000_000),
  });
  return { provider: settings.webProvider, results };
}

async function fetchWebSelection(query: string, selected: WebSearchHit[]) {
  const settings = getSettings();
  const result = await fetchSelectedWebpages(selected, query, {
    allowedDomains: settings.allowedDomains,
    blockedDomains: settings.blockedDomains,
    maxPages: settings.maxWebPages,
    maxBytesPerPage: settings.maxWebBytes,
    maxTotalBytes: settings.maxWebPages * settings.maxWebBytes,
  });
  return { provider: settings.webProvider, results: result.sources, rejected: result.rejected, bytesRead: result.bytesRead };
}

async function loadModel(modelKey: string, contextLength: number) {
  const loadableModelKey = await resolveLoadableModelKey(modelKey);
  await ensureApiServer();
  const status = await runtimeStatus();
  const owned = status.loaded.find((entry) => entry.identifier === "voidcat-core");
  if (owned) await runLms(["unload", "voidcat-core"], 120_000);
  await runLms([
    "load", loadableModelKey, "--yes", "--identifier", "voidcat-core",
    "--context-length", String(Math.max(2048, Math.min(contextLength, 32768))),
  ], 10 * 60_000);
  return runtimeStatus();
}

async function readBoundedJsonResponse(response: Response, maximumBytes: number) {
  if (!response.body) throw new Error("The provider returned an empty response.");
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let bytes = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > maximumBytes) throw new Error(`The provider response exceeded the ${Math.round(maximumBytes / 1_000)} KB safety limit.`); chunks.push(Buffer.from(value)); }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; } catch { throw new Error("The provider returned malformed JSON."); }
}

async function searchHuggingFaceModels(query: string) {
  const normalized = query.trim().slice(0, 100); if (normalized.length < 2) throw new Error("Enter at least two characters to search Hugging Face.");
  const cached = modelSearchCache.get(normalized.toLowerCase()); if (cached && Date.now() - cached.at < 10 * 60_000) return { cached: true, results: cached.results };
  if (Date.now() - lastModelSearchAt < 2_000) throw new Error("Model search is limited to one external request every two seconds."); lastModelSearchAt = Date.now();
  const endpoint = `https://huggingface.co/api/models?search=${encodeURIComponent(normalized)}&filter=gguf&sort=downloads&direction=-1&limit=20`;
  const response = await fetch(endpoint, { headers: { Accept: "application/json", "User-Agent": "VoidCat-Harness/0.1" }, signal: AbortSignal.timeout(12_000) }); if (!response.ok) throw new Error(`Hugging Face search returned HTTP ${response.status}.`);
  const length = Number(response.headers.get("content-length") || 0); if (length > 1_000_000) throw new Error("Hugging Face search response exceeded the 1 MB limit."); const data = await readBoundedJsonResponse(response, 1_000_000);
  if (!Array.isArray(data)) throw new Error("Hugging Face returned a malformed model list.");
  const results = data.slice(0, 20).map((value) => { const item = value as Record<string, unknown>; return { id: String(item.id ?? "").slice(0, 300), author: String(item.author ?? "").slice(0, 200), downloads: Number(item.downloads || 0), likes: Number(item.likes || 0), lastModified: typeof item.lastModified === "string" ? item.lastModified : null, tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 20) : [] }; }).filter(({ id }) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(id));
  modelSearchCache.set(normalized.toLowerCase(), { at: Date.now(), results }); while (modelSearchCache.size > 30) modelSearchCache.delete(modelSearchCache.keys().next().value as string); return { cached: false, results };
}

type HuggingFaceFileBundle = { id: string; label: string; files: string[]; sizeBytes: number; fileCount: number };
function exactHuggingFaceRepository(value: string) { if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new Error("Choose an exact Hugging Face repository in owner/model form."); return value; }
function safeHuggingFaceFile(value: string) {
  if (typeof value !== "string" || value.length > 500 || value.includes("\\") || value.split("/").some((part) => !part || part === "." || part === "..") || !value.toLowerCase().endsWith(".gguf")) throw new Error("The selected Hugging Face file is not a safe GGUF path.");
  return value;
}
async function listHuggingFaceModelFiles(repository: string) {
  const name = exactHuggingFaceRepository(repository); const cached = modelFileCache.get(name.toLowerCase()); if (cached && Date.now() - cached.at < 10 * 60_000) return { repository: name, cached: true, bundles: cached.results };
  const response = await fetch(`https://huggingface.co/api/models/${encodeURIComponent(name.split("/")[0])}/${encodeURIComponent(name.split("/")[1])}?blobs=true`, { headers: { Accept: "application/json", "User-Agent": "VoidCat-Harness/0.1" }, signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`Hugging Face file discovery returned HTTP ${response.status}.`); const data = await readBoundedJsonResponse(response, 2_000_000) as { siblings?: Array<{ rfilename?: string; size?: number; lfs?: { size?: number } }> };
  const files = (Array.isArray(data.siblings) ? data.siblings : []).filter((item) => typeof item.rfilename === "string" && item.rfilename.toLowerCase().endsWith(".gguf")).map((item) => ({ name: safeHuggingFaceFile(String(item.rfilename)), sizeBytes: Number(item.size ?? item.lfs?.size ?? 0) })).filter((item) => Number.isFinite(item.sizeBytes) && item.sizeBytes > 64 * 1024).slice(0, 1_000);
  const bundles = new Map<string, HuggingFaceFileBundle>();
  for (const file of files) {
    const match = file.name.match(/^(.*)-(\d{5})-of-(\d{5})\.gguf$/i); const id = match ? `${match[1]}-sharded-${match[3]}` : file.name; const current = bundles.get(id) ?? { id, label: match ? `${match[1]} (${Number(match[3])} shards)` : file.name, files: [], sizeBytes: 0, fileCount: 0 };
    current.files.push(file.name); current.sizeBytes += file.sizeBytes; current.fileCount += 1; bundles.set(id, current);
  }
  const results = [...bundles.values()].filter((bundle) => bundle.fileCount <= 64).sort((left, right) => left.sizeBytes - right.sizeBytes).slice(0, 200); modelFileCache.set(name.toLowerCase(), { at: Date.now(), results }); return { repository: name, cached: false, bundles: results };
}

async function listOllamaModels() {
  try { const response = await fetch("http://127.0.0.1:11434/api/tags", { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(2_500) }); if (!response.ok) throw new Error(); const data = await response.json() as { models?: unknown[] }; return { available: true, models: Array.isArray(data.models) ? data.models.slice(0, 200) : [] }; }
  catch { return { available: false, models: [] }; }
}

async function modelStorageFolder() {
  const fallback = path.join(os.homedir(), ".lmstudio", "hub", "models");
  try { const parsed = JSON.parse(await fs.readFile(path.join(process.cwd(), ".voidcat", "model-library.json"), "utf8")) as { primaryFolder?: unknown }; if (typeof parsed.primaryFolder === "string" && path.isAbsolute(parsed.primaryFolder)) return path.resolve(parsed.primaryFolder); }
  catch { /* first launch uses the LM Studio-compatible default */ }
  return fallback;
}

async function requireModelDownloadHeadroom(root: string, expectedBytes = 0) {
  await fs.mkdir(root, { recursive: true }); const stats = await fs.statfs(root); const free = Number(stats.bavail) * Number(stats.bsize); if (free < expectedBytes + 10 * 1024 ** 3) throw new Error("The selected model folder must retain 10 GB of free disk headroom after this download.");
}

function isApprovedHuggingFaceDownloadUrl(value: string) { const url = new URL(value); return url.protocol === "https:" && (url.hostname === "huggingface.co" || url.hostname.endsWith(".huggingface.co") || url.hostname.endsWith(".xethub.hf.co")); }
async function downloadHuggingFaceFile(repository: string, filename: string, root: string, context: { signal: AbortSignal; reportProgress(value: { current: number; total?: number; message?: string }): void }) {
  const safeName = safeHuggingFaceFile(filename); const repositoryFolder = path.join(root, ...repository.split("/")); const destination = path.resolve(repositoryFolder, ...safeName.split("/")); const relative = path.relative(path.resolve(root), destination); if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("The model download destination escaped the selected storage folder.");
  await fs.mkdir(path.dirname(destination), { recursive: true }); const temporary = `${destination}.${randomUUID()}.part`;
  const endpoint = `https://huggingface.co/${repository.split("/").map(encodeURIComponent).join("/")}/resolve/main/${safeName.split("/").map(encodeURIComponent).join("/")}?download=true`;
  try {
    const response = await fetch(endpoint, { headers: { Accept: "application/octet-stream", "User-Agent": "VoidCat-Harness/0.1" }, signal: context.signal }); if (!response.ok || !response.body) throw new Error(`Hugging Face download returned HTTP ${response.status}.`); if (!isApprovedHuggingFaceDownloadUrl(response.url)) throw new Error("Hugging Face redirected the download outside its approved file network.");
    const expected = Number(response.headers.get("content-length") || 0); if (expected > 100 * 1024 ** 3) throw new Error("The selected model exceeds VoidCat's 100 GB per-file safety ceiling."); await requireModelDownloadHeadroom(root, expected);
    const handle = await fs.open(temporary, "wx"); const reader = response.body.getReader(); let received = 0;
    try { while (true) { const { done, value } = await reader.read(); if (done) break; received += value.byteLength; if (received > 100 * 1024 ** 3) throw new Error("The model download exceeded the 100 GB per-file safety ceiling."); await handle.write(value); context.reportProgress({ current: received, total: expected || undefined, message: `Downloading ${path.basename(safeName)}` }); } }
    finally { reader.releaseLock(); await handle.close(); }
    if (expected && received !== expected) throw new Error("The model download ended before all declared bytes arrived.");
    try { const existing = await fs.stat(destination); if (existing.size === received) { await fs.rm(temporary, { force: true }); return { path: destination, sizeBytes: received }; } throw new Error("A different file already exists at the selected model destination."); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await fs.rename(temporary, destination); return { path: destination, sizeBytes: received };
  } catch (error) { await fs.rm(temporary, { force: true }).catch(() => {}); throw error; }
}

async function recordDownloadedModels(root: string, models: ExternalModelRecord[]) {
  const target = path.join(process.cwd(), ".voidcat", "model-download-catalog.json"); let previous: ExternalModelRecord[] = [];
  try { const parsed = JSON.parse(await fs.readFile(target, "utf8")) as { models?: ExternalModelRecord[] }; previous = Array.isArray(parsed.models) ? parsed.models : []; } catch { /* first download */ }
  const combined = [...new Map([...previous, ...models].map((model) => [path.resolve(model.path).toLowerCase(), model])).values()].slice(-5_000); const temporary = `${target}.${randomUUID()}.tmp`; await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(temporary, JSON.stringify({ version: 1, scannedAt: new Date().toISOString(), roots: [root], models: combined }, null, 2), { encoding: "utf8", flag: "wx" }); await fs.rename(temporary, target).catch(async () => { await fs.rm(target, { force: true }); await fs.rename(temporary, target); });
}

function startModelDownload(kind: "huggingface" | "ollama", rawName: string, rawFiles: unknown = []) {
  const name = rawName.trim(); if (kind === "huggingface" && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name)) throw new Error("Choose an exact Hugging Face repository in owner/model form."); if (kind === "ollama" && !/^[A-Za-z0-9_.\/-]+(?::[A-Za-z0-9_.-]+)?$/.test(name)) throw new Error("Enter an exact Ollama model name and optional tag.");
  const files = kind === "huggingface" && Array.isArray(rawFiles) ? [...new Set(rawFiles.map((file) => safeHuggingFaceFile(String(file))))].slice(0, 64) : []; if (kind === "huggingface" && !files.length) throw new Error("Choose an exact GGUF file or shard bundle before downloading.");
  const handle = voidcatJobManager.start({ module: "model-download", name: `${kind}-${name}`.slice(0, 120), caps: { maxIterations: Math.max(4, files.length + 2), timeoutMs: 6 * 60 * 60_000, maxExternalCalls: Math.max(1, files.length) }, run: async (context) => {
    const root = await modelStorageFolder(); await requireModelDownloadHeadroom(root); context.consumeIteration(); context.reportProgress({ current: 0, total: files.length || 100, message: `Starting ${kind} download` });
    if (kind === "huggingface") {
      const downloaded: ExternalModelRecord[] = []; for (let index = 0; index < files.length; index += 1) { context.consumeIteration(); const model = await context.externalCall((signal) => downloadHuggingFaceFile(name, files[index], root, { signal, reportProgress: (progress) => context.reportProgress({ ...progress, message: `${index + 1}/${files.length} ${progress.message}` }) })); downloaded.push({ ...model, modifiedAt: new Date().toISOString(), root }); } await recordDownloadedModels(root, downloaded);
    } else {
      await context.externalCall(async (signal) => { const response = await fetch("http://127.0.0.1:11434/api/pull", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: name, stream: true, insecure: false }), signal }); if (!response.ok || !response.body) throw new Error(`Ollama pull returned HTTP ${response.status}.`); const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ""; let metadataBytes = 0; while (true) { const { done, value } = await reader.read(); if (done) break; metadataBytes += value.byteLength; if (metadataBytes > 16 * 1024 * 1024) throw new Error("Ollama progress metadata exceeded the 16 MB safety limit."); buffer += decoder.decode(value, { stream: true }); const lines = buffer.split("\n"); buffer = lines.pop() ?? ""; if (buffer.length > 64_000) throw new Error("Ollama returned an oversized progress record."); for (const line of lines) { if (!line.trim()) continue; const update = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string }; if (update.error) throw new Error(update.error.slice(0, 500)); const progress = update.total ? Math.round((update.completed ?? 0) / update.total * 100) : 0; context.reportProgress({ current: progress, total: 100, message: String(update.status ?? "Ollama downloading model").slice(0, 200) }); } } });
    }
    context.reportProgress({ current: files.length || 100, total: files.length || 100, message: "Download complete" }); return { kind, name, storageFolder: kind === "huggingface" ? root : "Ollama-managed library" };
  } }); void handle.result.catch(() => { /* status is retained by the shared job manager */ }); return handle.snapshot();
}

async function proxyChat(request: IncomingMessage, response: ServerResponse) {
  const body = await readBody(request);
  const hunterToolsEnabled = body.hunterSeekerTools === true;
  const osintToolsEnabled = body.osintTools === true;
  const requestedToolNames = Array.isArray(body.enabledToolNames)
    ? [...new Set(body.enabledToolNames.filter((name): name is string => typeof name === "string" && name.length <= 100))].slice(0, 32)
    : [];
  const selectedContextWindow = Math.max(2_048, Math.min(32_768, Number(body.contextLength) || 8_192));
  delete body.hunterSeekerTools;
  delete body.osintTools;
  delete body.enabledToolNames;
  delete body.contextLength;
  if (requestedToolNames.length) {
    await proxySelectedToolChat(body, request, response, selectedContextWindow, requestedToolNames);
    return;
  }
  if (osintToolsEnabled) {
    await proxyOsintToolChat(body, request, response, selectedContextWindow);
    return;
  }
  if (hunterToolsEnabled) {
    await proxyHunterToolChat(body, request, response, selectedContextWindow);
    return;
  }
  await ensureApiServer();
  const upstream = await fetch(`${API_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, model: "voidcat-core", stream: true }),
    signal: AbortSignal.timeout(30 * 60_000),
  });
  response.statusCode = upstream.status;
  response.setHeader("Content-Type", upstream.headers.get("content-type") ?? "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  if (!upstream.body) { response.end(); return; }
  const reader = upstream.body.getReader();
  request.on("close", () => void reader.cancel());
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    response.write(Buffer.from(value));
  }
  response.end();
}

type ModelToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type ModelChatMessage = {
  role: string;
  content?: string | null;
  tool_calls?: ModelToolCall[];
  tool_call_id?: string;
  name?: string;
};

function parseModelMessages(value: unknown): ModelChatMessage[] {
  if (!Array.isArray(value)) throw new Error("Chat messages must be an array.");
  return value.map((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("A chat message is invalid.");
    const candidate = message as Record<string, unknown>;
    if (typeof candidate.role !== "string") throw new Error("Every chat message requires a role.");
    if (candidate.content !== undefined && candidate.content !== null && typeof candidate.content !== "string") throw new Error("Chat message content must be text.");
    return { role: candidate.role, content: candidate.content as string | null | undefined };
  });
}

function withHunterBoundary(messages: ModelChatMessage[], discovered: ReturnType<typeof hunterSeekerToolRuntime.discover>) {
  const boundary = hunterToolSystemBoundary(discovered);
  const boundaryMessage: ModelChatMessage = { role: "system", content: boundary };
  const firstSystemIndex = messages.findIndex((message) => message.role === "system");
  if (firstSystemIndex < 0) return [boundaryMessage, ...messages];
  return messages.map((message, index) => index === firstSystemIndex
    ? { ...message, content: `${message.content ?? ""}\n\n${boundary}`.trim() }
    : message);
}

function namedNumber(text: string, name: string) {
  const match = text.match(new RegExp(`\\b${name}\\b\\s*(?:is|[:=])?\\s*(-?\\d+(?:\\.\\d+)?)`, "i"));
  return match ? Number(match[1]) : undefined;
}

function inferredBoundingBox(text: string) {
  if (/\b(?:global|worldwide|whole world)\b/i.test(text)) return { south: -90, west: -180, north: 90, east: 180 };
  const south = namedNumber(text, "south");
  const west = namedNumber(text, "west");
  const north = namedNumber(text, "north");
  const east = namedNumber(text, "east");
  return [south, west, north, east].every((value) => typeof value === "number" && Number.isFinite(value))
    ? { south: south!, west: west!, north: north!, east: east! }
    : undefined;
}

function inferredHunterToolCall(messages: ModelChatMessage[], discovered: ReturnType<typeof hunterSeekerToolRuntime.discover>): ModelToolCall | undefined {
  const userText = [...messages].reverse().find((message) => message.role === "user")?.content?.trim() ?? "";
  if (!userText) return undefined;
  let registryName: string | undefined;
  let argumentsValue: Record<string, unknown> = {};
  const bbox = inferredBoundingBox(userText);
  if (/\b(?:feed|source|provider)\s+(?:health|status)|\bhealth\s+(?:of|for)\s+(?:feeds?|sources?)\b/i.test(userText)) {
    registryName = "hunter-seeker.feed-health-status";
  } else if (/\b(?:earthquake|earthquakes|seismic|quake|quakes)\b/i.test(userText)) {
    registryName = "hunter-seeker.recent-seismic";
    const magnitude = userText.match(/\b(?:magnitude|mag)\s*(?:>=|over|above|at least|of)?\s*(-?\d+(?:\.\d+)?)/i);
    const age = userText.match(/\b(?:last|past)\s+(\d+)\s*(minutes?|hours?)/i);
    if (magnitude) argumentsValue.minimumMagnitude = Number(magnitude[1]);
    if (age) argumentsValue.maxAgeMinutes = Number(age[1]) * (/hour/i.test(age[2]) ? 60 : 1);
  } else if (/\b(?:aircraft|airplane|plane|flight)\b/i.test(userText) && /\b(?:callsign|icao)\b/i.test(userText)) {
    const identifier = userText.match(/\b(?:callsign|icao)\s*(?:is|[:=#])?\s*["']?([A-Za-z0-9-]{2,20})/i)?.[1];
    if (identifier) {
      registryName = "hunter-seeker.aircraft-by-callsign-or-icao";
      argumentsValue = { identifier };
    }
  } else if (/\b(?:aircraft|airplane|planes?)\b/i.test(userText) && bbox) {
    registryName = "hunter-seeker.aircraft-in-bbox";
    argumentsValue = bbox;
  } else if (/\b(?:vessel|vessels|ship|ships|maritime|ais)\b/i.test(userText) && bbox) {
    registryName = "hunter-seeker.vessels-in-bbox";
    argumentsValue = bbox;
  } else if (/\b(?:satellite|satellites|orbital|passes?)\b/i.test(userText) && bbox) {
    registryName = "hunter-seeker.satellite-passes-over-area";
    argumentsValue = bbox;
  }
  if (!registryName || !discovered.some((tool) => tool.name === registryName)) return undefined;
  return {
    id: `voidcat-fallback-${Date.now().toString(36)}`,
    type: "function",
    function: { name: hunterToolAlias(registryName), arguments: JSON.stringify(argumentsValue) },
  };
}

function parseToolArguments(value: string) {
  let parsed: unknown;
  try { parsed = JSON.parse(value || "{}"); }
  catch { throw new Error("The UNIT produced malformed Hunter-Seeker tool arguments."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Hunter-Seeker tool arguments must be an object.");
  return parsed as Record<string, unknown>;
}

function writeSyntheticChatStream(response: ServerResponse, content: string) {
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  for (let offset = 0; offset < content.length; offset += 160) {
    const chunk = content.slice(offset, offset + 160);
    response.write(`data: ${JSON.stringify({ id: "voidcat-hunter-seeker", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] })}\n\n`);
  }
  response.write(`data: ${JSON.stringify({ id: "voidcat-hunter-seeker", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  response.write("data: [DONE]\n\n");
  response.end();
}

async function proxyHunterToolChat(body: Record<string, unknown>, request: IncomingMessage, response: ServerResponse, contextWindow: number) {
  await ensureApiServer();
  const discovered = hunterSeekerToolRuntime.discover();
  const modelTools = hunterToolsForModel(discovered);
  const initialMessages = withHunterBoundary(parseModelMessages(body.messages), discovered);
  const handle = voidcatJobManager.start({
    module: "hunter-seeker",
    name: "unit-analysis",
    caps: { maxIterations: 12, timeoutMs: 10 * 60_000, maxExternalCalls: 10 },
    run: async (context) => {
      const messages: ModelChatMessage[] = [...initialMessages];
      const toolResults: unknown[] = [];
      let totalToolCalls = 0;
      for (let round = 0; round < 4; round += 1) {
        context.consumeIteration();
        context.reportProgress({ current: round, total: 4, message: round === 0 ? "UNIT evaluating live-tool need" : "UNIT correlating cited observations" });
        context.reportUsage({ inputTokens: Math.ceil(JSON.stringify(messages).length / 4) });
        const reservedOutputTokens = Math.max(256, Math.min(Number(body.max_tokens) || 512, 512, contextWindow - 1_024));
        const fittedMessages = fitMessagesToContext(messages, contextWindow, reservedOutputTokens);
        let upstream: Response;
        try {
          upstream = await context.externalCall((signal) => fetch(`${API_BASE}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...body, max_tokens: reservedOutputTokens, messages: fittedMessages, model: "voidcat-core", stream: false, tools: modelTools, tool_choice: "auto" }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(toolResults.length ? 60_000 : 90_000)]),
          }));
        } catch (error) {
          if (toolResults.length) return renderHunterEvidenceFallback(toolResults);
          throw error;
        }
        if (!upstream.ok) {
          if (toolResults.length) return renderHunterEvidenceFallback(toolResults);
          throw new Error(`Local UNIT rejected the tool-capable request (${upstream.status}).`);
        }
        let completion: { choices?: Array<{ message?: ModelChatMessage }> };
        try { completion = await upstream.json() as typeof completion; }
        catch (error) {
          if (toolResults.length) return renderHunterEvidenceFallback(toolResults);
          throw error;
        }
        const message = completion.choices?.[0]?.message;
        if (!message) {
          if (toolResults.length) return renderHunterEvidenceFallback(toolResults);
          throw new Error("Local UNIT returned no chat message.");
        }
        let calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        if (!calls.length && !toolResults.length) {
          const inferred = inferredHunterToolCall(messages, discovered);
          if (inferred) calls = [inferred];
        }
        if (!calls.length) {
          const content = typeof message.content === "string" ? message.content.trim() : "";
          if (!content) throw new Error("Local UNIT returned neither text nor a tool request.");
          if (!toolResults.length) return safeHunterCitationFailure(["The UNIT did not invoke an approved Hunter-Seeker tool for this live-data request."]);
          context.reportUsage({ outputTokens: Math.ceil(content.length / 4) });
          context.reportProgress({ current: 4, total: 4, message: "Citation integrity checked" });
          const groundedContent = markUncitedHunterFindings(content, toolResults);
          const citationCheck = validateHunterCitations(groundedContent, toolResults);
          return citationCheck.valid ? groundedContent : renderHunterEvidenceFallback(toolResults);
        }
        if (calls.length > 4 || totalToolCalls + calls.length > 6) throw new Error("The UNIT exceeded the bounded Hunter-Seeker tool-call limit.");
        messages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });
        for (const call of calls) {
          if (!call || call.type !== "function" || typeof call.id !== "string" || typeof call.function?.name !== "string" || typeof call.function.arguments !== "string") {
            throw new Error("The UNIT produced an invalid Hunter-Seeker tool request.");
          }
          const registryName = registryNameForHunterAlias(call.function.name, discovered);
          if (!registryName) throw new Error("The UNIT requested a tool outside the approved Hunter-Seeker registry.");
          const unboundedToolResult = await context.externalCall(() => hunterSeekerToolRuntime.invokeInManagedContext(registryName, parseToolArguments(call.function.arguments), context, {
            kind: "agent", id: context.jobId, modelLane: "voidcat-core",
          }));
          const toolResult = boundHunterToolResult(unboundedToolResult, Math.max(2_000, Math.floor(contextWindow / 2)));
          toolResults.push(toolResult);
          totalToolCalls += 1;
          messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: JSON.stringify(toolResult) });
        }
      }
      throw new Error("The UNIT reached the four-round Hunter-Seeker analysis limit without a final answer.");
    },
  });
  let responseFinished = false;
  response.once("close", () => { if (!responseFinished) handle.cancel(); });
  request.once("aborted", () => handle.cancel());
  try {
    const content = await handle.result;
    responseFinished = true;
    writeSyntheticChatStream(response, content);
  } catch (error) {
    responseFinished = true;
    if (error instanceof JobManagerError && error.cause instanceof Error) {
      const safeCause = error.cause.message.replace(/((?:api[_ -]?key|authorization|bearer))\s*[:=]\s*\S+/gi, "$1 [REDACTED]").slice(0, 500);
      throw new Error(`Hunter-Seeker UNIT analysis failed: ${safeCause}`);
    }
    throw error;
  }
}

function withOsintBoundary(messages: ModelChatMessage[], discovered: ReturnType<typeof osintUnitToolRuntime.discover>) {
  const boundary = osintToolSystemBoundary(discovered); const boundaryMessage: ModelChatMessage = { role: "system", content: boundary }; const firstSystemIndex = messages.findIndex((message) => message.role === "system");
  if (firstSystemIndex < 0) return [boundaryMessage, ...messages];
  return messages.map((message, index) => index === firstSystemIndex ? { ...message, content: `${message.content ?? ""}\n\n${boundary}`.trim() } : message);
}

function parseOsintToolArguments(value: string) {
  let parsed: unknown; try { parsed = JSON.parse(value || "{}"); } catch { throw new Error("The UNIT produced malformed OSINT tool arguments."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("OSINT tool arguments must be an object."); return parsed as Record<string, unknown>;
}

async function proxyOsintToolChat(body: Record<string, unknown>, request: IncomingMessage, response: ServerResponse, contextWindow: number) {
  await ensureApiServer(); const discovered = osintUnitToolRuntime.discover(); const modelTools = osintToolsForModel(discovered); const initialMessages = withOsintBoundary(parseModelMessages(body.messages), discovered);
  const handle = voidcatJobManager.start({
    module: "osint-unit", name: "unit-analysis", caps: { maxIterations: 16, timeoutMs: 10 * 60_000, maxExternalCalls: 8 },
    run: async (context) => {
      const messages: ModelChatMessage[] = [...initialMessages]; const toolResults: unknown[] = []; let totalToolCalls = 0;
      for (let round = 0; round < 4; round += 1) {
        context.consumeIteration(); context.reportProgress({ current: round, total: 4, message: round === 0 ? "UNIT evaluating bounded OSINT tool need" : "UNIT correlating cited OSINT evidence" }); context.reportUsage({ inputTokens: Math.ceil(JSON.stringify(messages).length / 4) });
        const reservedOutputTokens = Math.max(256, Math.min(Number(body.max_tokens) || 512, 768, contextWindow - 1_024)); const fittedMessages = fitMessagesToContext(messages, contextWindow, reservedOutputTokens);
        let upstream: Response;
        try { upstream = await context.externalCall((signal) => fetch(`${API_BASE}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, max_tokens: reservedOutputTokens, messages: fittedMessages, model: "voidcat-core", stream: false, tools: modelTools, tool_choice: "auto" }), signal: AbortSignal.any([signal, AbortSignal.timeout(toolResults.length ? 60_000 : 90_000)]) })); }
        catch (error) { if (toolResults.length) return renderOsintEvidenceFallback(toolResults); throw error; }
        if (!upstream.ok) { if (toolResults.length) return renderOsintEvidenceFallback(toolResults); throw new Error(`Local UNIT rejected the OSINT tool request (${upstream.status}).`); }
        let completion: { choices?: Array<{ message?: ModelChatMessage }> }; try { completion = await upstream.json() as typeof completion; } catch (error) { if (toolResults.length) return renderOsintEvidenceFallback(toolResults); throw error; }
        const message = completion.choices?.[0]?.message; if (!message) { if (toolResults.length) return renderOsintEvidenceFallback(toolResults); throw new Error("Local UNIT returned no OSINT chat message."); }
        let calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        if (!calls.length && !toolResults.length) { const userText = [...messages].reverse().find((item) => item.role === "user")?.content ?? ""; const inferred = inferredOsintToolCall(userText, discovered); if (inferred) calls = [inferred]; }
        if (!calls.length) {
          const content = typeof message.content === "string" ? message.content.trim() : ""; if (!content) throw new Error("Local UNIT returned neither text nor an OSINT tool request.");
          if (!toolResults.length) return "No approved OSINT tool was invoked, so no evidence-backed conclusion is available.";
          context.reportUsage({ outputTokens: Math.ceil(content.length / 4) }); const grounded = markUncitedOsintConclusions(content, toolResults); const citations = validateOsintCitations(grounded, toolResults); context.reportProgress({ current: 4, total: 4, message: "OSINT citation integrity checked" }); return citations.valid && citations.citedEvidenceIds.length > 0 ? grounded : renderOsintEvidenceFallback(toolResults);
        }
        if (calls.length > 4 || totalToolCalls + calls.length > 6) throw new Error("The UNIT exceeded the bounded OSINT tool-call limit."); messages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });
        for (const call of calls) {
          if (!call || call.type !== "function" || typeof call.id !== "string" || typeof call.function?.name !== "string" || typeof call.function.arguments !== "string") throw new Error("The UNIT produced an invalid OSINT tool request.");
          const registryName = registryNameForOsintAlias(call.function.name, discovered); if (!registryName) throw new Error("The UNIT requested a tool outside the approved high-level OSINT registry.");
          const invocation = osintUnitToolRuntime.startInvocation(registryName, parseOsintToolArguments(call.function.arguments), { caller: { kind: "agent", id: context.jobId, modelLane: "voidcat-core" }, maximumOutputTokens: Math.max(2_000, Math.floor(contextWindow / 2)), parentSignal: context.signal });
          const toolResult = await invocation.result; toolResults.push(toolResult); totalToolCalls += 1; context.consumeIteration(); messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: JSON.stringify(toolResult) });
        }
      }
      if (toolResults.length) return renderOsintEvidenceFallback(toolResults);
      throw new Error("The UNIT reached the four-round OSINT analysis limit without evidence or a final answer.");
    },
  });
  let responseFinished = false; response.once("close", () => { if (!responseFinished) handle.cancel(); }); request.once("aborted", () => handle.cancel());
  try { const content = await handle.result; responseFinished = true; writeSyntheticChatStream(response, content); }
  catch (error) { responseFinished = true; if (error instanceof JobManagerError && error.cause instanceof Error) { const safeCause = error.cause.message.replace(/((?:api[_ -]?key|authorization|bearer))\s*[:=]\s*\S+/gi, "$1 [REDACTED]").slice(0, 500); throw new Error(`OSINT UNIT analysis failed: ${safeCause}`); } throw error; }
}

function withSelectedToolBoundaries(
  messages: ModelChatMessage[],
  hunterTools: ReturnType<typeof hunterSeekerToolRuntime.discover>,
  osintTools: ReturnType<typeof osintUnitToolRuntime.discover>,
  commandTools: DiscoveredTool[],
) {
  const boundaries = [
    hunterTools.length ? hunterToolSystemBoundary(hunterTools) : "",
    osintTools.length ? osintToolSystemBoundary(osintTools) : "",
    commandTools.length ? commandToolBoundary(commandTools) : "",
    "COMMAND TOOL POLICY: Only the functions listed in these boundaries are enabled for this message. Disabled functions are unavailable and must not be simulated.",
  ].filter(Boolean).join("\n\n");
  const firstSystemIndex = messages.findIndex((message) => message.role === "system");
  if (firstSystemIndex < 0) return [{ role: "system", content: boundaries }, ...messages];
  return messages.map((message, index) => index === firstSystemIndex
    ? { ...message, content: `${message.content ?? ""}\n\n${boundaries}`.trim() }
    : message);
}

function commandCitationIds(results: unknown[]) { const ids = new Set<string>(); for (const result of results) if (result && typeof result === "object" && !Array.isArray(result)) for (const id of ((result as { citations?: unknown }).citations as unknown[] ?? [])) if (typeof id === "string") ids.add(id); return ids; }
function groundCommandContent(content: string, results: unknown[]) { const known = commandCitationIds(results); if (!known.size) return content; return content.split(/(?<=[.!?])\s+/).map((sentence) => { if (!/[A-Za-z0-9]/.test(sentence)) return sentence; const cited = [...sentence.matchAll(/\[VC:([^\]]+)\]/g)].some((match) => known.has(match[1])); return cited ? sentence : `${sentence} [UNSUPPORTED — NO RECORD ID]`; }).join(" "); }
function renderCommandFallback(results: unknown[]) { const lines = ["## VoidCat knowledge result"]; for (const value of results) { const result = value as { results?: Array<Record<string, unknown>>; items?: Array<Record<string, unknown>>; historical?: Array<Record<string, unknown>>; documents?: Array<Record<string, unknown>>; limitations?: string[] }; const records = [...(result.results ?? []), ...(result.items ?? []), ...(result.historical ?? []), ...(result.documents ?? [])].slice(0, 20); for (const record of records) { const id = String(record.id ?? ""); const label = String(record.title ?? record.name ?? record.documentName ?? record.content ?? "Record").slice(0, 300); if (id) lines.push(`- ${label} [VC:${id}]`); } result.limitations?.slice(0, 8).forEach((item) => lines.push(`- Coverage limitation: ${item}`)); } return lines.join("\n"); }
function renderSelectedToolFallback(hunterResults: unknown[], osintResults: unknown[], commandResults: unknown[]) {
  return [
    hunterResults.length ? renderHunterEvidenceFallback(hunterResults) : "",
    osintResults.length ? renderOsintEvidenceFallback(osintResults) : "",
    commandResults.length ? renderCommandFallback(commandResults) : "",
  ].filter(Boolean).join("\n\n");
}

async function proxySelectedToolChat(
  body: Record<string, unknown>, request: IncomingMessage, response: ServerResponse,
  contextWindow: number, requestedNames: string[],
) {
  await ensureApiServer();
  const requested = new Set(requestedNames);
  const hunterTools = hunterSeekerToolRuntime.discover().filter((tool) => requested.has(tool.name));
  const osintTools = osintUnitToolRuntime.discover().filter((tool) => requested.has(tool.name));
  const commandTools = voidcatToolRegistry.discover({ module: "voidcat-knowledge" }).filter((tool) => requested.has(tool.name));
  if (!hunterTools.length && !osintTools.length && !commandTools.length) throw new Error("None of the requested Command tools are registered and available.");
  const modelTools = [...hunterToolsForModel(hunterTools), ...osintToolsForModel(osintTools), ...commandToolsForModel(commandTools)];
  const initialMessages = withSelectedToolBoundaries(parseModelMessages(body.messages), hunterTools, osintTools, commandTools);
  const handle = voidcatJobManager.start({
    module: "command-intelligence", name: "selected-tool-analysis",
    caps: { maxIterations: 20, timeoutMs: 10 * 60_000, maxExternalCalls: 10 },
    run: async (context) => {
      const messages: ModelChatMessage[] = [...initialMessages];
      const hunterResults: unknown[] = []; const osintResults: unknown[] = []; const commandResults: unknown[] = [];
      let totalToolCalls = 0;
      for (let round = 0; round < 4; round += 1) {
        context.consumeIteration();
        context.reportProgress({ current: round, total: 4, message: round === 0 ? "UNIT selecting approved intelligence capabilities" : "UNIT correlating cited evidence" });
        context.reportUsage({ inputTokens: Math.ceil(JSON.stringify(messages).length / 4) });
        const reservedOutputTokens = Math.max(256, Math.min(Number(body.max_tokens) || 512, 768, contextWindow - 1_024));
        const fittedMessages = fitMessagesToContext(messages, contextWindow, reservedOutputTokens);
        let upstream: Response;
        try {
          upstream = await context.externalCall((signal) => fetch(`${API_BASE}/v1/chat/completions`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...body, max_tokens: reservedOutputTokens, messages: fittedMessages, model: "voidcat-core", stream: false, tools: modelTools, tool_choice: "auto" }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(totalToolCalls ? 60_000 : 90_000)]),
          }));
        } catch (error) {
          if (hunterResults.length || osintResults.length || commandResults.length) return renderSelectedToolFallback(hunterResults, osintResults, commandResults);
          throw error;
        }
        if (!upstream.ok) {
          if (hunterResults.length || osintResults.length || commandResults.length) return renderSelectedToolFallback(hunterResults, osintResults, commandResults);
          throw new Error(`Local UNIT rejected the selected-tool request (${upstream.status}).`);
        }
        const completion = await upstream.json() as { choices?: Array<{ message?: ModelChatMessage }> };
        const message = completion.choices?.[0]?.message;
        if (!message) throw new Error("Local UNIT returned no selected-tool chat message.");
        let calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        if (!calls.length && totalToolCalls === 0) {
          const userText = [...messages].reverse().find((item) => item.role === "user")?.content ?? "";
          const hunterInferred = inferredHunterToolCall(messages, hunterTools);
          const osintInferred = inferredOsintToolCall(userText, osintTools);
          let commandName: string | undefined; if (/\bnews|headlines?\b/i.test(userText)) commandName = "voidcat.news-headlines"; else if (/\bosint\s+(?:directory|tools?)|\bdirectory\s+search\b/i.test(userText)) commandName = "voidcat.search-osint-directory"; else if (/\b(?:approved|project)\s+memor(?:y|ies)\b/i.test(userText)) commandName = "voidcat.search-project-memory"; else if (/\b(?:rag|document|library)\b/i.test(userText)) commandName = "voidcat.search-rag-library"; else if (/\b(?:hunter|event)\s+histor(?:y|ical)|\bwhat changed\b/i.test(userText)) commandName = "voidcat.search-hunter-history"; const selectedCommand = commandTools.find((tool) => tool.name === commandName);
          if (hunterInferred) calls = [hunterInferred]; else if (osintInferred) calls = [osintInferred]; else if (selectedCommand) { const args = selectedCommand.name === "voidcat.news-headlines" ? { sourceIds: newsCatalog().map(({ id }) => id) } : { query: userText.slice(0, 500) }; calls = [{ id: `voidcat-command-${Date.now().toString(36)}`, type: "function", function: { name: commandToolAlias(selectedCommand.name), arguments: JSON.stringify(args) } }]; }
        }
        if (!calls.length) {
          const content = typeof message.content === "string" ? message.content.trim() : "";
          if (!content) throw new Error("Local UNIT returned neither text nor an approved tool request.");
          if (!hunterResults.length && !osintResults.length && !commandResults.length) return "No enabled intelligence capability was invoked, so no evidence-backed finding is available.";
          let grounded = content;
          if (hunterResults.length) grounded = markUncitedHunterFindings(grounded, hunterResults);
          if (osintResults.length) grounded = markUncitedOsintConclusions(grounded, osintResults);
          if (commandResults.length) grounded = groundCommandContent(grounded, commandResults);
          const hunterValid = !hunterResults.length || validateHunterCitations(grounded, hunterResults).valid;
          const osintValidation = validateOsintCitations(grounded, osintResults);
          const osintValid = !osintResults.length || (osintValidation.valid && osintValidation.citedEvidenceIds.length > 0);
          const commandKnown = commandCitationIds(commandResults); const commandCited = [...grounded.matchAll(/\[VC:([^\]]+)\]/g)].some((match) => commandKnown.has(match[1])); const commandValid = !commandResults.length || (commandKnown.size > 0 && commandCited);
          context.reportUsage({ outputTokens: Math.ceil(grounded.length / 4) });
          context.reportProgress({ current: 4, total: 4, message: "Cross-source citation integrity checked" });
          return hunterValid && osintValid && commandValid ? grounded : renderSelectedToolFallback(hunterResults, osintResults, commandResults);
        }
        if (calls.length > 4 || totalToolCalls + calls.length > 6) throw new Error("The UNIT exceeded the bounded selected-tool call limit.");
        messages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });
        for (const call of calls) {
          if (!call || call.type !== "function" || typeof call.id !== "string" || typeof call.function?.name !== "string" || typeof call.function.arguments !== "string") throw new Error("The UNIT produced an invalid selected-tool request.");
          const hunterName = registryNameForHunterAlias(call.function.name, hunterTools);
          const osintName = registryNameForOsintAlias(call.function.name, osintTools);
          const commandName = commandRegistryName(call.function.name, commandTools);
          if (!hunterName && !osintName && !commandName) throw new Error("The UNIT requested a function that is disabled in the Command interface.");
          let toolResult: unknown;
          if (hunterName) {
            const result = await context.externalCall(() => hunterSeekerToolRuntime.invokeInManagedContext(hunterName, parseToolArguments(call.function.arguments), context, { kind: "agent", id: context.jobId, modelLane: "voidcat-core" }));
            toolResult = boundHunterToolResult(result, Math.max(2_000, Math.floor(contextWindow / 2)));
            hunterResults.push(toolResult);
          } else if (osintName) {
            const invocation = osintUnitToolRuntime.startInvocation(osintName!, parseOsintToolArguments(call.function.arguments), { caller: { kind: "agent", id: context.jobId, modelLane: "voidcat-core" }, maximumOutputTokens: Math.max(2_000, Math.floor(contextWindow / 2)), parentSignal: context.signal });
            toolResult = await invocation.result; osintResults.push(toolResult); context.consumeIteration();
          } else {
            const invoke = () => voidcatToolRegistry.invoke(commandName!, parseToolArguments(call.function.arguments), { caller: { kind: "agent", id: context.jobId, modelLane: "voidcat-core" }, signal: context.signal });
            toolResult = commandName === "voidcat.news-headlines" ? await context.externalCall(invoke) : await invoke(); commandResults.push(toolResult); context.consumeIteration();
          }
          totalToolCalls += 1;
          messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: JSON.stringify(toolResult) });
        }
      }
      if (hunterResults.length || osintResults.length || commandResults.length) return renderSelectedToolFallback(hunterResults, osintResults, commandResults);
      throw new Error("The UNIT reached the four-round selected-tool analysis limit without evidence or a final answer.");
    },
  });
  let responseFinished = false;
  response.once("close", () => { if (!responseFinished) handle.cancel(); });
  request.once("aborted", () => handle.cancel());
  try { const content = await handle.result; responseFinished = true; writeSyntheticChatStream(response, content); }
  catch (error) {
    responseFinished = true;
    if (error instanceof JobManagerError && error.cause instanceof Error) {
      const safeCause = error.cause.message.replace(/((?:api[_ -]?key|authorization|bearer))\s*[:=]\s*\S+/gi, "$1 [REDACTED]").slice(0, 500);
      throw new Error(`Selected-tool UNIT analysis failed: ${safeCause}`);
    }
    throw error;
  }
}

type HunterToolResultState =
  | { status: "pending" }
  | { status: "completed"; result: unknown }
  | { status: "failed"; error: string; errorCode?: string };

type MaritimeBridgeSnapshot = {
  receivedAt: string;
  enabled: boolean;
  status: string;
  regionLabel: string;
  lastMessageAt: string | null;
  errorRate: number;
  recordsPerHour: number;
  expectedBaseline: number;
  silentZero: boolean;
  aiContextEligible: boolean;
  observations: HunterSeekerPublicObservation[];
};

let maritimeBridgeSnapshot: MaritimeBridgeSnapshot | null = null;

function maritimeBridgeData() {
  const snapshot = maritimeBridgeSnapshot;
  const bridgeAgeMs = snapshot ? Date.now() - Date.parse(snapshot.receivedAt) : Number.POSITIVE_INFINITY;
  const available = Boolean(snapshot?.enabled && bridgeAgeMs <= 15_000);
  const status = snapshot?.status ?? "unavailable";
  const excluded = !available || ["degraded", "down", "rate-limited", "disabled", "stopped", "unavailable"].includes(status);
  const silentZero = snapshot?.silentZero ?? Boolean(available && snapshot?.enabled && !snapshot.observations.length);
  return {
    observations: available ? snapshot!.observations : [],
    healthSources: [{
      id: "aisstream.maritime",
      name: "aisstream.io Maritime",
      status,
      enabled: snapshot?.enabled ?? false,
      lastSuccessAt: snapshot?.lastMessageAt ?? null,
      nextAllowedAt: null,
      nextScheduledAt: null,
      cachedObservations: snapshot?.observations.length ?? 0,
      errorRate: snapshot?.errorRate ?? (excluded ? 1 : 0),
      recordsPerHour: snapshot?.recordsPerHour ?? 0,
      expectedBaseline: snapshot?.expectedBaseline ?? 1,
      silentZero,
      aiContextEligible: Boolean(snapshot?.aiContextEligible && !excluded && !silentZero),
      message: snapshot ? `Protected AIS bridge for ${snapshot.regionLabel}; published ${Math.max(0, Math.round(bridgeAgeMs / 1_000))} seconds ago.` : "Protected AIS bridge has not published a snapshot.",
    }],
    coverageLimitations: [
      "Only enabled sources and their current volatile cached snapshot are covered.",
      snapshot ? `AIS coverage is limited to the operator-selected ${snapshot.regionLabel} region; bridge status is ${snapshot.status}.` : "AIS coverage is unavailable because the protected desktop maritime bridge has not published a snapshot.",
      available ? `The protected AIS snapshot was published ${Math.max(0, Math.round(bridgeAgeMs / 1_000))} seconds ago.` : "A disabled or stale maritime bridge yields no vessels and is not evidence of absence.",
      "Provider outages, rate limits, stale feeds, and non-broadcasting entities create coverage gaps.",
    ],
  };
}

function acceptMaritimeBridgeSnapshot(body: Record<string, unknown>) {
  if (body.sourceId !== "aisstream.maritime" || typeof body.enabled !== "boolean" || typeof body.status !== "string" || typeof body.regionLabel !== "string" || !Array.isArray(body.observations)) {
    throw new Error("The protected maritime snapshot is invalid.");
  }
  if (body.observations.length > 2_000) throw new Error("The protected maritime snapshot exceeds the 2,000-vessel limit.");
  const observations = body.observations.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A maritime observation is invalid.");
    const observation = value as Record<string, unknown>;
    const position = observation.position as Record<string, unknown> | undefined;
    const provenance = observation.provenance as Record<string, unknown> | undefined;
    if (typeof observation.observationId !== "string" || typeof observation.entityId !== "string" || observation.entityType !== "maritime-vessel"
      || !position || typeof position.latitude !== "number" || typeof position.longitude !== "number"
      || !provenance || provenance.sourceFeedId !== "aisstream.maritime" || typeof provenance.fetchedAt !== "string" || typeof provenance.stalenessMs !== "number"
      || typeof observation.timestamp !== "string" || typeof observation.confidence !== "number" || !["measured", "derived", "estimated"].includes(String(observation.basis))) {
      throw new Error("A maritime observation failed the protected bridge contract.");
    }
    const clean = structuredClone(observation);
    delete clean.rawPayload;
    return clean as HunterSeekerPublicObservation;
  });
  maritimeBridgeSnapshot = {
    receivedAt: new Date().toISOString(),
    enabled: body.enabled,
    status: body.status.slice(0, 50),
    regionLabel: body.regionLabel.slice(0, 100),
    lastMessageAt: typeof body.lastMessageAt === "string" ? body.lastMessageAt : null,
    errorRate: typeof body.errorRate === "number" && Number.isFinite(body.errorRate) ? Math.max(0, Math.min(1, body.errorRate)) : 0,
    recordsPerHour: typeof body.recordsPerHour === "number" && Number.isFinite(body.recordsPerHour) ? Math.max(0, Math.round(body.recordsPerHour)) : 0,
    expectedBaseline: typeof body.expectedBaseline === "number" && Number.isFinite(body.expectedBaseline) ? Math.max(0, body.expectedBaseline) : 1,
    silentZero: body.silentZero === true,
    aiContextEligible: body.aiContextEligible === true,
    observations,
  };
  if (body.enabled) enqueueHistoricalObservations(observations);
  return { accepted: observations.length, receivedAt: maritimeBridgeSnapshot.receivedAt };
}

async function createHunterOsintDraft(body: Record<string, unknown>) {
  const requestedAt = new Date().toISOString();
  const objective = typeof body.objective === "string" ? body.objective : undefined;
  if (typeof body.observationId === "string" && body.observationId.trim()) {
    const observationId = body.observationId.trim();
    const live = (await hunterSeekerService.snapshot()).observations;
    const observation = [...live, ...maritimeBridgeData().observations].find((item) => item.observationId === observationId)
      ?? (body.observation && typeof body.observation === "object" && !Array.isArray(body.observation) ? body.observation as HunterSeekerPublicObservation : undefined);
    if (!observation || observation.observationId !== observationId) throw new Error("The selected Hunter-Seeker observation is no longer available.");
    return createHunterOsintInvestigationDraft({ observation }, { requestedAt, requestedBy: { kind: "operator", id: "hunter-seeker-interface" }, objective });
  }
  const latitude = Number(body.latitude); const longitude = Number(body.longitude); const radiusKm = body.radiusKm === undefined ? 25 : Number(body.radiusKm);
  return createHunterOsintInvestigationDraft({ region: hunterRegionAroundPoint(latitude, longitude, radiusKm) }, { requestedAt, requestedBy: { kind: "operator", id: "hunter-seeker-map-region" }, objective });
}

function submitLiveOsintCandidate(body: Record<string, unknown>) {
  pruneLiveCandidateSources();
  const investigationId = typeof body.investigationId === "string" ? body.investigationId.trim() : "";
  const leadId = typeof body.leadId === "string" ? body.leadId.trim() : "";
  if (!investigationId || !leadId || investigationId.length > 160 || leadId.length > 160) throw new Error("An exact OSINT investigation and candidate lead are required.");
  const source = liveCandidateSources.get(investigationId);
  if (!source) throw new Error("That volatile OSINT result expired. Run the passive lookup again before submitting a candidate.");
  const lead = source.leads.find((item) => item.id === leadId);
  if (!lead) throw new Error("The selected candidate lead does not belong to that OSINT investigation.");
  const candidate = submitOsintCandidateLeadToHunter({ investigationId, providerId: source.providerId, lead, submittedAt: new Date().toISOString(), submittedBy: { kind: "operator", id: "osint-provider-interface" } });
  return hunterOsintCandidateInbox.submit(candidate);
}

function osintInvestigationIdFromUrl(url: string) {
  const id = decodeURIComponent(url.split("/")[4] ?? "");
  if (!/^[a-z0-9][a-z0-9_-]{7,159}$/i.test(id)) throw new Error("A valid OSINT investigation ID is required.");
  return id;
}

async function osintInvestigationDetail(investigationId: string) {
  const view = (await ensureOsintStore()).getInvestigationView(investigationId); if (!view) return null;
  const providerIds = [...new Set(view.evidence.map(({ providerId }) => providerId))];
  const providerAttribution = providerIds.map((providerId) => {
    const descriptor = LIVE_OSINT_PROVIDER_DESCRIPTORS.find(({ id }) => id === providerId);
    return descriptor ? { providerId, provider: descriptor.attribution.provider, documentationUrl: descriptor.attribution.documentationUrl, termsUrl: descriptor.attribution.termsUrl } : { providerId, provider: providerId };
  });
  return { ...view, plan: { id: view.investigation.planId, providerIds, execution: "bounded-sequential", automaticExpansion: false, reservations: view.investigation.counts }, providerAttribution };
}

const osintUnitToolRuntime = new OsintUnitToolRuntime({
  executeProvider: (body, options) => runLiveProviderQuery(body, options),
  rememberInvestigation: async ({ id, toolName, output }) => { const project = getActiveProject() as { id: string; osintMemoryLimitBytes: number } | null; if (!project) return; await queueOsintStoreWrite((store) => store.saveUnitMemory({ id, projectId: project.id, toolName, summary: output, limitBytes: project.osintMemoryLimitBytes })); },
  resolveHunterObservation: async (observationId) => {
    const snapshot = await hunterSeekerService.snapshot();
    return [...snapshot.observations, ...maritimeBridgeData().observations].find((observation) => observation.observationId === observationId);
  },
});

const hunterSeekerToolRuntime = new HunterSeekerToolRuntime(hunterSeekerService, undefined, undefined, maritimeBridgeData);
const hunterSourceSettingsReady = hunterSeekerService.applySourceSettings(getSettings().hunterSourceSettings);
const hunterToolResults = new Map<string, HunterToolResultState>();
const MAX_HUNTER_TOOL_RESULTS = 100;

function rememberHunterToolResult(jobId: string, state: HunterToolResultState) {
  hunterToolResults.set(jobId, state);
  while (hunterToolResults.size > MAX_HUNTER_TOOL_RESULTS) {
    const oldest = hunterToolResults.keys().next().value as string | undefined;
    if (!oldest) break;
    hunterToolResults.delete(oldest);
  }
}

function hunterJobIdFromUrl(url: string) {
  const candidate = decodeURIComponent(url.split("/")[4] ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(candidate)) throw new Error("A valid Hunter-Seeker job id is required.");
  return candidate;
}

function hunterJobSnapshot(jobId: string) {
  const job = voidcatJobManager.snapshot(jobId);
  if (job.module !== "hunter-seeker") throw new JobManagerError("JOB_NOT_FOUND", `Hunter-Seeker job ${jobId} was not found.`);
  return job;
}

export function localErrorStatus(error: unknown) {
  if (error instanceof StorageBudgetError) {
    if (error.code === "APPROVAL_REQUIRED" || error.code === "ACTIVE_WRITES") return 409;
    if (error.code === "CANCELLED") return 408;
    if (error.code === "INSUFFICIENT_DISK" || error.code === "BUDGET_EXCEEDED") return 507;
    return 400;
  }
  if (error instanceof OsintStoreError) {
    if (error.code === "BUDGET_REJECTED" || error.code === "INSUFFICIENT_DISK") return 507;
    if (error.code === "CANCELLED") return 408;
    if (error.code === "PRODUCTION_EVICTION_LOCKED") return 409;
    return 400;
  }
  if (error instanceof ToolRegistryError) {
    if (error.code === "TOOL_NOT_FOUND") return 404;
    if (error.code === "RATE_LIMITED" || error.code === "CONCURRENCY_LIMITED") return 429;
    if (error.code === "CANCELLED") return 409;
    if (["INVALID_ARGUMENTS", "INPUT_TOO_LARGE", "TOOL_DISABLED"].includes(error.code)) return 400;
  }
  if (error instanceof JobManagerError) {
    if (error.code === "JOB_NOT_FOUND") return 404;
    if (error.code === "QUEUE_FULL") return 429;
    if (error.code === "CANCELLED") return 409;
    if (error.code === "TIMED_OUT" || error.code === "ITERATION_LIMIT" || error.code === "EXTERNAL_CALL_LIMIT") return 408;
  }
  if (error instanceof Error) {
    if (/\bis not configured\.$/i.test(error.message)) return 409;
    if (/\brequest guard is active until\b/i.test(error.message)) return 429;
    if (/\brequires fresh exact-target exposure authorization\b/i.test(error.message)) return 403;
    if (/\b(?:accepts only|exact bounded provider target is required|must use HTTPS)\b/i.test(error.message)) return 400;
    if (/\breturned HTTP\s+\d+\b|\bresponse exceeded the 2 MB safety limit\b/i.test(error.message)) return 502;
  }
  return 500;
}

export function voidcatLocal(): Plugin {
  hunterSeekerToolRuntime.register();
  registerCommandKnowledgeTools();
  type LocalViteServer = ViteDevServer;
  const configureLocalServer = (server: LocalViteServer) => {
      server.middlewares.use((request, response, next) => {
        const token = process.env.VOIDCAT_LAN_TOKEN; if (!token) { next(); return; }
        const remote = request.socket.remoteAddress ?? ""; if (remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1") { next(); return; }
        const requestUrl = new URL(request.url ?? "/", "http://voidcat.local"); const supplied = requestUrl.searchParams.get("voidcat_token"); const cookie = request.headers.cookie?.split(";").map((value) => value.trim()).find((value) => value.startsWith("voidcat_lan="))?.slice("voidcat_lan=".length);
        if (supplied === token) { requestUrl.searchParams.delete("voidcat_token"); response.statusCode = 302; response.setHeader("Set-Cookie", `voidcat_lan=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`); response.setHeader("Location", `${requestUrl.pathname}${requestUrl.search}`); response.end(); return; }
        if (cookie && decodeURIComponent(cookie) === token) { next(); return; }
        response.statusCode = 401; response.setHeader("Content-Type", "text/html; charset=utf-8"); response.setHeader("Cache-Control", "no-store"); response.end("<!doctype html><meta name=viewport content='width=device-width'><title>VoidCat authentication required</title><body style='background:#07070a;color:#eee9df;font:16px monospace;padding:40px'><h1 style='color:#b7ff2a'>VOIDCAT // AUTHENTICATION REQUIRED</h1><p>Use the authenticated LAN link shown in App Settings on the host computer.</p></body>");
      });
      server.httpServer?.once("close", () => {
        voidcatJobManager.cancelModule("hunter-seeker");
        voidcatJobManager.cancelModule("osint-unit");
        voidcatJobManager.cancelModule("osint-investigation-ui");
        void hunterSeekerService.stop();
        void hunterReplayManager.stop(true);
        hunterStageFiveStore.close();
        hunterHistoryStore.close();
        osintStore?.close();
        osintStore = null;
        osintStoreReady = null;
        osintUnitToolRuntime.dispose();
      });
      server.middlewares.use((request, response, next) => {
        const url = request.url?.split("?")[0];
        if (!url?.startsWith("/api/")) { next(); return; }
        void (async () => {
          try {
            if (url === "/api/health" && request.method === "GET") sendJson(response, 200, { app: "voidcat-harness", token: process.env.VOIDCAT_DESKTOP_TOKEN || null });
            else if (url === "/api/models" && request.method === "GET") sendJson(response, 200, await scanModels());
            else if (url === "/api/models/search/huggingface" && request.method === "POST") { const body = await readBody(request, 8_192); sendJson(response, 200, await searchHuggingFaceModels(String(body.query ?? ""))); }
            else if (url === "/api/models/files/huggingface" && request.method === "POST") { const body = await readBody(request, 8_192); sendJson(response, 200, await listHuggingFaceModelFiles(String(body.repository ?? ""))); }
            else if (url === "/api/models/ollama" && request.method === "GET") sendJson(response, 200, await listOllamaModels());
            else if (url === "/api/models/downloads" && request.method === "GET") sendJson(response, 200, { jobs: voidcatJobManager.list({ module: "model-download", limit: 30 }) });
            else if (url === "/api/models/downloads" && request.method === "POST") { const body = await readBody(request, 64_000); if (body.kind !== "huggingface" && body.kind !== "ollama") throw new Error("Choose Hugging Face or Ollama."); sendJson(response, 202, startModelDownload(body.kind, String(body.name ?? ""), body.files)); }
            else if (url?.startsWith("/api/models/downloads/") && request.method === "DELETE") sendJson(response, 200, { cancelled: voidcatJobManager.cancel(url.split("/")[4]) });
            else if (url === "/api/runtime/status" && request.method === "GET") sendJson(response, 200, await runtimeStatus());
            else if (url === "/api/osint/providers" && request.method === "GET") {
              const store = await ensureOsintStore();
              let brokerStatuses: unknown[] = [];
              try { brokerStatuses = ((await osintBrokerRequest("/status")).providers as unknown[]) ?? []; } catch { /* local providers still remain discoverable */ }
              const statusById = new Map(brokerStatuses.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value)).map((value) => [String(value.id), value]));
              sendJson(response, 200, { store: store.status(), providers: LIVE_OSINT_PROVIDER_DESCRIPTORS.map((descriptor) => ({ ...descriptor, runtime: statusById.get(descriptor.id) ?? { id: descriptor.id, configured: descriptor.authentication.kind === "none" && !descriptor.authentication.credentialNamespace, cacheEntries: 0, lastStatus: descriptor.transport === "local" ? "ready" : "unavailable", lastError: descriptor.transport === "electron-broker" ? "Protected desktop broker is unavailable." : null } })) });
            }
            else if (url === "/api/osint/store/status" && request.method === "GET") sendJson(response, 200, (await ensureOsintStore()).status());
            else if (url === "/api/osint/unit/tools" && request.method === "GET") sendJson(response, 200, { tools: osintUnitToolRuntime.discover(), providerSelection: "server-policy-only" });
            else if (url === "/api/command/tools" && request.method === "GET") sendJson(response, 200, { tools: [...hunterSeekerToolRuntime.discover(), ...osintUnitToolRuntime.discover(), ...voidcatToolRegistry.discover({ module: "voidcat-knowledge" })] });
            else if (url === "/api/osint/unit/exposure-approvals" && request.method === "POST") {
              const body = await readBody(request, 8_192); if (body.confirmed !== true) throw new Error("Explicit operator confirmation is required.");
              sendJson(response, 201, osintUnitToolRuntime.authorizeExposure({ targetType: body.targetType as "email-address" | "domain", exactTarget: String(body.exactTarget ?? ""), statement: String(body.authorizationStatement ?? "") }));
            }
            else if (url === "/api/osint/unit/jobs" && request.method === "GET") sendJson(response, 200, { jobs: voidcatJobManager.list({ module: "osint-unit", limit: 30 }) });
            else if (url === "/api/osint/unit/jobs/events" && request.method === "GET") {
              response.statusCode = 200; response.setHeader("Content-Type", "text/event-stream"); response.setHeader("Cache-Control", "no-cache"); response.setHeader("Connection", "keep-alive");
              const publish = () => response.write(`data: ${JSON.stringify({ jobs: voidcatJobManager.list({ module: "osint-unit", limit: 30 }) })}\n\n`); publish();
              const unsubscribe = voidcatJobManager.subscribe((snapshot) => { if (snapshot.module === "osint-unit") publish(); }); const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 15_000); request.once("close", () => { clearInterval(heartbeat); unsubscribe(); });
            }
            else if (url?.startsWith("/api/osint/unit/jobs/") && request.method === "DELETE") {
              const jobId = decodeURIComponent(url.split("/")[5] ?? ""); const job = voidcatJobManager.snapshot(jobId); if (job.module !== "osint-unit") throw new JobManagerError("JOB_NOT_FOUND", "The OSINT UNIT job was not found."); sendJson(response, 200, { cancelled: voidcatJobManager.cancel(jobId), jobId });
            }
            else if (url === "/api/osint/investigations/preview" && request.method === "POST") sendJson(response, 200, osintInvestigationWorkspace.preview(await readBody(request, 32_768) as unknown as OsintInvestigationWorkspaceInput));
            else if (url === "/api/osint/investigations/start" && request.method === "POST") sendJson(response, 202, osintInvestigationWorkspace.start(await readBody(request, 32_768) as unknown as OsintInvestigationWorkspaceInput));
            else if (url === "/api/osint/investigations/jobs" && request.method === "GET") sendJson(response, 200, { jobs: voidcatJobManager.list({ module: "osint-investigation-ui", limit: 50 }) });
            else if (url === "/api/osint/investigations/jobs/events" && request.method === "GET") {
              response.statusCode = 200; response.setHeader("Content-Type", "text/event-stream"); response.setHeader("Cache-Control", "no-cache"); response.setHeader("Connection", "keep-alive");
              const publish = () => response.write(`data: ${JSON.stringify({ jobs: voidcatJobManager.list({ module: "osint-investigation-ui", limit: 50 }) })}\n\n`); publish();
              const unsubscribe = voidcatJobManager.subscribe((snapshot) => { if (snapshot.module === "osint-investigation-ui") publish(); }); const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 15_000); request.once("close", () => { clearInterval(heartbeat); unsubscribe(); });
            }
            else if (url?.startsWith("/api/osint/investigations/jobs/") && request.method === "DELETE") {
              const jobId = decodeURIComponent(url.split("/")[5] ?? ""); const job = voidcatJobManager.snapshot(jobId); if (job.module !== "osint-investigation-ui") throw new JobManagerError("JOB_NOT_FOUND", "The OSINT investigation job was not found."); sendJson(response, 200, { cancelled: voidcatJobManager.cancel(jobId), jobId });
            }
            else if (url === "/api/osint/investigations" && request.method === "GET") sendJson(response, 200, { investigations: (await ensureOsintStore()).listInvestigations(200, getActiveProjectId()) });
            else if (url === "/api/osint/project-usage" && request.method === "GET") sendJson(response, 200, (await ensureOsintStore()).projectUsage(getActiveProjectId()));
            else if (/^\/api\/osint\/investigations\/[^/]+\/report$/.test(url) && request.method === "GET") {
              const investigationId = osintInvestigationIdFromUrl(url); const view = (await ensureOsintStore()).getInvestigationView(investigationId); if (!view) { sendJson(response, 404, { error: "The OSINT investigation was not found." }); return; }
              sendJson(response, 200, { investigationId, filename: `voidcat-osint-${investigationId}.md`, mimeType: "text/markdown", content: renderStoredInvestigationReport(view) });
            }
            else if (/^\/api\/osint\/investigations\/[^/]+\/leads\/[^/]+$/.test(url) && request.method === "POST") {
              const investigationId = osintInvestigationIdFromUrl(url); const leadId = decodeURIComponent(url.split("/")[6] ?? ""); if (!leadId || leadId.length > 160) throw new Error("A bounded candidate lead ID is required."); const body = await readBody(request, 2_048); if (body.status !== "approved" && body.status !== "rejected") throw new Error("Candidate review status must be approved or rejected."); sendJson(response, 200, await queueOsintStoreWrite((store) => store.setCandidateLeadStatus(investigationId, leadId, body.status as "approved" | "rejected")));
            }
            else if (/^\/api\/osint\/investigations\/[^/]+$/.test(url) && request.method === "GET") {
              const detail = await osintInvestigationDetail(osintInvestigationIdFromUrl(url)); if (!detail) sendJson(response, 404, { error: "The OSINT investigation was not found." }); else sendJson(response, 200, detail);
            }
            else if (url === "/api/osint/hunter/intake" && request.method === "POST") sendJson(response, 201, await createHunterOsintDraft(await readBody(request, 256_000)));
            else if (url === "/api/osint/hunter/candidates" && request.method === "POST") sendJson(response, 201, submitLiveOsintCandidate(await readBody(request, 8_192)));
            else if (url === "/api/osint/providers/query" && request.method === "POST") sendJson(response, 200, await runLiveProviderQuery(await readBody(request, 32_768)));
            else if (url === "/api/hunter-seeker/osint-candidates" && request.method === "GET") sendJson(response, 200, { candidates: hunterOsintCandidateInbox.list(), persistence: "volatile", automaticActions: false });
            else if (url?.startsWith("/api/hunter-seeker/osint-candidates/") && request.method === "DELETE") {
              const id = decodeURIComponent(url.split("/")[4] ?? "");
              if (!id || id.length > 160) throw new Error("A bounded Hunter candidate id is required.");
              const dismissed = hunterOsintCandidateInbox.dismiss(id);
              sendJson(response, dismissed ? 200 : 404, { dismissed, id });
            }
            else if (url === "/api/hunter-seeker/status" && request.method === "GET") { await hunterSourceSettingsReady; sendJson(response, 200, await hunterSnapshotWithHistory(await hunterSeekerService.snapshot())); }
            else if (url === "/api/hunter-seeker/start" && request.method === "POST") { await hunterSourceSettingsReady; sendJson(response, 200, await hunterSnapshotWithHistory(await hunterSeekerService.start())); }
            else if (url === "/api/hunter-seeker/refresh" && request.method === "POST") { await hunterSourceSettingsReady; sendJson(response, 200, await hunterSnapshotWithHistory(await hunterSeekerService.refresh())); }
            else if (url === "/api/hunter-seeker/stop" && request.method === "POST") sendJson(response, 200, await hunterSnapshotWithHistory(await hunterSeekerService.stop()));
            else if (url === "/api/hunter-seeker/deflock/viewport" && request.method === "POST") {
              const body = await readBody(request, 4_096);
              await hunterSourceSettingsReady;
              const snapshot = await hunterSeekerService.setDeflockViewport({
                south: body.south as number,
                west: body.west as number,
                north: body.north as number,
                east: body.east as number,
                zoom: body.zoom as number,
              }, { refresh: body.refresh === true });
              sendJson(response, 200, await hunterSnapshotWithHistory(snapshot));
            }
            else if (url === "/api/hunter-seeker/deflock/region" && request.method === "POST") {
              const body = await readBody(request, 1_024);
              if (typeof body.regionId !== "string" || body.regionId.length > 40) throw new Error("A bounded DeFlock region ID is required.");
              await hunterSourceSettingsReady;
              sendJson(response, 200, await hunterSnapshotWithHistory(await hunterSeekerService.setDeflockRegion(body.regionId)));
            }
            else if (url === "/api/hunter-seeker/desktop/maritime-snapshot" && request.method === "POST") {
              const expectedToken = process.env.VOIDCAT_DESKTOP_TOKEN;
              if (!expectedToken || request.headers["x-voidcat-desktop-token"] !== expectedToken) {
                sendJson(response, 403, { error: "Protected desktop bridge authentication failed." });
              } else sendJson(response, 200, acceptMaritimeBridgeSnapshot(await readBody(request, 4_000_000)));
            }
            else if (url === "/api/hunter-seeker/tools" && request.method === "GET") {
              sendJson(response, 200, {
                tools: hunterSeekerToolRuntime.discover(),
                note: "Six bounded read-only tools use current volatile snapshots. AIS data crosses only through the authenticated desktop bridge and is never persisted.",
              });
            }
            else if (url === "/api/hunter-seeker/tools/invoke" && request.method === "POST") {
              const body = await readBody(request);
              if (typeof body.name !== "string") throw new Error("A Hunter-Seeker tool name is required.");
              if (!body.arguments || typeof body.arguments !== "object" || Array.isArray(body.arguments)) throw new Error("Hunter-Seeker tool arguments must be an object.");
              const handle = hunterSeekerToolRuntime.startInvocation(body.name, body.arguments as Record<string, unknown>, { kind: "user", id: "local-interface" });
              rememberHunterToolResult(handle.id, { status: "pending" });
              void handle.result.then(
                (result) => rememberHunterToolResult(handle.id, { status: "completed", result }),
                (error) => rememberHunterToolResult(handle.id, {
                  status: "failed",
                  error: error instanceof Error ? error.message : "Hunter-Seeker tool job failed.",
                  errorCode: error instanceof JobManagerError || error instanceof ToolRegistryError ? error.code : undefined,
                }),
              );
              sendJson(response, 202, { job: handle.snapshot() });
            }
            else if (url === "/api/hunter-seeker/history/settings" && request.method === "GET") {
              sendJson(response, 200, { settings: getSettings().hunterHistory, status: await historyStatusSnapshot() });
            }
            else if (url === "/api/hunter-seeker/history/settings" && request.method === "PATCH") {
              const body = await readBody(request);
              const current = getSettings().hunterHistory;
              const saved = saveSettings({ hunterHistory: {
                enabled: typeof body.enabled === "boolean" ? body.enabled : current.enabled,
                retentionDays: typeof body.retentionDays === "number" ? body.retentionDays : current.retentionDays,
                selectedLibraryIds: Array.isArray(body.selectedLibraryIds) ? body.selectedLibraryIds as string[] : current.selectedLibraryIds,
                includeUploads: typeof body.includeUploads === "boolean" ? body.includeUploads : current.includeUploads,
              } });
              if (saved.hunterHistory.enabled) await hunterHistoryStore.enable(); else hunterHistoryStore.disable();
              sendJson(response, 200, { settings: saved.hunterHistory, status: await historyStatusSnapshot() });
            }
            else if (url === "/api/hunter-seeker/history/query" && request.method === "POST") {
              await ensureHunterStageReady();
              if (!hunterHistoryStore.isInitialized()) throw new Error("No historical store exists yet.");
              const body = await readBody(request);
              sendJson(response, 200, { mode: "HISTORICAL", observations: hunterHistoryStore.query({
                entityId: typeof body.entityId === "string" ? body.entityId : undefined,
                entityType: typeof body.entityType === "string" ? body.entityType : undefined,
                sourceIds: Array.isArray(body.sourceIds) ? body.sourceIds.filter((value): value is string => typeof value === "string") : undefined,
                bbox: body.bbox && typeof body.bbox === "object" ? body.bbox as { west: number; south: number; east: number; north: number } : undefined,
                startAt: typeof body.startAt === "string" ? body.startAt : undefined,
                endAt: typeof body.endAt === "string" ? body.endAt : undefined,
                limit: typeof body.limit === "number" ? body.limit : undefined,
              }) });
            }
            else if (url === "/api/hunter-seeker/history/search" && request.method === "POST") {
              const body = await readBody(request);
              if (typeof body.query !== "string") throw new Error("A historical question is required.");
              sendJson(response, 200, await searchHistory(body.query));
            }
            else if (url === "/api/hunter-seeker/history/derived" && request.method === "POST") {
              const body = await readBody(request);
              await ensureHunterStageReady();
              if (!hunterHistoryStore.isEnabled()) throw new Error("Historical recording is off.");
              sendJson(response, 201, await hunterHistoryStore.createDerivedEvent({
                title: String(body.title ?? ""), content: String(body.content ?? ""),
                entityId: typeof body.entityId === "string" ? body.entityId : undefined,
                entityType: typeof body.entityType === "string" ? body.entityType : undefined,
                windowStart: String(body.windowStart ?? ""), windowEnd: String(body.windowEnd ?? ""),
                sourceFeedIds: Array.isArray(body.sourceFeedIds) ? body.sourceFeedIds.filter((value): value is string => typeof value === "string") : [],
                sourceObservationIds: Array.isArray(body.sourceObservationIds) ? body.sourceObservationIds.filter((value): value is string => typeof value === "string") : [],
              }));
            }
            else if (url === "/api/hunter-seeker/history/maintenance/plan" && request.method === "GET") {
              await ensureHunterStageReady(); sendJson(response, 200, hunterHistoryStore.planMaintenance(getSettings().hunterHistory.retentionDays));
            }
            else if (url === "/api/hunter-seeker/history/maintenance" && request.method === "POST") {
              await ensureHunterStageReady();
              const result = await withStorageWrite("hunter", () => hunterHistoryStore.runMaintenance(getSettings().hunterHistory.retentionDays, { maximumGroups: 100 }));
              sendJson(response, 200, result);
            }
            else if (url?.startsWith("/api/hunter-seeker/history/observations/") && request.method === "PATCH") {
              const parts = url.split("/"); const observationId = decodeURIComponent(parts[5] ?? ""); const body = await readBody(request);
              if (!observationId || !["pinned", "watchlist", "trigger"].includes(String(body.retentionClass))) throw new Error("A historical observation and protected retention class are required.");
              sendJson(response, 200, hunterHistoryStore.protectObservation(observationId, body.retentionClass as "pinned" | "watchlist" | "trigger"));
            }
            else if (url?.startsWith("/api/hunter-seeker/history/rag/") && request.method === "DELETE") {
              const id = decodeURIComponent(url.split("/")[5] ?? ""); if (!id) throw new Error("A historical RAG record id is required.");
              sendJson(response, 200, hunterHistoryStore.deleteRagRecord(id));
            }
            else if (url === "/api/hunter-seeker/watchlists" && request.method === "GET") {
              await ensureHunterStageReady(); sendJson(response, 200, { rules: hunterStageFiveStore.listWatchlists() });
            }
            else if (url === "/api/hunter-seeker/watchlists" && request.method === "POST") {
              await ensureHunterStageReady(); const body = await readBody(request);
              sendJson(response, 201, await withStorageWrite("hunter", () => hunterStageFiveStore.saveWatchlist({ kind: body.kind as WatchlistKind, label: String(body.label ?? ""), value: typeof body.value === "string" ? body.value : undefined, geometry: body.geometry as never, enabled: body.enabled !== false })));
            }
            else if (url === "/api/hunter-seeker/watchlists/export" && request.method === "GET") {
              await ensureHunterStageReady(); sendJson(response, 200, hunterStageFiveStore.exportWatchlists());
            }
            else if (url === "/api/hunter-seeker/watchlists/import" && request.method === "POST") {
              await ensureHunterStageReady(); const body = await readBody(request, 2_000_000); sendJson(response, 200, await withStorageWrite("hunter", () => hunterStageFiveStore.importWatchlists(body)));
            }
            else if (url?.startsWith("/api/hunter-seeker/watchlists/") && request.method === "PATCH") {
              await ensureHunterStageReady(); const id = decodeURIComponent(url.split("/")[4] ?? ""); const body = await readBody(request); const current = hunterStageFiveStore.listWatchlists().find((rule) => rule.id === id); if (!current) throw new Error("Watchlist rule was not found.");
              sendJson(response, 200, await withStorageWrite("hunter", () => hunterStageFiveStore.saveWatchlist({ id, kind: (body.kind ?? current.kind) as WatchlistKind, label: String(body.label ?? current.label), value: typeof body.value === "string" ? body.value : current.value ?? undefined, geometry: (body.geometry ?? current.geometry) as never, enabled: typeof body.enabled === "boolean" ? body.enabled : current.enabled })));
            }
            else if (url?.startsWith("/api/hunter-seeker/watchlists/") && request.method === "DELETE") {
              await ensureHunterStageReady(); const id = decodeURIComponent(url.split("/")[4] ?? ""); sendJson(response, 200, await withStorageWrite("hunter", () => hunterStageFiveStore.deleteWatchlist(id)));
            }
            else if (url === "/api/hunter-seeker/triggers" && request.method === "GET") {
              await ensureHunterStageReady(); sendJson(response, 200, { events: hunterStageFiveStore.listTriggers(200) });
            }
            else if (url === "/api/hunter-seeker/triggers/events" && request.method === "GET") {
              await ensureHunterStageReady(); response.statusCode = 200; response.setHeader("Content-Type", "text/event-stream"); response.setHeader("Cache-Control", "no-cache"); response.setHeader("Connection", "keep-alive"); response.flushHeaders?.();
              response.write(`data: ${JSON.stringify({ type: "connected", events: hunterStageFiveStore.listTriggers(20) })}\n\n`);
              const listener = (events: TriggerEvent[]) => response.write(`data: ${JSON.stringify({ type: "triggered", events })}\n\n`); hunterTriggerListeners.add(listener);
              const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 15_000); const close = () => { clearInterval(keepAlive); hunterTriggerListeners.delete(listener); if (!response.writableEnded) response.end(); }; request.once("close", close); request.once("aborted", close);
            }
            else if (url?.startsWith("/api/hunter-seeker/triggers/") && request.method === "PATCH") {
              await ensureHunterStageReady(); const id = decodeURIComponent(url.split("/")[4] ?? ""); sendJson(response, 200, hunterStageFiveStore.acknowledgeTrigger(id));
            }
            else if (url === "/api/hunter-seeker/health/history" && request.method === "GET") {
              await ensureHunterStageReady(); sendJson(response, 200, { samples: hunterStageFiveStore.healthHistory(undefined, 1_000) });
            }
            else if (url?.startsWith("/api/hunter-seeker/health/history/") && request.method === "GET") {
              await ensureHunterStageReady(); sendJson(response, 200, { samples: hunterStageFiveStore.healthHistory(decodeURIComponent(url.split("/")[5] ?? ""), 1_000) });
            }
            else if (url === "/api/hunter-seeker/replays" && request.method === "GET") {
              await ensureHunterStageReady(); sendJson(response, 200, { active: hunterReplayManager.activeSnapshot(), replays: await hunterReplayManager.list() });
            }
            else if (url === "/api/hunter-seeker/replays" && request.method === "POST") {
              await ensureHunterStageReady(); const body = await readBody(request); sendJson(response, 201, await withStorageWrite("hunter", () => hunterReplayManager.start({ label: typeof body.label === "string" ? body.label : undefined, durationMs: typeof body.durationMs === "number" ? body.durationMs : undefined, sourceIds: Array.isArray(body.sourceIds) ? body.sourceIds.filter((value): value is string => typeof value === "string") : undefined })));
            }
            else if (url === "/api/hunter-seeker/replays/stop" && request.method === "POST") {
              await hunterHistoryWriteQueue;
              sendJson(response, 200, await withStorageWrite("hunter", () => hunterReplayManager.stop(false)));
            }
            else if (url?.startsWith("/api/hunter-seeker/replays/") && url.endsWith("/load") && request.method === "POST") {
              await ensureHunterStageReady(); const id = decodeURIComponent(url.split("/")[4] ?? ""); sendJson(response, 200, await hunterReplayManager.load(id));
            }
            else if (url === "/api/hunter-seeker/jobs" && request.method === "GET") {
              sendJson(response, 200, { jobs: voidcatJobManager.list({ module: "hunter-seeker", limit: 30 }) });
            }
            else if (url === "/api/hunter-seeker/jobs/events" && request.method === "GET") {
              response.statusCode = 200;
              response.setHeader("Content-Type", "text/event-stream");
              response.setHeader("Cache-Control", "no-cache");
              response.setHeader("Connection", "keep-alive");
              response.flushHeaders?.();
              const publish = () => response.write(`data: ${JSON.stringify({ jobs: voidcatJobManager.list({ module: "hunter-seeker", limit: 30 }) })}\n\n`);
              response.write("retry: 2000\n\n");
              publish();
              const unsubscribe = voidcatJobManager.subscribe((snapshot) => { if (snapshot.module === "hunter-seeker") publish(); });
              const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
              const close = () => { clearInterval(keepAlive); unsubscribe(); if (!response.writableEnded) response.end(); };
              request.once("close", close);
              request.once("aborted", close);
            }
            else if (url?.startsWith("/api/hunter-seeker/jobs/") && request.method === "GET") {
              const jobId = hunterJobIdFromUrl(url);
              const job = hunterJobSnapshot(jobId);
              const result = hunterToolResults.get(jobId);
              sendJson(response, result ? 200 : 404, result ? { job, ...result } : { job, error: "No tool result is available for this job." });
            }
            else if (url?.startsWith("/api/hunter-seeker/jobs/") && request.method === "DELETE") {
              const jobId = hunterJobIdFromUrl(url);
              hunterJobSnapshot(jobId);
              const cancelled = voidcatJobManager.cancel(jobId);
              sendJson(response, 200, { cancelled, job: hunterJobSnapshot(jobId) });
            }
            else if (url?.startsWith("/api/hunter-seeker/sources/") && request.method === "PATCH") {
              const sourceId = decodeURIComponent(url.split("/")[4] ?? "");
              if (!sourceId) throw new Error("Hunter-Seeker source id is required.");
              const body = await readBody(request);
              await hunterSourceSettingsReady;
              const snapshot = await hunterSeekerService.configureSource(sourceId, {
                enabled: body.enabled as boolean | undefined,
                pollCadenceMs: body.pollCadenceMs as number | undefined,
                requestBudgetPercent: body.requestBudgetPercent as number | undefined,
              });
              const configured = snapshot.sources.find((source) => source.descriptor.id === sourceId);
              if (configured) {
                const settings = getSettings();
                saveSettings({ hunterSourceSettings: {
                  ...settings.hunterSourceSettings,
                  [sourceId]: {
                    enabled: configured.health.enabled,
                    pollCadenceMs: configured.health.pollCadenceMs,
                    requestBudgetPercent: configured.health.requestBudgetPercent,
                  },
                } });
              }
              sendJson(response, 200, await hunterSnapshotWithHistory(snapshot));
            }
            else if (url === "/api/diagnostics" && request.method === "GET") sendJson(response, 200, await collectDiagnostics());
            else if (url === "/api/storage/budgets" && request.method === "GET") sendJson(response, 200, await storageBudgetManager.measure());
            else if (url === "/api/storage/events" && request.method === "GET") {
              response.statusCode = 200;
              response.setHeader("Content-Type", "text/event-stream");
              response.setHeader("Cache-Control", "no-cache");
              response.setHeader("Connection", "keep-alive");
              response.flushHeaders?.();
              response.write(`data: ${JSON.stringify({ type: "connected", budgets: storageBudgetManager.listBudgets() })}\n\n`);
              const unsubscribe = storageBudgetManager.subscribe((event) => response.write(`data: ${JSON.stringify(event)}\n\n`));
              const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
              const close = () => { clearInterval(keepAlive); unsubscribe(); if (!response.writableEnded) response.end(); };
              request.once("close", close); request.once("aborted", close);
            }
            else if (url?.startsWith("/api/storage/budgets/") && request.method === "PATCH") {
              const budgetId = decodeURIComponent(url.split("/")[4] ?? "") as StorageBudgetId;
              const body = await readBody(request);
              const configured = storageBudgetManager.configure(budgetId, {
                limitBytes: typeof body.limitBytes === "number" ? body.limitBytes : undefined,
                highWatermark: typeof body.highWatermark === "number" ? body.highWatermark : undefined,
                lowWatermark: typeof body.lowWatermark === "number" ? body.lowWatermark : undefined,
              });
              const current = getSettings();
              saveSettings({ storageBudgetSettings: { ...current.storageBudgetSettings, [budgetId]: {
                limitBytes: configured.limitBytes, highWatermark: configured.highWatermark, lowWatermark: configured.lowWatermark,
              } } });
              sendJson(response, 200, configured);
            }
            else if (url === "/api/storage/cleanup/dry-run" && request.method === "POST") {
              const body = await readBody(request);
              if (typeof body.budgetId !== "string") throw new Error("A storage budget id is required.");
              sendJson(response, 200, await storageBudgetManager.dryRun(body.budgetId as StorageBudgetId));
            }
            else if (url === "/api/storage/clear" && request.method === "POST") {
              throw new StorageBudgetError("APPROVAL_REQUIRED", "Real eviction is disabled until the Stage 4 dry-run and synthetic stress reports are approved.");
            }
            else if (url === "/api/state" && request.method === "GET") sendJson(response, 200, getState());
            else if (url === "/api/projects" && request.method === "GET") sendJson(response, 200, { projects: listProjects() });
            else if (url === "/api/projects" && request.method === "POST") sendJson(response, 201, createProject(await readBody(request) as ProjectInput));
            else if (url === "/api/projects/export" && request.method === "GET") sendJson(response, 200, exportActiveProject());
            else if (url === "/api/projects/import" && request.method === "POST") sendJson(response, 201, importProjectArchive(await readBody(request, 10 * 1024 * 1024)));
            else if (url === "/api/backups" && request.method === "POST") sendJson(response, 201, await storageBudgetManager.backup(path.join(process.cwd(), ".voidcat", "backups")));
            else if (url?.startsWith("/api/projects/")) {
              const parts = url.split("/").filter(Boolean); const projectId = parts[2];
              if (!projectId) throw new Error("A project id is required.");
              if (parts[3] === "select" && request.method === "POST") sendJson(response, 200, selectProject(projectId));
              else if (request.method === "PATCH") {
                const body = await readBody(request) as Partial<ProjectInput>;
                if (typeof body.osintMemoryLimitBytes === "number") {
                  const usage = (await ensureOsintStore()).projectUsage(projectId);
                  if (Math.round(body.osintMemoryLimitBytes) < usage.bytes) throw new Error("The OSINT allotment cannot be lowered below this project's current persistent OSINT usage.");
                }
                sendJson(response, 200, updateProject(projectId, body));
              }
              else sendJson(response, 405, { error: "Unsupported project operation." });
            }
            else if (url === "/api/conversations" && request.method === "POST") sendJson(response, 201, createConversation(await readBody(request) as { title?: string; profileId?: string; modelKey?: string; webMode?: WebMode }));
            else if (url?.startsWith("/api/conversations/")) {
              const parts = url.split("/").filter(Boolean);
              const conversationId = parts[2];
              if (!conversationId) throw new Error("Conversation id is required.");
              if (parts[3] === "messages" && request.method === "POST") {
                const body = await readBody(request);
                if (typeof body.role !== "string" || typeof body.content !== "string") throw new Error("Message role and content are required.");
                sendJson(response, 201, addMessage(conversationId, body.role, body.content, Array.isArray(body.sources) ? body.sources : []));
              } else if (request.method === "GET") sendJson(response, 200, getConversation(conversationId));
              else if (request.method === "PATCH") sendJson(response, 200, updateConversation(conversationId, await readBody(request) as { title?: string; profileId?: string; modelKey?: string; webMode?: WebMode }));
              else if (request.method === "DELETE") sendJson(response, 200, deleteConversation(conversationId));
              else sendJson(response, 405, { error: "Unsupported conversation operation." });
            }
            else if (url === "/api/profiles" && request.method === "POST") sendJson(response, 201, saveProfile(await readBody(request) as ProfileInput));
            else if (url?.startsWith("/api/profiles/") && request.method === "PATCH") sendJson(response, 200, saveProfile({ ...(await readBody(request) as ProfileInput), id: url.split("/")[3] }));
            else if (url?.startsWith("/api/profiles/") && request.method === "DELETE") sendJson(response, 200, deleteProfile(url.split("/")[3]));
            else if (url === "/api/memories" && request.method === "POST") sendJson(response, 201, await saveIndexedMemory(await readBody(request) as MemoryInput));
            else if (url === "/api/memories/search" && request.method === "POST") {
              const body = await readBody(request);
              if (typeof body.query !== "string" || !body.query.trim()) throw new Error("A memory query is required.");
              sendJson(response, 200, { results: await searchMemories(body.query) });
            }
            else if (url === "/api/memories/forget" && request.method === "POST") {
              const body = await readBody(request);
              if (typeof body.query !== "string" || !body.query.trim()) throw new Error("A memory description is required.");
              const normalized = body.query.trim().toLowerCase();
              const exact = getMemoryCandidates().find((memory) => memory.content.toLowerCase() === normalized || memory.content.toLowerCase().includes(normalized));
              if (exact) { deleteMemory(exact.id); sendJson(response, 200, { deleted: exact.id, content: exact.content }); }
              else {
                const match = (await searchMemories(body.query))[0];
                if (!match || match.relevance < 0.42) sendJson(response, 404, { error: "No close approved memory was found." });
                else { deleteMemory(match.id); sendJson(response, 200, { deleted: match.id, content: match.content }); }
              }
            }
            else if (url?.startsWith("/api/memories/") && request.method === "PATCH") sendJson(response, 200, await saveIndexedMemory({ ...(await readBody(request) as MemoryInput), id: url.split("/")[3] }));
            else if (url?.startsWith("/api/memories/") && request.method === "DELETE") sendJson(response, 200, deleteMemory(url.split("/")[3]));
            else if (url === "/api/settings" && request.method === "PATCH") sendJson(response, 200, saveSettings(await readBody(request) as SettingsInput));
            else if (url === "/api/news/sources" && request.method === "GET") sendJson(response, 200, { sources: newsCatalog() });
            else if (url === "/api/news/refresh" && request.method === "POST") {
              const body = await readBody(request); if (!Array.isArray(body.sourceIds)) throw new Error("Select at least one news source.");
              sendJson(response, 200, await refreshNews(body.sourceIds.filter((id): id is string => typeof id === "string"), { force: body.force === true }));
            }
            else if (url === "/api/web/search" && request.method === "POST") {
              const body = await readBody(request);
              if (typeof body.query !== "string" || !body.query.trim()) throw new Error("A web search query is required.");
              sendJson(response, 200, await searchWeb(body.query.slice(0, 500)));
            }
            else if (url === "/api/web/discover" && request.method === "POST") {
              const body = await readBody(request);
              if (typeof body.query !== "string" || !body.query.trim()) throw new Error("A web search query is required.");
              sendJson(response, 200, await discoverWeb(body.query));
            }
            else if (url === "/api/web/fetch" && request.method === "POST") {
              const body = await readBody(request);
              if (typeof body.query !== "string" || !body.query.trim()) throw new Error("A web search query is required.");
              if (!Array.isArray(body.results)) throw new Error("Select at least one webpage.");
              const selected = body.results.map((candidate) => {
                if (!candidate || typeof candidate !== "object") throw new Error("A selected webpage is invalid.");
                const value = candidate as Record<string, unknown>;
                if (typeof value.id !== "string" || typeof value.url !== "string" || typeof value.title !== "string") throw new Error("A selected webpage is incomplete.");
                return {
                  id: value.id,
                  provider: getSettings().webProvider,
                  title: value.title.slice(0, 300),
                  url: value.url,
                  snippet: typeof value.snippet === "string" ? value.snippet.slice(0, 1_000) : "",
                } satisfies WebSearchHit;
              });
              if (!selected.length) throw new Error("Select at least one webpage.");
              sendJson(response, 200, await fetchWebSelection(body.query, selected));
            }
            else if (url === "/api/documents" && request.method === "POST") sendJson(response, 201, await ingestDocument(request));
            else if (url?.startsWith("/api/documents/") && request.method === "PATCH") {
              const body = await readBody(request); sendJson(response, 200, await withStorageWrite("rag", () => updateDocument(url.split("/")[3], body.enabled !== false)));
            }
            else if (url?.startsWith("/api/documents/") && request.method === "DELETE") {
              const result = await withStorageWrite("rag", async () => {
                const deleted = deleteDocument(url.split("/")[3]);
                if (deleted.deleteStoredFile && deleted.storedPath) await fs.rm(deleted.storedPath, { force: true });
                return deleted;
              });
              sendJson(response, 200, { deleted: result.deleted });
            }
            else if (url === "/api/rag/folders/status" && request.method === "GET") sendJson(response, 200, { folders: listRagFolders() });
            else if (url === "/api/rag/folders" && request.method === "POST") {
              const body = await readBody(request);
              if (typeof body.path !== "string" || !body.path.trim()) throw new Error("A folder path is required.");
              sendJson(response, 201, await withStorageWrite("rag", () => registerFolder(body.path as string)));
            }
            else if (url?.startsWith("/api/rag/folders/")) {
              const parts = url.split("/").filter(Boolean);
              const folderId = parts[3];
              if (!folderId) throw new Error("A registered folder id is required.");
              if (parts[4] === "scan" && request.method === "POST") sendJson(response, 202, startFolderScan(folderId));
              else if (parts[4] === "scan" && request.method === "DELETE") {
                const job = folderScanJobs.get(folderId);
                if (job) job.controller.abort();
                else {
                  const folder = getRagFolder(folderId) as { status?: string; lastScanStartedAt?: string } | null;
                  if ((folder?.status === "queued" || folder?.status === "scanning") && folder.lastScanStartedAt) cancelRagFolderScan(folderId, folder.lastScanStartedAt);
                }
                sendJson(response, job ? 202 : 200, { id: folderId, cancelRequested: Boolean(job) });
              }
              else if (request.method === "PATCH") {
                const body = await readBody(request);
                sendJson(response, 200, await withStorageWrite("rag", () => updateRagFolder(folderId, { enabled: body.enabled !== false })));
              }
              else if (request.method === "DELETE") {
                if (folderScanJobs.has(folderId)) throw new Error("Cancel the active folder scan before removing this folder.");
                sendJson(response, 200, await withStorageWrite("rag", () => deleteRagFolder(folderId, { deleteDocuments: true })));
              }
              else sendJson(response, 405, { error: "Unsupported registered-folder operation." });
            }
            else if (url === "/api/rag/search" && request.method === "POST") {
              const body = await readBody(request);
              if (typeof body.query !== "string" || !body.query.trim()) throw new Error("A search query is required.");
              sendJson(response, 200, { results: await searchDocuments(body.query) });
            }
            else if (url?.startsWith("/api/rag/citations/") && request.method === "GET") {
              const citation = getRagCitation(url.split("/")[4]);
              sendJson(response, citation ? 200 : 404, citation ?? { error: "The local passage is no longer available." });
            }
            else if (url === "/api/runtime/load" && request.method === "POST") {
              const body = await readBody(request);
              if (typeof body.modelKey !== "string") throw new Error("A unit key is required.");
              sendJson(response, 200, await loadModel(body.modelKey, Number(body.contextLength) || 8192));
            } else if (url === "/api/runtime/unload" && request.method === "POST") {
              try { await runLms(["unload", "voidcat-core"], 120_000); } catch { /* already unloaded */ }
              sendJson(response, 200, await runtimeStatus());
            } else if (url === "/api/chat" && request.method === "POST") await proxyChat(request, response);
            else sendJson(response, 404, { error: "Unknown local endpoint." });
          } catch (error) {
            if (!response.headersSent) sendJson(response, localErrorStatus(error), {
              error: error instanceof Error ? error.message : "Local core failure",
              errorCode: error instanceof JobManagerError || error instanceof ToolRegistryError ? error.code : undefined,
            });
            else response.end();
          }
        })();
      });
  };
  return {
    name: "voidcat-local-core",
    configureServer: configureLocalServer,
    configurePreviewServer(server) { configureLocalServer(server as unknown as LocalViteServer); },
  };
}
