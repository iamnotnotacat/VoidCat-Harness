/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { type ManagedJobSnapshot, type VoidCatJobManager } from "./voidcat-job-manager.ts";

const execFileAsync = promisify(execFile);
export type ResourceProfileId = "quiet" | "normal" | "maximum";

export type ResourceProfile = {
  id: ResourceProfileId;
  label: string;
  concurrency: number;
  sampleIntervalMs: number;
  cpuThrottlePercent: number;
  minimumFreeMemoryPercent: number;
  description: string;
};

export const RESOURCE_PROFILES: Record<ResourceProfileId, ResourceProfile> = {
  quiet: { id: "quiet", label: "QUIET", concurrency: 1, sampleIntervalMs: 5_000, cpuThrottlePercent: 78, minimumFreeMemoryPercent: 18, description: "One background job at a time with early memory and CPU throttling." },
  normal: { id: "normal", label: "NORMAL", concurrency: 2, sampleIntervalMs: 2_500, cpuThrottlePercent: 90, minimumFreeMemoryPercent: 10, description: "Balanced local analysis and live-source responsiveness." },
  maximum: { id: "maximum", label: "MAXIMUM", concurrency: 4, sampleIntervalMs: 1_500, cpuThrottlePercent: 97, minimumFreeMemoryPercent: 6, description: "Up to four jobs while retaining hard safety ceilings." },
};

type CpuTick = { idle: number; total: number };
type ProcessTick = { usage: NodeJS.CpuUsage; time: bigint };
type GpuSnapshot = { available: boolean; name: string | null; utilizationPercent: number | null; memoryUsedBytes: number | null; memoryTotalBytes: number | null; sampledAt: string; limitation?: string };
type ResourceInputs = {
  jobs: VoidCatJobManager;
  dataRoot?: string;
  profile?: ResourceProfileId;
  unitSnapshot?: () => Promise<{ online: boolean; loaded: Array<Record<string, unknown>>; contextLength?: number | null }>;
  ragSnapshot?: () => { documents: number; folders: number; chunks: number; vectors: number; pending: number; activeScans: number };
  storageSnapshot?: () => Promise<{ budgets: Record<string, { usedBytes: number; limitBytes: number; utilization: number; state: string }>; components: Record<string, { bytes: number }> }>;
  sourceSnapshot?: () => Promise<Array<{ id: string; name: string; enabled: boolean; status: string; pollCadenceMs: number; requestBudgetPercent: number; hourlyRequests: number; hardHourlyBudget: number; recordsPerHour: number; nextScheduledAt?: string }>>;
};

function cpuTick(): CpuTick {
  return os.cpus().reduce((result, cpu) => {
    const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    return { idle: result.idle + cpu.times.idle, total: result.total + total };
  }, { idle: 0, total: 0 });
}

function percent(value: number) { return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0)); }
function active(status: string) { return status === "queued" || status === "running"; }

export class VoidCatResourceCommandCenter {
  private readonly inputs: ResourceInputs;
  private profileId: ResourceProfileId;
  private previousCpu = cpuTick();
  private previousProcess: ProcessTick = { usage: process.cpuUsage(), time: process.hrtime.bigint() };
  private listeners = new Set<(snapshot: unknown) => void>();
  private gpuCache: { expiresAt: number; value: GpuSnapshot } | null = null;

  constructor(inputs: ResourceInputs) {
    this.inputs = inputs;
    this.profileId = inputs.profile && RESOURCE_PROFILES[inputs.profile] ? inputs.profile : "normal";
    this.inputs.jobs.setConcurrencyLimit(Math.min(RESOURCE_PROFILES[this.profileId].concurrency, this.inputs.jobs.controlSnapshot().concurrencyCeiling));
  }

  profile() { return RESOURCE_PROFILES[this.profileId]; }

  setProfile(profileId: ResourceProfileId) {
    if (!RESOURCE_PROFILES[profileId]) throw new Error("Choose quiet, normal, or maximum performance.");
    this.profileId = profileId;
    const control = this.inputs.jobs.controlSnapshot();
    if (!control.globallyPaused) this.inputs.jobs.setConcurrencyLimit(Math.min(RESOURCE_PROFILES[profileId].concurrency, control.concurrencyCeiling));
    return this.profile();
  }

  subscribe(listener: (snapshot: unknown) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  publish(snapshot: unknown) { for (const listener of this.listeners) { try { listener(structuredClone(snapshot)); } catch { /* observers cannot interrupt resource controls */ } } }

  private cpuSnapshot() {
    const current = cpuTick(); const idleDelta = current.idle - this.previousCpu.idle; const totalDelta = current.total - this.previousCpu.total;
    this.previousCpu = current;
    const overallPercent = percent(totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 0);
    const nextProcess = { usage: process.cpuUsage(), time: process.hrtime.bigint() };
    const elapsedMicros = Number(nextProcess.time - this.previousProcess.time) / 1_000;
    const processMicros = (nextProcess.usage.user - this.previousProcess.usage.user) + (nextProcess.usage.system - this.previousProcess.usage.system);
    this.previousProcess = nextProcess;
    return { overallPercent, processPercent: percent(elapsedMicros > 0 ? processMicros / elapsedMicros * 100 : 0), cores: os.cpus().length, loadAverage1m: os.loadavg()[0] ?? 0 };
  }

  private async gpuSnapshot(): Promise<GpuSnapshot> {
    if (this.gpuCache && this.gpuCache.expiresAt > Date.now()) return this.gpuCache.value;
    const sampledAt = new Date().toISOString();
    let value: GpuSnapshot;
    try {
      const result = await execFileAsync("nvidia-smi", ["--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"], { timeout: 2_500, windowsHide: true, maxBuffer: 64 * 1024 });
      const [name = "NVIDIA GPU", utilization = "0", used = "0", total = "0"] = result.stdout.trim().split(/\s*,\s*/);
      value = { available: true, name, utilizationPercent: percent(Number(utilization)), memoryUsedBytes: Math.max(0, Number(used)) * 1024 ** 2, memoryTotalBytes: Math.max(0, Number(total)) * 1024 ** 2, sampledAt };
    } catch {
      value = { available: false, name: null, utilizationPercent: null, memoryUsedBytes: null, memoryTotalBytes: null, sampledAt, limitation: "Dedicated GPU telemetry is available when nvidia-smi is installed; UNIT runtime status remains authoritative." };
    }
    this.gpuCache = { expiresAt: Date.now() + 30_000, value };
    return value;
  }

  private async diskSnapshot() {
    const root = path.resolve(this.inputs.dataRoot ?? path.join(process.cwd(), ".voidcat"));
    await fs.mkdir(root, { recursive: true });
    const stats = await fs.statfs(root); const totalBytes = Number(stats.blocks) * Number(stats.bsize); const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    return { path: root, totalBytes, freeBytes, usedBytes: Math.max(0, totalBytes - freeBytes), freePercent: totalBytes > 0 ? freeBytes / totalBytes * 100 : 0 };
  }

  async collect() {
    const sampledAt = new Date().toISOString(); const cpu = this.cpuSnapshot();
    const totalMemoryBytes = os.totalmem(); const freeMemoryBytes = os.freemem(); const processMemory = process.memoryUsage();
    const freeMemoryPercent = totalMemoryBytes > 0 ? freeMemoryBytes / totalMemoryBytes * 100 : 0;
    const [disk, gpu, unit, storage, sources] = await Promise.all([
      this.diskSnapshot(), this.gpuSnapshot(), this.inputs.unitSnapshot?.() ?? Promise.resolve({ online: false, loaded: [], contextLength: null }), this.inputs.storageSnapshot?.() ?? Promise.resolve(null), this.inputs.sourceSnapshot?.() ?? Promise.resolve([]),
    ]);
    const jobs = this.inputs.jobs.list({ limit: 500 }); const byModule = new Map<string, { jobs: number; active: number; externalCalls: number; units: number; wallClockMs: number }>();
    for (const job of jobs) { const current = byModule.get(job.module) ?? { jobs: 0, active: 0, externalCalls: 0, units: 0, wallClockMs: 0 }; current.jobs += 1; if (active(job.status)) current.active += 1; current.externalCalls += job.resources.externalCalls; current.units += job.resources.units; current.wallClockMs += job.resources.wallClockMs; byModule.set(job.module, current); }
    const profile = this.profile(); const reasons: string[] = [];
    if (cpu.overallPercent >= profile.cpuThrottlePercent) reasons.push(`CPU ${Math.round(cpu.overallPercent)}% exceeds ${profile.cpuThrottlePercent}% profile threshold`);
    if (freeMemoryPercent <= profile.minimumFreeMemoryPercent) reasons.push(`free memory ${freeMemoryPercent.toFixed(1)}% is below ${profile.minimumFreeMemoryPercent}% profile threshold`);
    if (disk.freePercent <= 5) reasons.push(`free disk ${disk.freePercent.toFixed(1)}% is below the 5% hard floor`);
    const controlBefore = this.inputs.jobs.controlSnapshot(); const desiredConcurrency = reasons.length ? 1 : Math.min(profile.concurrency, controlBefore.concurrencyCeiling);
    if (!controlBefore.globallyPaused && controlBefore.concurrencyLimit !== desiredConcurrency) this.inputs.jobs.setConcurrencyLimit(desiredConcurrency);
    const control = this.inputs.jobs.controlSnapshot();
    const result = {
      sampledAt, profile, autoThrottle: { active: reasons.length > 0, reasons, effectiveConcurrency: control.concurrencyLimit }, control,
      cpu, gpu,
      memory: { totalBytes: totalMemoryBytes, freeBytes: freeMemoryBytes, freePercent: freeMemoryPercent, processRssBytes: processMemory.rss, processHeapBytes: processMemory.heapUsed, processExternalBytes: processMemory.external },
      disk, storage,
      network: { activeInterfaces: Object.values(os.networkInterfaces()).flat().filter((entry) => entry && !entry.internal).length, accounting: "managed-request-accounting", externalCalls: jobs.reduce((sum, job) => sum + job.resources.externalCalls, 0), requestUnits: jobs.reduce((sum, job) => sum + job.resources.units, 0), byModule: Object.fromEntries([...byModule.entries()].sort(([left], [right]) => left.localeCompare(right))) },
      unit: { online: unit.online, loaded: unit.loaded, contextLength: unit.contextLength ?? null }, rag: this.inputs.ragSnapshot?.() ?? { documents: 0, folders: 0, chunks: 0, vectors: 0, pending: 0, activeScans: 0 },
      sources,
      jobs: jobs.filter((job) => active(job.status)).concat(jobs.filter((job) => !active(job.status)).slice(0, 20)) as ManagedJobSnapshot[],
    };
    this.publish(result); return result;
  }
}
