/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { DatabaseSync } from "node:sqlite";
import type { HunterSeekerPublicObservation } from "./hunter-seeker-service.ts";

export type WatchlistKind = "aircraft-icao" | "aircraft-callsign" | "aircraft-tail" | "vessel-mmsi" | "satellite-norad" | "geofence";
export type GeofenceGeometry =
  | { type: "circle"; latitude: number; longitude: number; radiusKm: number }
  | { type: "bbox"; south: number; west: number; north: number; east: number };
export type WatchlistRule = {
  id: string;
  kind: WatchlistKind;
  label: string;
  value: string | null;
  geometry: GeofenceGeometry | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};
export type TriggerType = "geofence-entry" | "geofence-exit" | "watchlist-match" | "emergency-squawk" | "loiter" | "reappearance";
export type TriggerEvent = {
  id: string;
  triggerType: TriggerType;
  ruleId: string | null;
  observationId: string;
  entityId: string;
  title: string;
  message: string;
  occurredAt: string;
  metadata: Record<string, unknown>;
  acknowledged: boolean;
};
export type FeedHealthSample = {
  sourceId: string;
  at: string;
  status: string;
  errorRate: number;
  recordsPerHour: number;
  expectedBaseline: number;
  silentZero: boolean;
  aiContextEligible: boolean;
  message: string;
};

const WATCHLIST_KINDS = new Set<WatchlistKind>(["aircraft-icao", "aircraft-callsign", "aircraft-tail", "vessel-mmsi", "satellite-norad", "geofence"]);
const MAX_WATCHLISTS = 500;
const MAX_GEOFENCES = 20;
const MAX_EVALUATION_OBSERVATIONS = 1_000;
const DEDUPE_MS = 10 * 60_000;
const REAPPEARANCE_MS = 30 * 60_000;
const LOITER_MS = 10 * 60_000;
const LOITER_RADIUS_KM = 5;
const MAX_TRIGGERS_PER_HOUR = 30;
const MAX_TRIGGER_EVENTS = 5_000;
const MAX_TRIGGER_STATES = 100_000;
const TRIGGER_STATE_RETENTION_MS = 48 * 60 * 60_000;
const MAX_REPLAY_BYTES = 64 * 1024 * 1024;
const MAX_REPLAY_RECORDS = 50_000;

function iso(ms: number) { return new Date(ms).toISOString(); }
function safeJson(value: unknown) { return JSON.stringify(value ?? {}); }
function parseJson<T>(value: string, fallback: T): T { try { return JSON.parse(value) as T; } catch { return fallback; } }
function textAttribute(observation: HunterSeekerPublicObservation, ...keys: string[]) {
  for (const key of keys) { const value = observation.attributes[key]; if (typeof value === "string" && value.trim()) return value.trim(); }
  return null;
}
function normalizeIdentifier(value: string) { return value.trim().toUpperCase().replace(/\s+/g, ""); }
function haversineKm(left: { latitude: number; longitude: number }, right: { latitude: number; longitude: number }) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(right.latitude - left.latitude); const dLon = radians(right.longitude - left.longitude);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(left.latitude)) * Math.cos(radians(right.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6_371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function inGeofence(position: HunterSeekerPublicObservation["position"], geometry: GeofenceGeometry) {
  if (geometry.type === "circle") return haversineKm(position, geometry) <= geometry.radiusKm;
  const latitude = position.latitude; const longitude = position.longitude;
  const withinLongitude = geometry.west <= geometry.east ? longitude >= geometry.west && longitude <= geometry.east : longitude >= geometry.west || longitude <= geometry.east;
  return latitude >= geometry.south && latitude <= geometry.north && withinLongitude;
}
function validateGeometry(value: unknown): GeofenceGeometry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A geofence geometry is required.");
  const geometry = value as Record<string, unknown>;
  if (geometry.type === "circle") {
    const latitude = Number(geometry.latitude); const longitude = Number(geometry.longitude); const radiusKm = Number(geometry.radiusKm);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 2_000) throw new Error("Circle geofence values are invalid.");
    return { type: "circle", latitude, longitude, radiusKm };
  }
  if (geometry.type === "bbox") {
    const south = Number(geometry.south); const west = Number(geometry.west); const north = Number(geometry.north); const east = Number(geometry.east);
    if (![south, west, north, east].every(Number.isFinite) || south < -90 || north > 90 || south > north || west < -180 || west > 180 || east < -180 || east > 180) throw new Error("Bounding-box geofence values are invalid.");
    return { type: "bbox", south, west, north, east };
  }
  throw new Error("Geofences support circle or bounding-box geometry.");
}

export class HunterStageFiveStore {
  private readonly databasePath: string;
  private readonly now: () => number;
  private readonly ensureWriteAllowed: (estimatedBytes: number) => Promise<void>;
  private database: DatabaseSync | null = null;

  constructor(options: { databasePath: string; now?: () => number; ensureWriteAllowed?: (estimatedBytes: number) => Promise<void> }) {
    this.databasePath = path.resolve(options.databasePath); this.now = options.now ?? Date.now; this.ensureWriteAllowed = options.ensureWriteAllowed ?? (async () => undefined);
  }

  async initialize() {
    if (this.database) return;
    await this.ensureWriteAllowed(2 * 1024 * 1024);
    const database = new DatabaseSync(this.databasePath); database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL");
    database.exec(`CREATE TABLE IF NOT EXISTS hunter_watchlists_v1 (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, value TEXT, geometry_json TEXT,
      enabled INTEGER NOT NULL DEFAULT 1, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hunter_trigger_events_v1 (
      id TEXT PRIMARY KEY, trigger_type TEXT NOT NULL, rule_id TEXT, observation_id TEXT NOT NULL,
      entity_id TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, occurred_at_ms INTEGER NOT NULL,
      dedupe_key TEXT NOT NULL, metadata_json TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS hunter_trigger_time_v1 ON hunter_trigger_events_v1(occurred_at_ms DESC);
    CREATE TABLE IF NOT EXISTS hunter_trigger_state_v1 (
      state_key TEXT PRIMARY KEY, rule_id TEXT, entity_id TEXT NOT NULL, inside INTEGER,
      last_seen_ms INTEGER NOT NULL, stationary_since_ms INTEGER, latitude REAL NOT NULL, longitude REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hunter_trigger_dedupe_v1 (dedupe_key TEXT PRIMARY KEY, last_fired_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS hunter_feed_health_v1 (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL, at_ms INTEGER NOT NULL, status TEXT NOT NULL,
      error_rate REAL NOT NULL, records_per_hour REAL NOT NULL, expected_baseline REAL NOT NULL,
      silent_zero INTEGER NOT NULL, ai_context_eligible INTEGER NOT NULL, message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS hunter_feed_health_source_time_v1 ON hunter_feed_health_v1(source_id, at_ms DESC);`);
    this.database = database;
  }

  close() { this.database?.close(); this.database = null; }
  private db() { if (!this.database) throw new Error("Hunter Stage 5 storage is not initialized."); return this.database; }

  listWatchlists(): WatchlistRule[] {
    return (this.db().prepare("SELECT * FROM hunter_watchlists_v1 ORDER BY updated_at_ms DESC").all() as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id), kind: String(row.kind) as WatchlistKind, label: String(row.label), value: row.value === null ? null : String(row.value), geometry: row.geometry_json === null ? null : parseJson(String(row.geometry_json), null), enabled: Boolean(row.enabled), createdAt: iso(Number(row.created_at_ms)), updatedAt: iso(Number(row.updated_at_ms)),
    }));
  }

  async saveWatchlist(input: { id?: string; kind: WatchlistKind; label: string; value?: string; geometry?: GeofenceGeometry; enabled?: boolean }) {
    if (!WATCHLIST_KINDS.has(input.kind)) throw new Error("Unsupported watchlist type.");
    const label = input.label.trim().slice(0, 120); if (!label) throw new Error("A watchlist label is required.");
    const geometry = input.kind === "geofence" ? validateGeometry(input.geometry) : null;
    const value = input.kind === "geofence" ? null : normalizeIdentifier(input.value ?? "");
    if (input.kind !== "geofence" && (!value || value.length > 50 || !/^[A-Z0-9._-]+$/.test(value))) throw new Error("The watchlist identifier is invalid.");
    const database = this.db(); const existingCount = Number((database.prepare("SELECT COUNT(*) count FROM hunter_watchlists_v1").get() as { count: number }).count);
    if (!input.id && existingCount >= MAX_WATCHLISTS) throw new Error(`Watchlists are limited to ${MAX_WATCHLISTS} rules.`);
    if (input.kind === "geofence") {
      const geofenceRow = (input.id
        ? database.prepare("SELECT COUNT(*) count FROM hunter_watchlists_v1 WHERE kind='geofence' AND id<>?").get(input.id)
        : database.prepare("SELECT COUNT(*) count FROM hunter_watchlists_v1 WHERE kind='geofence'").get()) as { count: number } | undefined;
      const geofenceCount = Number(geofenceRow?.count ?? 0);
      if (geofenceCount >= MAX_GEOFENCES) throw new Error(`Geofences are limited to ${MAX_GEOFENCES} active management rules for bounded evaluation.`);
    }
    await this.ensureWriteAllowed(Buffer.byteLength(label + (value ?? "") + safeJson(geometry)) + 2_048);
    const id = input.id && /^[0-9a-f-]{36}$/i.test(input.id) ? input.id : randomUUID(); const now = this.now();
    database.prepare(`INSERT INTO hunter_watchlists_v1(id,kind,label,value,geometry_json,enabled,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,label=excluded.label,value=excluded.value,geometry_json=excluded.geometry_json,enabled=excluded.enabled,updated_at_ms=excluded.updated_at_ms`)
      .run(id, input.kind, label, value, geometry ? safeJson(geometry) : null, Number(input.enabled !== false), now, now);
    return this.listWatchlists().find((rule) => rule.id === id)!;
  }

  deleteWatchlist(id: string) { const result = this.db().prepare("DELETE FROM hunter_watchlists_v1 WHERE id=?").run(id); return { deleted: Number(result.changes) }; }
  exportWatchlists() {
    const rules = this.listWatchlists(); const body = { format: "voidcat-hunter-watchlists", version: 1, exportedAt: iso(this.now()), rules };
    return { ...body, checksum: createHash("sha256").update(safeJson(body)).digest("hex") };
  }
  async importWatchlists(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Watchlist import must be an object.");
    const record = value as Record<string, unknown>; if (record.format !== "voidcat-hunter-watchlists" || record.version !== 1 || !Array.isArray(record.rules) || record.rules.length > MAX_WATCHLISTS) throw new Error("Unsupported or oversized watchlist import.");
    if (typeof record.checksum === "string") {
      const body = { format: record.format, version: record.version, exportedAt: record.exportedAt, rules: record.rules };
      const expected = createHash("sha256").update(safeJson(body)).digest("hex");
      if (record.checksum !== expected) throw new Error("Watchlist import checksum validation failed.");
    }
    let imported = 0;
    for (const candidate of record.rules) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const rule = candidate as Record<string, unknown>;
      await this.saveWatchlist({ id: typeof rule.id === "string" ? rule.id : undefined, kind: String(rule.kind) as WatchlistKind, label: String(rule.label ?? ""), value: typeof rule.value === "string" ? rule.value : undefined, geometry: rule.geometry as GeofenceGeometry | undefined, enabled: rule.enabled !== false }); imported += 1;
    }
    return { imported, total: this.listWatchlists().length };
  }

  private identifiers(observation: HunterSeekerPublicObservation) {
    return {
      "aircraft-icao": normalizeIdentifier(textAttribute(observation, "transponderHex", "icao24") ?? observation.entityId.replace(/^aircraft:/i, "")),
      "aircraft-callsign": normalizeIdentifier(textAttribute(observation, "callsign") ?? ""),
      "aircraft-tail": normalizeIdentifier(textAttribute(observation, "registration", "tailNumber") ?? ""),
      "vessel-mmsi": normalizeIdentifier(textAttribute(observation, "mmsi") ?? observation.entityId.replace(/^vessel:/i, "")),
      "satellite-norad": normalizeIdentifier(textAttribute(observation, "noradCatalogId") ?? observation.entityId.replace(/^(?:satellite|station):/i, "")),
    } as Record<Exclude<WatchlistKind, "geofence">, string>;
  }

  private state(key: string) { return this.db().prepare("SELECT * FROM hunter_trigger_state_v1 WHERE state_key=?").get(key) as Record<string, unknown> | undefined; }
  private writeState(key: string, ruleId: string | null, observation: HunterSeekerPublicObservation, inside: boolean | null, stationarySince: number | null) {
    this.db().prepare(`INSERT INTO hunter_trigger_state_v1(state_key,rule_id,entity_id,inside,last_seen_ms,stationary_since_ms,latitude,longitude) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(state_key) DO UPDATE SET inside=excluded.inside,last_seen_ms=excluded.last_seen_ms,stationary_since_ms=excluded.stationary_since_ms,latitude=excluded.latitude,longitude=excluded.longitude`)
      .run(key, ruleId, observation.entityId, inside === null ? null : Number(inside), this.now(), stationarySince, observation.position.latitude, observation.position.longitude);
  }

  private canFire(dedupeKey: string, current: number) {
    const database = this.db();
    const hourly = Number((database.prepare("SELECT COUNT(*) count FROM hunter_trigger_events_v1 WHERE occurred_at_ms>?").get(current - 60 * 60_000) as { count: number }).count);
    if (hourly >= MAX_TRIGGERS_PER_HOUR) return false;
    const row = database.prepare("SELECT last_fired_ms FROM hunter_trigger_dedupe_v1 WHERE dedupe_key=?").get(dedupeKey) as { last_fired_ms?: number } | undefined;
    return !row || current - Number(row.last_fired_ms) >= DEDUPE_MS;
  }

  private recordTrigger(input: Omit<TriggerEvent, "id" | "occurredAt" | "acknowledged"> & { dedupeKey: string }, output: TriggerEvent[]) {
    const current = this.now(); if (!this.canFire(input.dedupeKey, current)) return;
    const database = this.db(); const id = randomUUID();
    database.prepare("INSERT INTO hunter_trigger_events_v1(id,trigger_type,rule_id,observation_id,entity_id,title,message,occurred_at_ms,dedupe_key,metadata_json,acknowledged) VALUES(?,?,?,?,?,?,?,?,?,?,0)")
      .run(id, input.triggerType, input.ruleId, input.observationId, input.entityId, input.title.slice(0, 160), input.message.slice(0, 500), current, input.dedupeKey, safeJson(input.metadata));
    database.prepare("INSERT INTO hunter_trigger_dedupe_v1(dedupe_key,last_fired_ms) VALUES(?,?) ON CONFLICT(dedupe_key) DO UPDATE SET last_fired_ms=excluded.last_fired_ms").run(input.dedupeKey, current);
    database.prepare("DELETE FROM hunter_trigger_events_v1 WHERE id IN (SELECT id FROM hunter_trigger_events_v1 ORDER BY occurred_at_ms DESC LIMIT -1 OFFSET ?)").run(MAX_TRIGGER_EVENTS);
    output.push({ id, triggerType: input.triggerType, ruleId: input.ruleId, observationId: input.observationId, entityId: input.entityId, title: input.title, message: input.message, occurredAt: iso(current), metadata: input.metadata, acknowledged: false });
  }

  async evaluate(observations: readonly HunterSeekerPublicObservation[]) {
    if (!observations.length) return { events: [] as TriggerEvent[], protectedObservationIds: [] as string[] };
    const batch = observations.slice(0, MAX_EVALUATION_OBSERVATIONS); const rules = this.listWatchlists().filter((rule) => rule.enabled);
    const geofenceCount = rules.filter((rule) => rule.kind === "geofence").length;
    await this.ensureWriteAllowed(batch.length * (geofenceCount + 1) * 512);
    const events: TriggerEvent[] = []; const protectedIds = new Set<string>(); const current = this.now(); const database = this.db();
    database.exec("BEGIN IMMEDIATE");
    try {
    for (const observation of batch) {
      const identifiers = this.identifiers(observation);
      for (const rule of rules) {
        if (rule.kind === "geofence" && rule.geometry) {
          const inside = inGeofence(observation.position, rule.geometry); const key = `geofence:${rule.id}:${observation.entityId}`; const previous = this.state(key);
          if (inside) protectedIds.add(observation.observationId);
          if ((!previous && inside) || (previous && Boolean(previous.inside) !== inside)) {
            const triggerType: TriggerType = inside ? "geofence-entry" : "geofence-exit";
            this.recordTrigger({ triggerType, ruleId: rule.id, observationId: observation.observationId, entityId: observation.entityId, title: `${inside ? "ENTRY" : "EXIT"}: ${rule.label}`, message: `${observation.entityId} ${inside ? "entered" : "exited"} ${rule.label}.`, metadata: { ruleLabel: rule.label, position: observation.position }, dedupeKey: `${triggerType}:${rule.id}:${observation.entityId}` }, events); protectedIds.add(observation.observationId);
          }
          this.writeState(key, rule.id, observation, inside, null);
        } else if (rule.kind !== "geofence" && identifiers[rule.kind] && identifiers[rule.kind] === rule.value) {
          this.recordTrigger({ triggerType: "watchlist-match", ruleId: rule.id, observationId: observation.observationId, entityId: observation.entityId, title: `WATCHLIST: ${rule.label}`, message: `${observation.entityId} matched ${rule.kind} ${rule.value}.`, metadata: { ruleLabel: rule.label, identifier: rule.value }, dedupeKey: `watchlist:${rule.id}:${observation.entityId}` }, events); protectedIds.add(observation.observationId);
        }
      }
      const squawk = normalizeIdentifier(textAttribute(observation, "squawk") ?? ""); const emergency = normalizeIdentifier(textAttribute(observation, "emergency") ?? "");
      if (["7500", "7600", "7700"].includes(squawk) || (emergency && emergency !== "NONE" && emergency !== "NOEMERGENCY")) {
        this.recordTrigger({ triggerType: "emergency-squawk", ruleId: null, observationId: observation.observationId, entityId: observation.entityId, title: `EMERGENCY ${squawk || emergency}`, message: `${observation.entityId} reported emergency state ${squawk || emergency}.`, metadata: { squawk, emergency }, dedupeKey: `emergency:${observation.entityId}:${squawk || emergency}` }, events); protectedIds.add(observation.observationId);
      }
      const motionKey = `motion:${observation.entityId}`; const previousMotion = this.state(motionKey);
      if (previousMotion && current - Number(previousMotion.last_seen_ms) >= REAPPEARANCE_MS) {
        this.recordTrigger({ triggerType: "reappearance", ruleId: null, observationId: observation.observationId, entityId: observation.entityId, title: "CONTACT REAPPEARED", message: `${observation.entityId} reappeared after ${Math.round((current - Number(previousMotion.last_seen_ms)) / 60_000)} minutes.`, metadata: { absentMs: current - Number(previousMotion.last_seen_ms) }, dedupeKey: `reappearance:${observation.entityId}` }, events); protectedIds.add(observation.observationId);
      }
      let stationarySince = current;
      if (previousMotion) {
        const distance = haversineKm({ latitude: Number(previousMotion.latitude), longitude: Number(previousMotion.longitude) }, observation.position);
        stationarySince = distance <= LOITER_RADIUS_KM ? Number(previousMotion.stationary_since_ms ?? previousMotion.last_seen_ms) : current;
        if (current - stationarySince >= LOITER_MS) {
          this.recordTrigger({ triggerType: "loiter", ruleId: null, observationId: observation.observationId, entityId: observation.entityId, title: "LOITER DETECTED", message: `${observation.entityId} remained within ${LOITER_RADIUS_KM} km for at least ${LOITER_MS / 60_000} minutes.`, metadata: { radiusKm: LOITER_RADIUS_KM, durationMs: current - stationarySince }, dedupeKey: `loiter:${observation.entityId}` }, events); protectedIds.add(observation.observationId);
        }
      }
      this.writeState(motionKey, null, observation, null, stationarySince);
    }
    database.prepare("DELETE FROM hunter_trigger_state_v1 WHERE last_seen_ms<?").run(current - TRIGGER_STATE_RETENTION_MS);
    database.prepare("DELETE FROM hunter_trigger_state_v1 WHERE state_key IN (SELECT state_key FROM hunter_trigger_state_v1 ORDER BY last_seen_ms DESC LIMIT -1 OFFSET ?)").run(MAX_TRIGGER_STATES);
    database.prepare("DELETE FROM hunter_trigger_dedupe_v1 WHERE last_fired_ms<?").run(current - 24 * 60 * 60_000);
    database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
    return { events, protectedObservationIds: [...protectedIds] };
  }

  listTriggers(limit = 100): TriggerEvent[] {
    return (this.db().prepare("SELECT * FROM hunter_trigger_events_v1 ORDER BY occurred_at_ms DESC LIMIT ?").all(Math.max(1, Math.min(500, limit))) as Array<Record<string, unknown>>).map((row) => ({ id: String(row.id), triggerType: String(row.trigger_type) as TriggerType, ruleId: row.rule_id === null ? null : String(row.rule_id), observationId: String(row.observation_id), entityId: String(row.entity_id), title: String(row.title), message: String(row.message), occurredAt: iso(Number(row.occurred_at_ms)), metadata: parseJson(String(row.metadata_json), {}), acknowledged: Boolean(row.acknowledged) }));
  }
  acknowledgeTrigger(id: string) { return { updated: Number(this.db().prepare("UPDATE hunter_trigger_events_v1 SET acknowledged=1 WHERE id=?").run(id).changes) }; }

  async recordHealth(samples: FeedHealthSample[]) {
    if (!samples.length) return { recorded: 0 };
    await this.ensureWriteAllowed(samples.length * 768); const database = this.db(); let recorded = 0;
    const insert = database.prepare("INSERT INTO hunter_feed_health_v1(source_id,at_ms,status,error_rate,records_per_hour,expected_baseline,silent_zero,ai_context_eligible,message) VALUES(?,?,?,?,?,?,?,?,?)");
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const sample of samples.slice(0, 30)) {
        const last = database.prepare("SELECT at_ms FROM hunter_feed_health_v1 WHERE source_id=? ORDER BY at_ms DESC LIMIT 1").get(sample.sourceId) as { at_ms?: number } | undefined;
        const at = Date.parse(sample.at); if (last && at - Number(last.at_ms) < 5 * 60_000) continue;
        insert.run(sample.sourceId, at, sample.status, sample.errorRate, sample.recordsPerHour, sample.expectedBaseline, Number(sample.silentZero), Number(sample.aiContextEligible), sample.message.slice(0, 500)); recorded += 1;
      }
      database.prepare("DELETE FROM hunter_feed_health_v1 WHERE at_ms<?").run(this.now() - 30 * 24 * 60 * 60_000);
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
    return { recorded };
  }
  healthHistory(sourceId?: string, limit = 500): FeedHealthSample[] {
    const rows = sourceId
      ? this.db().prepare("SELECT * FROM hunter_feed_health_v1 WHERE source_id=? ORDER BY at_ms DESC LIMIT ?").all(sourceId, Math.max(1, Math.min(2_000, limit)))
      : this.db().prepare("SELECT * FROM hunter_feed_health_v1 ORDER BY at_ms DESC LIMIT ?").all(Math.max(1, Math.min(2_000, limit)));
    return (rows as Array<Record<string, unknown>>).map((row) => ({ sourceId: String(row.source_id), at: iso(Number(row.at_ms)), status: String(row.status), errorRate: Number(row.error_rate), recordsPerHour: Number(row.records_per_hour), expectedBaseline: Number(row.expected_baseline), silentZero: Boolean(row.silent_zero), aiContextEligible: Boolean(row.ai_context_eligible), message: String(row.message) }));
  }
}

export type ReplayManifest = {
  format: "voidcat-hunter-replay";
  version: 1;
  id: string;
  label: string;
  createdAt: string;
  endsAt: string;
  completedAt: string | null;
  sourceIds: string[];
  recordCount: number;
  bytes: number;
  status: "recording" | "complete" | "cancelled";
  checksum: string | null;
};

type ActiveReplay = { manifest: ReplayManifest; dataPath: string; manifestPath: string; stream: ReturnType<typeof createWriteStream>; hash: ReturnType<typeof createHash>; timer: ReturnType<typeof setTimeout> };

export class HunterReplayManager {
  private readonly replayRoot: string; private readonly now: () => number; private readonly ensureWriteAllowed: (bytes: number) => Promise<void>; private active: ActiveReplay | null = null; private writeQueue = Promise.resolve();
  constructor(options: { replayRoot: string; now?: () => number; ensureWriteAllowed?: (bytes: number) => Promise<void> }) { this.replayRoot = path.resolve(options.replayRoot); this.now = options.now ?? Date.now; this.ensureWriteAllowed = options.ensureWriteAllowed ?? (async () => undefined); }
  async start(input: { label?: string; durationMs?: number; sourceIds?: string[] } = {}) {
    if (this.active) throw new Error("A replay recording is already active.");
    const durationMs = Math.max(30_000, Math.min(30 * 60_000, Math.round(input.durationMs ?? 5 * 60_000))); await this.ensureWriteAllowed(2 * 1024 * 1024); await fs.mkdir(this.replayRoot, { recursive: true });
    const id = randomUUID(); const dataPath = path.join(this.replayRoot, `${id}.jsonl`); const manifestPath = path.join(this.replayRoot, `${id}.manifest.json`);
    const manifest: ReplayManifest = { format: "voidcat-hunter-replay", version: 1, id, label: (input.label?.trim() || `Hunter window ${iso(this.now())}`).slice(0, 120), createdAt: iso(this.now()), endsAt: iso(this.now() + durationMs), completedAt: null, sourceIds: [...new Set(input.sourceIds ?? [])].slice(0, 30), recordCount: 0, bytes: 0, status: "recording", checksum: null };
    const stream = createWriteStream(dataPath, { encoding: "utf8", flags: "wx" }); const hash = createHash("sha256");
    const timer = setTimeout(() => { void this.stop(false).catch(() => undefined); }, durationMs); this.active = { manifest, dataPath, manifestPath, stream, hash, timer }; await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), { encoding: "utf8", flag: "wx" }); return manifest;
  }
  async capture(observations: readonly HunterSeekerPublicObservation[]) {
    const active = this.active; if (!active || !observations.length) return { captured: 0 };
    const remainingRecords = Math.max(0, MAX_REPLAY_RECORDS - active.manifest.recordCount); const remainingBytes = Math.max(0, MAX_REPLAY_BYTES - active.manifest.bytes);
    if (!remainingRecords || !remainingBytes) { await this.stop(false); return { captured: 0 }; }
    const candidates = observations.filter((observation) => !active.manifest.sourceIds.length || active.manifest.sourceIds.includes(observation.provenance.sourceFeedId)).slice(0, Math.min(2_500, remainingRecords));
    const selected: HunterSeekerPublicObservation[] = []; const chunks: string[] = []; let byteLength = 0;
    for (const observation of candidates) {
      const line = `${JSON.stringify({ ...observation, rawPayload: undefined })}\n`; const lineBytes = Buffer.byteLength(line);
      if (byteLength + lineBytes > remainingBytes) break;
      selected.push(observation); chunks.push(line); byteLength += lineBytes;
    }
    if (!selected.length) return { captured: 0 };
    const lines = chunks.join(""); await this.ensureWriteAllowed(byteLength + 8_192);
    const operation = this.writeQueue.then(async () => {
      await new Promise<void>((resolve, reject) => active.stream.write(lines, (error) => error ? reject(error) : resolve()));
      active.hash.update(lines); active.manifest.recordCount += selected.length; active.manifest.bytes += byteLength;
      await fs.writeFile(active.manifestPath, JSON.stringify(active.manifest, null, 2), "utf8");
    });
    this.writeQueue = operation.catch(() => undefined); await operation;
    if (this.active === active && (active.manifest.recordCount >= MAX_REPLAY_RECORDS || active.manifest.bytes >= MAX_REPLAY_BYTES)) await this.stop(false);
    return { captured: selected.length };
  }
  async stop(cancelled = false) {
    const active = this.active; if (!active) return null; this.active = null; clearTimeout(active.timer); await this.writeQueue;
    await new Promise<void>((resolve) => active.stream.end(resolve)); active.manifest.status = cancelled ? "cancelled" : "complete"; active.manifest.completedAt = iso(this.now()); active.manifest.checksum = active.hash.digest("hex"); await fs.writeFile(active.manifestPath, JSON.stringify(active.manifest, null, 2), "utf8"); return active.manifest;
  }
  activeSnapshot() { return this.active ? structuredClone(this.active.manifest) : null; }
  async list() {
    await fs.mkdir(this.replayRoot, { recursive: true }); const files = (await fs.readdir(this.replayRoot)).filter((name) => name.endsWith(".manifest.json")).slice(-500); const manifests: ReplayManifest[] = [];
    for (const file of files) { try {
      const manifestPath = path.join(this.replayRoot, file); const value = JSON.parse(await fs.readFile(manifestPath, "utf8")) as ReplayManifest;
      if (value.format !== "voidcat-hunter-replay" || value.version !== 1) continue;
      if (value.status === "recording" && this.active?.manifest.id !== value.id) {
        value.status = "cancelled"; value.completedAt = iso(this.now()); value.checksum = null;
        await fs.writeFile(manifestPath, JSON.stringify(value, null, 2), "utf8");
      }
      manifests.push(value);
    } catch { /* corrupt manifests are excluded */ } }
    return manifests.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  }
  async load(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("A valid replay id is required."); const manifests = await this.list(); const manifest = manifests.find((item) => item.id === id); if (!manifest || manifest.status !== "complete" || !manifest.checksum) throw new Error("Replay is unavailable or incomplete.");
    const dataPath = path.join(this.replayRoot, `${id}.jsonl`); const stat = await fs.stat(dataPath); if (stat.size > MAX_REPLAY_BYTES) throw new Error("Replay exceeds the 64 MiB playback safety limit.");
    const hash = createHash("sha256"); const observations: HunterSeekerPublicObservation[] = []; const reader = readline.createInterface({ input: createReadStream(dataPath, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of reader) { hash.update(`${line}\n`); if (!line.trim()) continue; if (observations.length >= MAX_REPLAY_RECORDS) throw new Error("Replay exceeds the 50,000-record playback limit."); const value = JSON.parse(line) as HunterSeekerPublicObservation; if (!value || typeof value.observationId !== "string" || !value.position || !Number.isFinite(value.position.latitude) || !Number.isFinite(value.position.longitude) || typeof value.provenance?.sourceFeedId !== "string") throw new Error("Replay contains an invalid observation."); observations.push(value); }
    if (hash.digest("hex") !== manifest.checksum) throw new Error("Replay checksum validation failed."); return { manifest, observations, offline: true, apiCallsConsumed: 0 };
  }
}
