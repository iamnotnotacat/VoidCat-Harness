import {
  ObservationValidationError,
  SourceAdapterHttpError,
  validateNormalizedObservation,
  validateSourceDescriptor,
  type AdapterReportedHealth,
  type NormalizedObservation,
  type SourceAdapter,
  type SourceDescriptor,
} from "./source-adapter.ts";

const ONE_HOUR_MS = 60 * 60 * 1_000;
export const MIN_SOURCE_POLL_CADENCE_MS = 30_000;
export const MAX_SOURCE_POLL_CADENCE_MS = 12 * ONE_HOUR_MS;
export const DEFAULT_SOURCE_POLL_CADENCE_MS = 2 * 60_000;

export type ObservationStoreWrite = {
  accepted: number;
  evicted: number;
  persisted: boolean;
};

export interface ObservationStore {
  readonly mode: "memory" | "persistent";
  write(descriptor: SourceDescriptor, observations: NormalizedObservation[]): Promise<ObservationStoreWrite>;
  read(sourceId?: string): Promise<NormalizedObservation[]>;
  retainUntil(sourceId: string, expiresAt: number): number;
  clear(sourceId?: string): Promise<number>;
  dropRawPayloads(sourceId?: string): Promise<number>;
}

type CachedObservation = {
  observation: NormalizedObservation;
  expiresAt: number;
  storedAt: number;
};

export class InMemoryObservationStore implements ObservationStore {
  readonly mode = "memory" as const;
  private readonly records = new Map<string, Map<string, CachedObservation>>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private prune(sourceId: string) {
    const source = this.records.get(sourceId);
    if (!source) return 0;
    let removed = 0;
    const currentTime = this.now();
    source.forEach((record, id) => {
      if (record.expiresAt <= currentTime) {
        source.delete(id);
        removed += 1;
      }
    });
    if (!source.size) this.records.delete(sourceId);
    return removed;
  }

  async write(descriptor: SourceDescriptor, observations: NormalizedObservation[]) {
    const evictedByTtl = this.prune(descriptor.id);
    const source = this.records.get(descriptor.id) ?? new Map<string, CachedObservation>();
    this.records.set(descriptor.id, source);
    const storedAt = this.now();
    observations.forEach((observation) => source.set(observation.observationId, {
      observation,
      storedAt,
      expiresAt: storedAt + descriptor.cache.ttlMs,
    }));

    let evictedByLimit = 0;
    if (source.size > descriptor.cache.maxObservations) {
      const oldest = [...source.entries()].sort((left, right) => left[1].storedAt - right[1].storedAt);
      for (const [id] of oldest.slice(0, source.size - descriptor.cache.maxObservations)) {
        source.delete(id);
        evictedByLimit += 1;
      }
    }
    return { accepted: observations.length, evicted: evictedByTtl + evictedByLimit, persisted: false };
  }

  async read(sourceId?: string) {
    const ids = sourceId ? [sourceId] : [...this.records.keys()];
    ids.forEach((id) => this.prune(id));
    return ids.flatMap((id) => [...(this.records.get(id)?.values() ?? [])].map(({ observation }) => observation));
  }

  retainUntil(sourceId: string, expiresAt: number) {
    this.prune(sourceId);
    const source = this.records.get(sourceId);
    if (!source || !Number.isFinite(expiresAt) || expiresAt <= this.now()) return 0;
    let retained = 0;
    source.forEach((record) => {
      if (record.expiresAt < expiresAt) {
        record.expiresAt = expiresAt;
        retained += 1;
      }
    });
    return retained;
  }

  async clear(sourceId?: string) {
    if (sourceId) {
      const removed = this.records.get(sourceId)?.size ?? 0;
      this.records.delete(sourceId);
      return removed;
    }
    const removed = [...this.records.values()].reduce((total, source) => total + source.size, 0);
    this.records.clear();
    return removed;
  }

  async dropRawPayloads(sourceId?: string) {
    const ids = sourceId ? [sourceId] : [...this.records.keys()];
    let dropped = 0;
    ids.forEach((id) => this.records.get(id)?.forEach((record) => {
      if (record.observation.rawPayload !== undefined) {
        record.observation = { ...record.observation, rawPayload: undefined };
        dropped += 1;
      }
    }));
    return dropped;
  }
}

type RuntimeStatus = "idle" | "healthy" | "degraded" | "rate-limited" | "disabled" | "stopped";

type SourceRuntime = {
  enabled: boolean;
  pollCadenceMs: number;
  status: RuntimeStatus;
  requestTimes: number[];
  consecutiveFailures: number;
  rejectedRecords: number;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  nextAllowedAt?: number;
  nextAllowedReason?: "local-window" | "hard-hourly" | "provider-retry" | "failure-backoff";
  timer?: ReturnType<typeof setTimeout>;
  controller?: AbortController;
  inFlight?: Promise<SourceRefreshResult>;
};

export type SourceHealthSnapshot = {
  sourceId: string;
  status: RuntimeStatus | AdapterReportedHealth["status"];
  enabled: boolean;
  pollCadenceMs: number;
  message?: string;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  nextAllowedAt?: string;
  consecutiveFailures: number;
  rejectedRecords: number;
  cachedObservations: number;
  hourlyRequests: number;
  creditBudget?: AdapterReportedHealth["creditBudget"];
};

export type SourceRefreshResult = {
  sourceId: string;
  status: "published" | "skipped" | "failed";
  observations: number;
  rejected: number;
  reason?: "disabled" | "stopped" | "in-flight" | "rate-limited" | "backoff";
  error?: string;
  retryAt?: string;
};

export type ObservationListener = (sourceId: string, observations: readonly NormalizedObservation[]) => void;

export type SourceRegistryOptions = {
  store?: ObservationStore;
  now?: () => number;
  random?: () => number;
  backoffBaseMs?: number;
  backoffMaximumMs?: number;
  jitterRatio?: number;
};

export class SourceRegistry {
  private readonly adapters = new Map<string, SourceAdapter>();
  private readonly runtime = new Map<string, SourceRuntime>();
  private readonly listeners = new Set<ObservationListener>();
  private readonly store: ObservationStore;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaximumMs: number;
  private readonly jitterRatio: number;
  private started = false;

  constructor(options: SourceRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.store = options.store ?? new InMemoryObservationStore(this.now);
    this.backoffBaseMs = Math.max(1_000, options.backoffBaseMs ?? 5_000);
    this.backoffMaximumMs = Math.max(this.backoffBaseMs, options.backoffMaximumMs ?? 15 * 60_000);
    this.jitterRatio = Math.max(0, Math.min(0.5, options.jitterRatio ?? 0.2));
  }

  register(adapter: SourceAdapter) {
    validateSourceDescriptor(adapter.descriptor);
    if (adapter.descriptor.retentionPolicy.mode === "persistent" && this.store.mode !== "persistent") {
      throw new Error(`Source adapter ${adapter.descriptor.id} requires a budget-managed observation store before persistent retention can be enabled.`);
    }
    if (this.adapters.has(adapter.descriptor.id)) throw new Error(`Source adapter ${adapter.descriptor.id} is already registered.`);
    this.adapters.set(adapter.descriptor.id, adapter);
    this.runtime.set(adapter.descriptor.id, {
      enabled: true,
      pollCadenceMs: adapter.descriptor.pollCadenceMs,
      status: this.started ? "idle" : "stopped",
      requestTimes: [],
      consecutiveFailures: 0,
      rejectedRecords: 0,
    });
    if (this.started) this.schedule(adapter.descriptor.id, 0);
    return adapter.descriptor;
  }

  unregister(sourceId: string) {
    const state = this.runtime.get(sourceId);
    if (state?.timer) clearTimeout(state.timer);
    state?.controller?.abort();
    this.runtime.delete(sourceId);
    return this.adapters.delete(sourceId);
  }

  list() {
    return [...this.adapters.values()].map(({ descriptor }) => descriptor);
  }

  subscribe(listener: ObservationListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setEnabled(sourceId: string, enabled: boolean) {
    const state = this.requireRuntime(sourceId);
    state.enabled = enabled;
    state.status = enabled ? (this.started ? "idle" : "stopped") : "disabled";
    if (!enabled) {
      this.retainThroughCurrentCadence(sourceId, state);
      if (state.timer) clearTimeout(state.timer);
      state.timer = undefined;
      state.controller?.abort();
    } else if (this.started) {
      const lastSuccessAt = state.lastSuccessAt ? Date.parse(state.lastSuccessAt) : Number.NaN;
      const cadenceReadyAt = Number.isFinite(lastSuccessAt) ? lastSuccessAt + state.pollCadenceMs : this.now();
      const delayMs = Math.max(0, cadenceReadyAt - this.now(), (state.nextAllowedAt ?? 0) - this.now());
      this.schedule(sourceId, delayMs);
    }
  }

  setPollCadence(sourceId: string, pollCadenceMs: number) {
    const state = this.requireRuntime(sourceId);
    if (!Number.isFinite(pollCadenceMs) || pollCadenceMs < MIN_SOURCE_POLL_CADENCE_MS || pollCadenceMs > MAX_SOURCE_POLL_CADENCE_MS) {
      throw new Error("Source pull rate must be between 30 seconds and 12 hours.");
    }
    state.pollCadenceMs = Math.round(pollCadenceMs);
    if (!state.enabled) this.retainThroughCurrentCadence(sourceId, state);
    if (this.started && state.enabled) {
      const waitForBackoff = Math.max(0, (state.nextAllowedAt ?? 0) - this.now());
      this.schedule(sourceId, Math.max(state.pollCadenceMs, waitForBackoff));
    }
    return state.pollCadenceMs;
  }

  start(options: { fetchImmediately?: boolean } = {}) {
    if (this.started) return;
    this.started = true;
    this.adapters.forEach(({ descriptor }) => {
      const state = this.requireRuntime(descriptor.id);
      state.status = state.enabled ? "idle" : "disabled";
      if (state.enabled) this.schedule(descriptor.id, options.fetchImmediately === false ? state.pollCadenceMs : 0);
    });
  }

  stop() {
    this.started = false;
    this.runtime.forEach((state) => {
      if (state.timer) clearTimeout(state.timer);
      state.timer = undefined;
      state.controller?.abort();
      state.status = state.enabled ? "stopped" : "disabled";
    });
  }

  async refresh(sourceId: string, options: { manual?: boolean } = {}): Promise<SourceRefreshResult> {
    const adapter = this.adapters.get(sourceId);
    if (!adapter) throw new Error(`Source adapter ${sourceId} is not registered.`);
    const state = this.requireRuntime(sourceId);
    if (!state.enabled) return this.skipped(sourceId, "disabled");
    if (state.inFlight) return this.skipped(sourceId, "in-flight");

    const currentTime = this.now();
    const bypassLocalWindow = options.manual === true && state.nextAllowedReason === "local-window";
    if (state.nextAllowedAt && state.nextAllowedAt > currentTime && !bypassLocalWindow) {
      return this.skipped(sourceId, state.status === "rate-limited" ? "rate-limited" : "backoff", state.nextAllowedAt);
    }
    if (bypassLocalWindow) {
      state.nextAllowedAt = undefined;
      state.nextAllowedReason = undefined;
      state.status = "idle";
    }
    const requestGate = this.consumeRequestBudget(adapter.descriptor, state, currentTime, options.manual === true);
    if (requestGate) return this.skipped(sourceId, "rate-limited", requestGate.retryAt);

    const controller = new AbortController();
    state.controller = controller;
    state.lastAttemptAt = new Date(currentTime).toISOString();
    const operation = this.executeRefresh(adapter, state, controller);
    state.inFlight = operation;
    try {
      return await operation;
    } finally {
      state.inFlight = undefined;
      state.controller = undefined;
    }
  }

  async refreshAll(options: { manual?: boolean } = {}) {
    return Promise.all(this.list().map(({ id }) => this.refresh(id, options)));
  }

  async observations(sourceId?: string) {
    return this.store.read(sourceId);
  }

  async clearObservations(sourceId?: string) {
    return this.store.clear(sourceId);
  }

  async dropRawPayloads(sourceId?: string) {
    return this.store.dropRawPayloads(sourceId);
  }

  async health(sourceId: string): Promise<SourceHealthSnapshot> {
    const adapter = this.adapters.get(sourceId);
    if (!adapter) throw new Error(`Source adapter ${sourceId} is not registered.`);
    const state = this.requireRuntime(sourceId);
    this.pruneRequestTimes(state, this.now());
    let reported: AdapterReportedHealth | undefined;
    try { reported = await adapter.health(); }
    catch (error) { reported = { status: "degraded", message: error instanceof Error ? error.message : "Adapter health check failed." }; }
    const cachedObservations = (await this.store.read(sourceId)).length;
    const status = this.mergeHealthStatus(state.status, reported.status);
    return {
      sourceId,
      status,
      enabled: state.enabled,
      pollCadenceMs: state.pollCadenceMs,
      message: state.lastError ?? reported.message,
      lastAttemptAt: state.lastAttemptAt,
      lastSuccessAt: state.lastSuccessAt,
      nextAllowedAt: state.nextAllowedAt ? new Date(state.nextAllowedAt).toISOString() : undefined,
      consecutiveFailures: state.consecutiveFailures,
      rejectedRecords: state.rejectedRecords,
      cachedObservations,
      hourlyRequests: state.requestTimes.length,
      creditBudget: reported.creditBudget,
    };
  }

  async healthAll() {
    return Promise.all(this.list().map(({ id }) => this.health(id)));
  }

  private async executeRefresh(adapter: SourceAdapter, state: SourceRuntime, controller: AbortController): Promise<SourceRefreshResult> {
    const sourceId = adapter.descriptor.id;
    const fetchedAt = new Date(this.now()).toISOString();
    try {
      const payload = await adapter.fetch({ signal: controller.signal, requestedAt: fetchedAt });
      if (controller.signal.aborted) return this.skipped(sourceId, "stopped");
      const receivedAt = new Date(this.now()).toISOString();
      const normalized = await adapter.normalize(payload, { fetchedAt, receivedAt });
      if (controller.signal.aborted) return this.skipped(sourceId, "stopped");
      const valid: NormalizedObservation[] = [];
      const candidates = normalized.slice(0, adapter.descriptor.cache.maxObservations);
      let rejected = Math.max(0, normalized.length - candidates.length);
      candidates.forEach((observation) => {
        try {
          validateNormalizedObservation(observation, sourceId);
          valid.push(observation);
        } catch (error) {
          if (!(error instanceof ObservationValidationError)) throw error;
          rejected += 1;
        }
      });
      await this.store.write(adapter.descriptor, valid);
      this.publish(sourceId, valid);
      state.consecutiveFailures = 0;
      state.rejectedRecords += rejected;
      state.lastSuccessAt = receivedAt;
      state.lastError = rejected ? `${rejected} malformed observation${rejected === 1 ? " was" : "s were"} rejected.` : undefined;
      state.status = rejected ? "degraded" : "healthy";
      state.nextAllowedAt = undefined;
      state.nextAllowedReason = undefined;
      return { sourceId, status: "published", observations: valid.length, rejected };
    } catch (error) {
      if (controller.signal.aborted) return this.skipped(sourceId, "stopped");
      state.consecutiveFailures += 1;
      state.lastError = error instanceof Error ? error.message : "Adapter refresh failed.";
      const statusCode = error instanceof SourceAdapterHttpError ? error.statusCode : undefined;
      const retryable = statusCode === 429 || (statusCode !== undefined && statusCode >= 500);
      if (retryable) {
        state.status = statusCode === 429 ? "rate-limited" : "degraded";
        state.nextAllowedAt = this.now() + this.backoffDelay(state.consecutiveFailures, error instanceof SourceAdapterHttpError ? error.retryAfterMs : undefined);
        state.nextAllowedReason = statusCode === 429 ? "provider-retry" : "failure-backoff";
      } else {
        state.status = "degraded";
        state.nextAllowedAt = this.now() + state.pollCadenceMs;
        state.nextAllowedReason = "failure-backoff";
      }
      return {
        sourceId,
        status: "failed",
        observations: 0,
        rejected: 0,
        error: state.lastError,
        retryAt: new Date(state.nextAllowedAt).toISOString(),
      };
    }
  }

  private publish(sourceId: string, observations: NormalizedObservation[]) {
    this.listeners.forEach((listener) => {
      try { listener(sourceId, observations); }
      catch { /* A faulty subscriber cannot interrupt any feed. */ }
    });
  }

  private schedule(sourceId: string, delayMs: number) {
    const adapter = this.adapters.get(sourceId);
    const state = this.runtime.get(sourceId);
    if (!adapter || !state || !this.started || !state.enabled) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.refresh(sourceId).finally(() => {
        if (!this.started || !state.enabled) return;
        const waitForBackoff = Math.max(0, (state.nextAllowedAt ?? 0) - this.now());
        this.schedule(sourceId, Math.max(state.pollCadenceMs, waitForBackoff));
      });
    }, Math.max(0, delayMs));
  }

  private consumeRequestBudget(descriptor: SourceDescriptor, state: SourceRuntime, currentTime: number, bypassWindow = false) {
    this.pruneRequestTimes(state, currentTime);
    const hourly = state.requestTimes;
    if (hourly.length >= descriptor.rateLimit.hardHourlyBudget) {
      state.status = "rate-limited";
      state.nextAllowedAt = hourly[0] + ONE_HOUR_MS;
      state.nextAllowedReason = "hard-hourly";
      return { retryAt: state.nextAllowedAt, reason: state.nextAllowedReason };
    }
    const windowRequests = hourly.filter((timestamp) => timestamp > currentTime - descriptor.rateLimit.windowMs);
    if (!bypassWindow && windowRequests.length >= descriptor.rateLimit.requestsPerWindow) {
      state.status = "rate-limited";
      state.nextAllowedAt = windowRequests[0] + descriptor.rateLimit.windowMs;
      state.nextAllowedReason = "local-window";
      return { retryAt: state.nextAllowedAt, reason: state.nextAllowedReason };
    }
    hourly.push(currentTime);
    return undefined;
  }

  private retainThroughCurrentCadence(sourceId: string, state: SourceRuntime) {
    const lastSuccessAt = state.lastSuccessAt ? Date.parse(state.lastSuccessAt) : Number.NaN;
    const cadenceStartedAt = Number.isFinite(lastSuccessAt) ? lastSuccessAt : this.now();
    this.store.retainUntil(sourceId, cadenceStartedAt + state.pollCadenceMs);
  }

  private pruneRequestTimes(state: SourceRuntime, currentTime: number) {
    state.requestTimes = state.requestTimes.filter((timestamp) => timestamp > currentTime - ONE_HOUR_MS);
  }

  private backoffDelay(failures: number, retryAfterMs?: number) {
    const exponential = Math.min(this.backoffMaximumMs, this.backoffBaseMs * (2 ** Math.max(0, failures - 1)));
    const jitter = exponential * this.jitterRatio * ((this.random() * 2) - 1);
    return Math.max(retryAfterMs ?? 0, Math.round(exponential + jitter));
  }

  private mergeHealthStatus(runtimeStatus: RuntimeStatus, adapterStatus: AdapterReportedHealth["status"]) {
    if (runtimeStatus === "disabled" || runtimeStatus === "stopped" || runtimeStatus === "rate-limited") return runtimeStatus;
    if (adapterStatus === "down") return "down" as const;
    if (runtimeStatus === "degraded" || adapterStatus === "degraded") return "degraded" as const;
    if (runtimeStatus === "idle") return adapterStatus;
    return "healthy" as const;
  }

  private skipped(sourceId: string, reason: SourceRefreshResult["reason"], retryAt?: number): SourceRefreshResult {
    return { sourceId, status: "skipped", observations: 0, rejected: 0, reason, retryAt: retryAt ? new Date(retryAt).toISOString() : undefined };
  }

  private requireRuntime(sourceId: string) {
    const state = this.runtime.get(sourceId);
    if (!state) throw new Error(`Source adapter ${sourceId} is not registered.`);
    return state;
  }
}
