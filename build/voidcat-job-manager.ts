import { randomUUID } from "node:crypto";

export type ManagedJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "timed-out" | "limit-exceeded";

export type ManagedJobCaps = {
  maxIterations: number;
  timeoutMs: number;
  maxExternalCalls: number;
};

export type ManagedJobProgress = {
  current: number;
  total?: number;
  message?: string;
};

export type ManagedJobResources = {
  iterations: number;
  externalCalls: number;
  inputTokens: number;
  outputTokens: number;
  units: number;
  wallClockMs: number;
};

export type ManagedJobSnapshot = {
  id: string;
  module: string;
  name: string;
  status: ManagedJobStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  progress: ManagedJobProgress;
  caps: ManagedJobCaps;
  resources: ManagedJobResources;
  cleanupPending: boolean;
  errorCode?: JobManagerErrorCode;
};

export type ManagedJobContext = {
  jobId: string;
  signal: AbortSignal;
  consumeIteration(count?: number): void;
  externalCall<T>(operation: (signal: AbortSignal) => Promise<T> | T): Promise<T>;
  reportProgress(progress: ManagedJobProgress): void;
  reportUsage(delta: Partial<Pick<ManagedJobResources, "inputTokens" | "outputTokens" | "units">>): void;
  checkpoint(): void;
};

export type ManagedJobDefinition<TResult> = {
  module: string;
  name: string;
  caps: ManagedJobCaps;
  run(context: ManagedJobContext): Promise<TResult> | TResult;
};

export type ManagedJobHandle<TResult> = {
  id: string;
  result: Promise<TResult>;
  cancel(): boolean;
  snapshot(): ManagedJobSnapshot;
};

export type JobManagerErrorCode =
  | "INVALID_DEFINITION"
  | "QUEUE_FULL"
  | "JOB_NOT_FOUND"
  | "CANCELLED"
  | "TIMED_OUT"
  | "ITERATION_LIMIT"
  | "EXTERNAL_CALL_LIMIT"
  | "HANDLER_FAILED";

export class JobManagerError extends Error {
  readonly code: JobManagerErrorCode;

  constructor(code: JobManagerErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "JobManagerError";
    this.code = code;
  }
}

type InternalJob<TResult = unknown> = {
  definition: ManagedJobDefinition<TResult>;
  snapshot: ManagedJobSnapshot;
  controller: AbortController;
  result: Promise<TResult>;
  resolve: (value: TResult | PromiseLike<TResult>) => void;
  reject: (reason?: unknown) => void;
  settled: boolean;
  executionActive: boolean;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  notificationTimer?: ReturnType<typeof setTimeout>;
  lastNotificationAt: number;
};

type JobManagerOptions = {
  maximumConcurrentJobs?: number;
  maximumQueuedJobs?: number;
  maximumHistory?: number;
  minimumUpdateIntervalMs?: number;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
};

type JobListFilter = {
  module?: string;
  status?: ManagedJobStatus | ManagedJobStatus[];
  limit?: number;
};

type JobListener = (snapshot: ManagedJobSnapshot) => void;

const MODULE_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const JOB_NAME_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const TERMINAL_STATUSES = new Set<ManagedJobStatus>(["completed", "failed", "cancelled", "timed-out", "limit-exceeded"]);

function terminal(status: ManagedJobStatus) {
  return TERMINAL_STATUSES.has(status);
}

function validateDefinition(definition: ManagedJobDefinition<unknown>) {
  const issues: string[] = [];
  if (!MODULE_PATTERN.test(definition.module)) issues.push("module must be a lowercase identifier between 2 and 64 characters");
  if (!JOB_NAME_PATTERN.test(definition.name)) issues.push("name must be a lowercase identifier between 2 and 64 characters");
  if (!Number.isInteger(definition.caps.maxIterations) || definition.caps.maxIterations < 1 || definition.caps.maxIterations > 1_000_000) issues.push("maxIterations must be between 1 and 1,000,000");
  if (!Number.isInteger(definition.caps.timeoutMs) || definition.caps.timeoutMs < 50 || definition.caps.timeoutMs > 24 * 60 * 60_000) issues.push("timeoutMs must be between 50 milliseconds and 24 hours");
  if (!Number.isInteger(definition.caps.maxExternalCalls) || definition.caps.maxExternalCalls < 0 || definition.caps.maxExternalCalls > 10_000) issues.push("maxExternalCalls must be between 0 and 10,000");
  if (typeof definition.run !== "function") issues.push("run must be a function");
  if (issues.length) throw new JobManagerError("INVALID_DEFINITION", `Invalid managed job definition: ${issues.join("; ")}.`);
}

function validateProgress(progress: ManagedJobProgress): ManagedJobProgress {
  if (!Number.isFinite(progress.current) || progress.current < 0) throw new Error("Job progress current must be a non-negative finite number.");
  if (progress.total !== undefined && (!Number.isFinite(progress.total) || progress.total <= 0 || progress.current > progress.total)) throw new Error("Job progress total must be positive and no smaller than current.");
  if (progress.message !== undefined && (typeof progress.message !== "string" || progress.message.length > 500)) throw new Error("Job progress message must contain no more than 500 characters.");
  return { current: progress.current, total: progress.total, message: progress.message?.trim() || undefined };
}

function validateUsage(delta: Partial<Pick<ManagedJobResources, "inputTokens" | "outputTokens" | "units">>) {
  const normalized: Partial<Pick<ManagedJobResources, "inputTokens" | "outputTokens" | "units">> = {};
  for (const key of ["inputTokens", "outputTokens", "units"] as const) {
    const value = delta[key];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) throw new Error(`Job resource ${key} must be a non-negative finite number.`);
    normalized[key] = value;
  }
  return normalized;
}

function cloneSnapshot(snapshot: ManagedJobSnapshot) {
  return structuredClone(snapshot);
}

export class VoidCatJobManager {
  private readonly jobs = new Map<string, InternalJob>();
  private readonly queue: string[] = [];
  private readonly listeners = new Set<JobListener>();
  private readonly maximumConcurrentJobs: number;
  private readonly maximumQueuedJobs: number;
  private readonly maximumHistory: number;
  private readonly minimumUpdateIntervalMs: number;
  private readonly now: () => number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private activeExecutions = 0;
  private pumpQueued = false;

  constructor(options: JobManagerOptions = {}) {
    this.maximumConcurrentJobs = Math.max(1, Math.min(16, Math.round(options.maximumConcurrentJobs ?? 2)));
    this.maximumQueuedJobs = Math.max(0, Math.min(1_000, Math.round(options.maximumQueuedJobs ?? 20)));
    this.maximumHistory = Math.max(1, Math.min(10_000, Math.round(options.maximumHistory ?? 500)));
    this.minimumUpdateIntervalMs = Math.max(0, Math.min(5_000, Math.round(options.minimumUpdateIntervalMs ?? 100)));
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  start<TResult>(definition: ManagedJobDefinition<TResult>): ManagedJobHandle<TResult> {
    validateDefinition(definition as ManagedJobDefinition<unknown>);
    if (this.activeExecutions + this.queue.length >= this.maximumConcurrentJobs + this.maximumQueuedJobs) {
      throw new JobManagerError("QUEUE_FULL", `The managed job queue is full at ${this.maximumQueuedJobs} waiting jobs.`);
    }

    const id = randomUUID();
    const createdMs = this.now();
    let resolve!: (value: TResult | PromiseLike<TResult>) => void;
    let reject!: (reason?: unknown) => void;
    const result = new Promise<TResult>((resolveResult, rejectResult) => { resolve = resolveResult; reject = rejectResult; });
    const job: InternalJob<TResult> = {
      definition,
      snapshot: {
        id,
        module: definition.module,
        name: definition.name,
        status: "queued",
        createdAt: new Date(createdMs).toISOString(),
        progress: { current: 0 },
        caps: { ...definition.caps },
        resources: { iterations: 0, externalCalls: 0, inputTokens: 0, outputTokens: 0, units: 0, wallClockMs: 0 },
        cleanupPending: false,
      },
      controller: new AbortController(),
      result,
      resolve,
      reject,
      settled: false,
      executionActive: false,
      lastNotificationAt: 0,
    };
    this.jobs.set(id, job as InternalJob);
    this.queue.push(id);
    this.notify(job as InternalJob, true);
    this.schedulePump();
    return {
      id,
      result,
      cancel: () => this.cancel(id),
      snapshot: () => this.snapshot(id),
    };
  }

  snapshot(id: string) {
    return cloneSnapshot(this.requireJob(id).snapshot);
  }

  list(filter: JobListFilter = {}) {
    const statuses = filter.status === undefined ? null : new Set(Array.isArray(filter.status) ? filter.status : [filter.status]);
    const limit = Math.max(0, Math.min(this.maximumHistory + this.maximumConcurrentJobs + this.maximumQueuedJobs, Math.round(filter.limit ?? this.jobs.size)));
    if (limit === 0) return [];
    return [...this.jobs.values()]
      .filter((job) => (!filter.module || job.snapshot.module === filter.module) && (!statuses || statuses.has(job.snapshot.status)))
      .sort((left, right) => Date.parse(right.snapshot.createdAt) - Date.parse(left.snapshot.createdAt))
      .slice(0, limit)
      .map((job) => cloneSnapshot(job.snapshot));
  }

  subscribe(listener: JobListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  cancel(id: string) {
    const job = this.requireJob(id);
    if (terminal(job.snapshot.status)) return false;
    if (job.snapshot.status === "queued") {
      const queueIndex = this.queue.indexOf(id);
      if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
    }
    job.controller.abort(new JobManagerError("CANCELLED", `Managed job ${id} was cancelled.`));
    this.finish(job, "cancelled", new JobManagerError("CANCELLED", `Managed job ${id} was cancelled.`));
    return true;
  }

  cancelModule(module: string) {
    let cancelled = 0;
    for (const job of this.jobs.values()) {
      if (job.snapshot.module === module && this.cancel(job.snapshot.id)) cancelled += 1;
    }
    return cancelled;
  }

  clearFinished() {
    let removed = 0;
    for (const [id, job] of this.jobs) {
      if (terminal(job.snapshot.status) && !job.executionActive) {
        if (job.notificationTimer) this.clearTimer(job.notificationTimer);
        this.jobs.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  private schedulePump() {
    if (this.pumpQueued) return;
    this.pumpQueued = true;
    queueMicrotask(() => {
      this.pumpQueued = false;
      while (this.activeExecutions < this.maximumConcurrentJobs && this.queue.length) {
        const id = this.queue.shift()!;
        const job = this.jobs.get(id);
        if (job && job.snapshot.status === "queued") void this.execute(job);
      }
    });
  }

  private async execute(job: InternalJob) {
    const startedMs = this.now();
    this.activeExecutions += 1;
    job.executionActive = true;
    job.snapshot.status = "running";
    job.snapshot.startedAt = new Date(startedMs).toISOString();
    job.snapshot.cleanupPending = false;
    this.notify(job, true);
    job.timeoutTimer = this.setTimer(() => {
      if (job.settled) return;
      job.controller.abort(new JobManagerError("TIMED_OUT", `Managed job ${job.snapshot.id} exceeded its wall-clock limit.`));
      this.finish(job, "timed-out", new JobManagerError("TIMED_OUT", `Managed job ${job.snapshot.id} exceeded its wall-clock limit.`));
    }, job.definition.caps.timeoutMs);

    const assertActive = () => {
      if (job.controller.signal.aborted || terminal(job.snapshot.status)) {
        const reason = job.controller.signal.reason;
        if (reason instanceof JobManagerError) throw reason;
        throw new JobManagerError("CANCELLED", `Managed job ${job.snapshot.id} is no longer active.`);
      }
    };

    const context: ManagedJobContext = {
      jobId: job.snapshot.id,
      signal: job.controller.signal,
      checkpoint: assertActive,
      consumeIteration: (count = 1) => {
        assertActive();
        if (!Number.isInteger(count) || count < 1) throw new Error("Iteration consumption must be a positive integer.");
        if (job.snapshot.resources.iterations + count > job.snapshot.caps.maxIterations) {
          const error = new JobManagerError("ITERATION_LIMIT", `Managed job ${job.snapshot.id} exceeded its iteration limit.`);
          job.controller.abort(error);
          this.finish(job, "limit-exceeded", error);
          throw error;
        }
        job.snapshot.resources.iterations += count;
        this.updateWallClock(job);
        this.notify(job);
      },
      externalCall: async <T>(operation: (signal: AbortSignal) => Promise<T> | T) => {
        assertActive();
        if (typeof operation !== "function") throw new Error("External call operation must be a function.");
        if (job.snapshot.resources.externalCalls >= job.snapshot.caps.maxExternalCalls) {
          const error = new JobManagerError("EXTERNAL_CALL_LIMIT", `Managed job ${job.snapshot.id} exceeded its external-call limit.`);
          job.controller.abort(error);
          this.finish(job, "limit-exceeded", error);
          throw error;
        }
        job.snapshot.resources.externalCalls += 1;
        this.updateWallClock(job);
        this.notify(job);
        const value = await operation(job.controller.signal);
        assertActive();
        return value;
      },
      reportProgress: (progress) => {
        assertActive();
        job.snapshot.progress = validateProgress(progress);
        this.updateWallClock(job);
        this.notify(job);
      },
      reportUsage: (delta) => {
        assertActive();
        const normalized = validateUsage(delta);
        for (const key of Object.keys(normalized) as Array<"inputTokens" | "outputTokens" | "units">) job.snapshot.resources[key] += normalized[key] ?? 0;
        this.updateWallClock(job);
        this.notify(job);
      },
    };

    try {
      const value = await job.definition.run(context);
      assertActive();
      this.finish(job, "completed", undefined, value);
    } catch (error) {
      if (job.settled) return;
      if (error instanceof JobManagerError && error.code === "ITERATION_LIMIT") this.finish(job, "limit-exceeded", error);
      else if (error instanceof JobManagerError && error.code === "EXTERNAL_CALL_LIMIT") this.finish(job, "limit-exceeded", error);
      else if (error instanceof JobManagerError && error.code === "TIMED_OUT") this.finish(job, "timed-out", error);
      else if (error instanceof JobManagerError && error.code === "CANCELLED") this.finish(job, "cancelled", error);
      else this.finish(job, "failed", new JobManagerError("HANDLER_FAILED", `Managed job ${job.snapshot.id} failed inside its handler.`, { cause: error }));
    } finally {
      if (job.timeoutTimer) this.clearTimer(job.timeoutTimer);
      job.timeoutTimer = undefined;
      job.executionActive = false;
      job.snapshot.cleanupPending = false;
      this.updateWallClock(job);
      this.notify(job, true);
      this.activeExecutions -= 1;
      this.trimHistory();
      this.schedulePump();
    }
  }

  private finish<TResult>(job: InternalJob<TResult>, status: Exclude<ManagedJobStatus, "queued" | "running">, error?: JobManagerError, value?: TResult) {
    if (job.settled) return;
    job.settled = true;
    job.snapshot.status = status;
    job.snapshot.completedAt = new Date(this.now()).toISOString();
    job.snapshot.cleanupPending = job.executionActive;
    job.snapshot.errorCode = error?.code;
    this.updateWallClock(job);
    this.notify(job, true);
    if (status === "completed") job.resolve(value as TResult);
    else job.reject(error ?? new JobManagerError("HANDLER_FAILED", `Managed job ${job.snapshot.id} did not complete.`));
    if (!job.executionActive) {
      this.trimHistory();
      this.schedulePump();
    }
  }

  private updateWallClock<TResult>(job: InternalJob<TResult>) {
    const start = job.snapshot.startedAt ? Date.parse(job.snapshot.startedAt) : this.now();
    const end = job.snapshot.completedAt ? Date.parse(job.snapshot.completedAt) : this.now();
    job.snapshot.resources.wallClockMs = Math.max(0, end - start);
  }

  private notify<TResult>(job: InternalJob<TResult>, force = false) {
    const currentTime = this.now();
    const elapsed = currentTime - job.lastNotificationAt;
    if (!force && this.minimumUpdateIntervalMs > 0 && elapsed < this.minimumUpdateIntervalMs) {
      if (!job.notificationTimer) {
        job.notificationTimer = this.setTimer(() => {
          job.notificationTimer = undefined;
          job.lastNotificationAt = this.now();
          this.emit(job.snapshot);
        }, this.minimumUpdateIntervalMs - Math.max(0, elapsed));
      }
      return;
    }
    if (job.notificationTimer) this.clearTimer(job.notificationTimer);
    job.notificationTimer = undefined;
    job.lastNotificationAt = currentTime;
    this.emit(job.snapshot);
  }

  private emit(snapshot: ManagedJobSnapshot) {
    this.listeners.forEach((listener) => {
      try { listener(cloneSnapshot(snapshot)); } catch { /* A faulty UI subscriber cannot interrupt a job. */ }
    });
  }

  private trimHistory() {
    const finished = [...this.jobs.values()]
      .filter((job) => terminal(job.snapshot.status) && !job.executionActive)
      .sort((left, right) => Date.parse(left.snapshot.completedAt ?? left.snapshot.createdAt) - Date.parse(right.snapshot.completedAt ?? right.snapshot.createdAt));
    finished.slice(0, Math.max(0, finished.length - this.maximumHistory)).forEach((job) => {
      if (job.notificationTimer) this.clearTimer(job.notificationTimer);
      this.jobs.delete(job.snapshot.id);
    });
  }

  private requireJob(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new JobManagerError("JOB_NOT_FOUND", `Managed job ${id} was not found.`);
    return job;
  }
}

/** Shared process-local manager used by VoidCat modules and model-lane adapters. */
export const voidcatJobManager = new VoidCatJobManager();
