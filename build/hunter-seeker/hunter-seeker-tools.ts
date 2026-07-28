import type { HunterSeekerPublicObservation, HunterSeekerService, HunterSeekerSnapshot } from "./hunter-seeker-service.ts";
import { VoidCatToolRegistry, voidcatToolRegistry, type ToolInvocationCaller, type ToolJsonSchema } from "../voidcat-tool-registry.ts";
import { VoidCatJobManager, voidcatJobManager, type ManagedJobContext } from "../voidcat-job-manager.ts";
import { degreesLat, degreesLong, eciToGeodetic, gstime, json2satrec, propagate, type OMMJsonObject } from "satellite.js";

export const HUNTER_SEEKER_TOOL_NAMES = [
  "hunter-seeker.aircraft-in-bbox",
  "hunter-seeker.aircraft-by-callsign-or-icao",
  "hunter-seeker.vessels-in-bbox",
  "hunter-seeker.satellite-passes-over-area",
  "hunter-seeker.recent-seismic",
  "hunter-seeker.feed-health-status",
] as const;

export type HunterSeekerToolName = typeof HUNTER_SEEKER_TOOL_NAMES[number];

type BoundingBox = { south: number; west: number; north: number; east: number };
type ToolArguments = Record<string, unknown>;
type SupplementalHealthSource = {
  id: string;
  name: string;
  status: string;
  enabled: boolean;
  lastSuccessAt: string | null;
  nextAllowedAt: string | null;
  nextScheduledAt: string | null;
  cachedObservations: number;
  message: string;
};
type SupplementalSnapshot = { observations: HunterSeekerPublicObservation[]; coverageLimitations?: string[]; healthSources?: SupplementalHealthSource[] };

const TOOL_MODULE = "hunter-seeker";
const LIVE_ONLY_NOTICE = "Current bounded volatile snapshot only. No historical observations are stored; an empty result is not evidence of absence.";
const TOOL_RATE_LIMIT = { invocations: 30, windowMs: 60_000, maxConcurrent: 2 } as const;
const MAX_TOOL_OBSERVATIONS = 200;
const DEFAULT_COVERAGE_LIMITATIONS = [
  "Only enabled sources and their current volatile cached snapshot are covered.",
  "Provider outages, selected regions, rate limits, stale feeds, and non-broadcasting entities create coverage gaps.",
  "An empty result is not evidence of absence.",
];

const nullableNumberSchema: ToolJsonSchema = { anyOf: [{ type: "number" }, { type: "null" }] };
const observationSchema: ToolJsonSchema = {
  type: "object",
  properties: {
    observationId: { type: "string", minLength: 1, maxLength: 240 },
    entityId: { type: "string", minLength: 1, maxLength: 200 },
    entityType: { type: "string", minLength: 1, maxLength: 80 },
    label: { type: "string", minLength: 1, maxLength: 300 },
    latitude: { type: "number", minimum: -90, maximum: 90 },
    longitude: { type: "number", minimum: -180, maximum: 180 },
    altitudeMeters: nullableNumberSchema,
    timestamp: { type: "string", minLength: 20, maxLength: 50 },
    sourceFeedId: { type: "string", minLength: 1, maxLength: 100 },
    fetchedAt: { type: "string", minLength: 20, maxLength: 50 },
    stalenessMs: { type: "number", minimum: 0 },
    freshness: { type: "string", enum: ["LIVE", "CACHED", "STALE", "DEGRADED"] },
    provenance: {
      type: "object",
      properties: {
        sourceFeedId: { type: "string", minLength: 1, maxLength: 100 },
        fetchedAt: { type: "string", minLength: 20, maxLength: 50 },
        observationTimestamp: { type: "string", minLength: 20, maxLength: 50 },
      },
      required: ["sourceFeedId", "fetchedAt", "observationTimestamp"],
      additionalProperties: false,
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    basis: { type: "string", enum: ["measured", "derived", "estimated"] },
    detail: { type: "string", maxLength: 1_000 },
    citation: { type: "string", minLength: 6, maxLength: 250 },
    coverageLimitations: { type: "array", items: { type: "string", minLength: 1, maxLength: 500 }, maxItems: 10 },
  },
  required: ["observationId", "entityId", "entityType", "label", "latitude", "longitude", "altitudeMeters", "timestamp", "sourceFeedId", "fetchedAt", "stalenessMs", "freshness", "provenance", "confidence", "basis", "detail", "citation", "coverageLimitations"],
  additionalProperties: false,
};

const observationResultSchema: ToolJsonSchema = {
  type: "object",
  properties: {
    generatedAt: { type: "string", minLength: 20, maxLength: 50 },
    historicalResolution: { type: "string", minLength: 1, maxLength: 240 },
    observationIds: { type: "array", items: { type: "string", minLength: 1, maxLength: 240 }, maxItems: MAX_TOOL_OBSERVATIONS },
    provenance: { type: "string", minLength: 1, maxLength: 300 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    freshness: { type: "string", minLength: 20, maxLength: 50 },
    coverageLimitations: { type: "array", items: { type: "string", minLength: 1, maxLength: 500 }, maxItems: 10 },
    observations: { type: "array", items: observationSchema, maxItems: MAX_TOOL_OBSERVATIONS },
    truncated: { type: "boolean" },
  },
  required: ["generatedAt", "historicalResolution", "observationIds", "provenance", "confidence", "freshness", "coverageLimitations", "observations", "truncated"],
  additionalProperties: false,
};

const bboxProperties = {
  south: { type: "number", minimum: -90, maximum: 90 } as ToolJsonSchema,
  west: { type: "number", minimum: -180, maximum: 180 } as ToolJsonSchema,
  north: { type: "number", minimum: -90, maximum: 90 } as ToolJsonSchema,
  east: { type: "number", minimum: -180, maximum: 180 } as ToolJsonSchema,
  limit: { type: "integer", minimum: 1, maximum: MAX_TOOL_OBSERVATIONS } as ToolJsonSchema,
};

function bboxSchema(extra: Record<string, ToolJsonSchema> = {}): ToolJsonSchema {
  return {
    type: "object",
    properties: { ...bboxProperties, ...extra },
    required: ["south", "west", "north", "east"],
    additionalProperties: false,
  };
}

function numberArgument(argumentsValue: ToolArguments, key: string) {
  return typeof argumentsValue[key] === "number" ? argumentsValue[key] as number : Number.NaN;
}

function optionalLimit(argumentsValue: ToolArguments) {
  const value = argumentsValue.limit;
  return typeof value === "number" && Number.isInteger(value) ? Math.max(1, Math.min(MAX_TOOL_OBSERVATIONS, value)) : 100;
}

function boundingBox(argumentsValue: ToolArguments): BoundingBox {
  const bbox = {
    south: numberArgument(argumentsValue, "south"),
    west: numberArgument(argumentsValue, "west"),
    north: numberArgument(argumentsValue, "north"),
    east: numberArgument(argumentsValue, "east"),
  };
  if (bbox.south > bbox.north) throw new Error("Bounding box south cannot exceed north.");
  return bbox;
}

function inBoundingBox(observation: HunterSeekerPublicObservation, bbox: BoundingBox) {
  const latitudeMatches = observation.position.latitude >= bbox.south && observation.position.latitude <= bbox.north;
  const longitudeMatches = bbox.west <= bbox.east
    ? observation.position.longitude >= bbox.west && observation.position.longitude <= bbox.east
    : observation.position.longitude >= bbox.west || observation.position.longitude <= bbox.east;
  return latitudeMatches && longitudeMatches;
}

function textAttribute(observation: HunterSeekerPublicObservation, key: string) {
  const value = observation.attributes[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberAttribute(observation: HunterSeekerPublicObservation, key: string) {
  const value = observation.attributes[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function observationLabel(observation: HunterSeekerPublicObservation) {
  return textAttribute(observation, "title")
    ?? textAttribute(observation, "callsign")
    ?? textAttribute(observation, "shipName")
    ?? textAttribute(observation, "place")
    ?? textAttribute(observation, "headline")
    ?? observation.entityId;
}

function compactDetail(observation: HunterSeekerPublicObservation) {
  const values = [
    textAttribute(observation, "callsign") && `CALLSIGN ${textAttribute(observation, "callsign")}`,
    textAttribute(observation, "transponderHex") && `ICAO ${textAttribute(observation, "transponderHex")}`,
    textAttribute(observation, "registration") && `REG ${textAttribute(observation, "registration")}`,
    textAttribute(observation, "mmsi") && `MMSI ${textAttribute(observation, "mmsi")}`,
    textAttribute(observation, "noradCatalogId") && `NORAD ${textAttribute(observation, "noradCatalogId")}`,
    textAttribute(observation, "passStartsAt") && `PASS START ${textAttribute(observation, "passStartsAt")}`,
    textAttribute(observation, "passEndsAt") && `PASS END ${textAttribute(observation, "passEndsAt")}`,
    numberAttribute(observation, "magnitude") !== undefined && `MAG ${numberAttribute(observation, "magnitude")!.toFixed(1)}`,
    textAttribute(observation, "severity") && `SEVERITY ${textAttribute(observation, "severity")!.toUpperCase()}`,
    numberAttribute(observation, "groundspeedKnots") !== undefined && `SPEED ${numberAttribute(observation, "groundspeedKnots")!.toFixed(1)} KT`,
    numberAttribute(observation, "speedOverGroundKnots") !== undefined && `SPEED ${numberAttribute(observation, "speedOverGroundKnots")!.toFixed(1)} KT`,
  ].filter((value): value is string => Boolean(value));
  return values.join(" // ").slice(0, 1_000);
}

function evidenceFreshness(snapshot: HunterSeekerSnapshot, observation: HunterSeekerPublicObservation) {
  const source = snapshot.sources.find(({ descriptor }) => descriptor.id === observation.provenance.sourceFeedId);
  if (!source || ["degraded", "down", "rate-limited"].includes(source.health.status)) return "DEGRADED";
  const cadence = Math.max(30_000, source.health.pollCadenceMs);
  if (observation.provenance.stalenessMs <= cadence) return "LIVE";
  if (observation.provenance.stalenessMs <= cadence * 2) return "CACHED";
  return "STALE";
}

function publicEvidence(snapshot: HunterSeekerSnapshot, observation: HunterSeekerPublicObservation, coverageLimitations = DEFAULT_COVERAGE_LIMITATIONS) {
  return {
    observationId: observation.observationId,
    entityId: observation.entityId,
    entityType: observation.entityType,
    label: observationLabel(observation).slice(0, 300),
    latitude: observation.position.latitude,
    longitude: observation.position.longitude,
    altitudeMeters: observation.position.altitudeMeters ?? null,
    timestamp: observation.timestamp,
    sourceFeedId: observation.provenance.sourceFeedId,
    fetchedAt: observation.provenance.fetchedAt,
    stalenessMs: observation.provenance.stalenessMs,
    freshness: evidenceFreshness(snapshot, observation),
    provenance: { sourceFeedId: observation.provenance.sourceFeedId, fetchedAt: observation.provenance.fetchedAt, observationTimestamp: observation.timestamp },
    confidence: observation.confidence,
    basis: observation.basis,
    detail: compactDetail(observation),
    citation: `[HS:${observation.observationId}]`,
    coverageLimitations,
  };
}

function result(snapshot: HunterSeekerSnapshot, matches: HunterSeekerPublicObservation[], limit: number, coverageLimitations = DEFAULT_COVERAGE_LIMITATIONS) {
  const selected = matches.slice(0, limit);
  return {
    generatedAt: snapshot.generatedAt,
    historicalResolution: LIVE_ONLY_NOTICE,
    observationIds: selected.map((observation) => observation.observationId),
    provenance: "VoidCat Hunter-Seeker current volatile source-registry snapshot.",
    confidence: selected.length ? Math.min(...selected.map((observation) => observation.confidence)) : 1,
    freshness: snapshot.generatedAt,
    coverageLimitations,
    observations: selected.map((observation) => publicEvidence(snapshot, observation, coverageLimitations)),
    truncated: matches.length > limit,
  };
}

function newestFirst(left: HunterSeekerPublicObservation, right: HunterSeekerPublicObservation) {
  return Date.parse(right.timestamp) - Date.parse(left.timestamp);
}

function orbitalElements(observation: HunterSeekerPublicObservation) {
  const value = observation.attributes.orbitalElements;
  return value && typeof value === "object" && !Array.isArray(value) ? value as OMMJsonObject : undefined;
}

function satellitePasses(snapshot: HunterSeekerSnapshot, argumentsValue: ToolArguments, signal: AbortSignal) {
  const bbox = boundingBox(argumentsValue);
  const hours = typeof argumentsValue.hours === "number" ? argumentsValue.hours : 2;
  const stepSeconds = typeof argumentsValue.stepSeconds === "number" ? argumentsValue.stepSeconds : 60;
  const startMs = Date.parse(snapshot.generatedAt);
  const endMs = startMs + hours * 60 * 60_000;
  const passes: HunterSeekerPublicObservation[] = [];
  for (const station of snapshot.observations.filter((item) => item.entityType.includes("space-station"))) {
    if (signal.aborted) throw signal.reason ?? new Error("Satellite pass calculation cancelled.");
    const elements = orbitalElements(station);
    if (!elements) continue;
    const satrec = json2satrec(elements);
    let enteredAt: number | null = null;
    let closest: { time: number; latitude: number; longitude: number; altitudeMeters: number } | null = null;
    for (let time = startMs; time <= endMs; time += stepSeconds * 1_000) {
      if (signal.aborted) throw signal.reason ?? new Error("Satellite pass calculation cancelled.");
      const date = new Date(time);
      const state = propagate(satrec, date);
      if (!state) continue;
      const geodetic = eciToGeodetic(state.position, gstime(date));
      const point = { time, latitude: degreesLat(geodetic.latitude), longitude: degreesLong(geodetic.longitude), altitudeMeters: geodetic.height * 1_000 };
      const inside = inBoundingBox({ ...station, position: point }, bbox);
      if (inside && enteredAt === null) enteredAt = time;
      if (inside) closest = point;
      if (!inside && enteredAt !== null && closest) {
        const norad = textAttribute(station, "noradCatalogId") ?? station.entityId;
        const passId = `satellite-pass:${norad}:${new Date(enteredAt).toISOString()}`;
        passes.push({
          ...station,
          observationId: passId,
          entityType: "satellite-pass",
          position: { latitude: closest.latitude, longitude: closest.longitude, altitudeMeters: closest.altitudeMeters },
          timestamp: new Date(enteredAt).toISOString(),
          basis: "estimated",
          attributes: {
            ...station.attributes,
            title: `${observationLabel(station)} predicted pass`,
            passStartsAt: new Date(enteredAt).toISOString(),
            passEndsAt: new Date(time).toISOString(),
            samplingStepSeconds: stepSeconds,
          },
        });
        enteredAt = null;
        closest = null;
      }
    }
    if (enteredAt !== null && closest) {
      const norad = textAttribute(station, "noradCatalogId") ?? station.entityId;
      passes.push({
        ...station,
        observationId: `satellite-pass:${norad}:${new Date(enteredAt).toISOString()}`,
        entityType: "satellite-pass",
        position: { latitude: closest.latitude, longitude: closest.longitude, altitudeMeters: closest.altitudeMeters },
        timestamp: new Date(enteredAt).toISOString(),
        basis: "estimated",
        attributes: { ...station.attributes, title: `${observationLabel(station)} predicted pass`, passStartsAt: new Date(enteredAt).toISOString(), passEndsAt: new Date(endMs).toISOString(), samplingStepSeconds: stepSeconds },
      });
    }
  }
  return passes.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

function healthResultSchema(): ToolJsonSchema {
  return {
    type: "object",
    properties: {
      generatedAt: { type: "string", minLength: 20, maxLength: 50 },
      running: { type: "boolean" },
      retention: { type: "string", enum: ["memory-only"] },
      historicalResolution: { type: "string", minLength: 1, maxLength: 240 },
      observationIds: { type: "array", items: { type: "string", minLength: 1, maxLength: 240 }, maxItems: 500 },
      provenance: { type: "string", minLength: 1, maxLength: 300 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      freshness: { type: "string", minLength: 1, maxLength: 100 },
      coverageLimitations: { type: "array", items: { type: "string", minLength: 1, maxLength: 500 }, maxItems: 10 },
      sources: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          properties: {
            observationId: { type: "string", minLength: 1, maxLength: 240 },
            citation: { type: "string", minLength: 6, maxLength: 250 },
            id: { type: "string", minLength: 1, maxLength: 100 },
            name: { type: "string", minLength: 1, maxLength: 200 },
            status: { type: "string", minLength: 1, maxLength: 50 },
            enabled: { type: "boolean" },
            lastSuccessAt: { anyOf: [{ type: "string", maxLength: 50 }, { type: "null" }] },
            nextAllowedAt: { anyOf: [{ type: "string", maxLength: 50 }, { type: "null" }] },
            nextScheduledAt: { anyOf: [{ type: "string", maxLength: 50 }, { type: "null" }] },
            cachedObservations: { type: "integer", minimum: 0 },
            message: { type: "string", maxLength: 500 },
          },
          required: ["observationId", "citation", "id", "name", "status", "enabled", "lastSuccessAt", "nextAllowedAt", "nextScheduledAt", "cachedObservations", "message"],
          additionalProperties: false,
        },
      },
    },
    required: ["generatedAt", "running", "retention", "historicalResolution", "observationIds", "provenance", "confidence", "freshness", "coverageLimitations", "sources"],
    additionalProperties: false,
  };
}

export class HunterSeekerToolRuntime {
  private readonly unregisterCallbacks: Array<() => boolean> = [];
  private registered = false;
  private readonly service: HunterSeekerService;
  private readonly supplementalSnapshot: () => SupplementalSnapshot;
  readonly registry: VoidCatToolRegistry;
  readonly jobs: VoidCatJobManager;

  constructor(
    service: HunterSeekerService,
    registry: VoidCatToolRegistry = voidcatToolRegistry,
    jobs: VoidCatJobManager = voidcatJobManager,
    supplementalSnapshot: () => SupplementalSnapshot = () => ({ observations: [] }),
  ) {
    this.service = service;
    this.registry = registry;
    this.jobs = jobs;
    this.supplementalSnapshot = supplementalSnapshot;
  }

  private async snapshot() {
    const snapshot = await this.service.snapshot();
    const supplemental = this.supplementalSnapshot();
    return { snapshot: { ...snapshot, observations: [...snapshot.observations, ...supplemental.observations] }, coverageLimitations: supplemental.coverageLimitations ?? DEFAULT_COVERAGE_LIMITATIONS };
  }

  register() {
    if (this.registered) return;
    const registerObservations = (definition: {
      name: HunterSeekerToolName;
      description: string;
      inputSchema: ToolJsonSchema;
      select(snapshot: HunterSeekerSnapshot, argumentsValue: ToolArguments): HunterSeekerPublicObservation[];
    }) => {
      this.unregisterCallbacks.push(this.registry.register({
        name: definition.name,
        module: TOOL_MODULE,
        description: definition.description,
        inputSchema: definition.inputSchema,
        outputSchema: observationResultSchema,
        rateLimit: TOOL_RATE_LIMIT,
        maxOutputBytes: 512 * 1024,
        tags: ["read-only", "passive-osint", "live-only"],
        handler: async (argumentsValue, context) => {
          const { snapshot, coverageLimitations } = await this.snapshot();
          context.reportCost({ units: 1 });
          const matches = definition.select(snapshot, argumentsValue).sort(newestFirst);
          return result(snapshot, matches, optionalLimit(argumentsValue), coverageLimitations);
        },
      }));
    };

    registerObservations({
      name: "hunter-seeker.aircraft-in-bbox",
      description: "Returns current aircraft positions inside a bounding box from the volatile live board. Limited to 30 calls/minute; freshness and observation IDs are included; no historical track resolution exists.",
      inputSchema: bboxSchema({ classification: { type: "string", enum: ["all", "military", "civil-or-unclassified"] } }),
      select: (snapshot, argumentsValue) => {
        const bbox = boundingBox(argumentsValue);
        const classification = typeof argumentsValue.classification === "string" ? argumentsValue.classification : "all";
        return snapshot.observations.filter((observation) => observation.entityType.includes("aircraft")
          && inBoundingBox(observation, bbox)
          && (classification === "all" || (classification === "military") === observation.entityType.includes("military")));
      },
    });
    registerObservations({
      name: "hunter-seeker.aircraft-by-callsign-or-icao",
      description: "Looks up current aircraft by exact callsign or six-character ICAO transponder address in the volatile live board. Limited to 30 calls/minute; freshness and observation IDs are included; no historical track resolution exists.",
      inputSchema: {
        type: "object",
        properties: { identifier: { type: "string", minLength: 1, maxLength: 20, pattern: "^[A-Za-z0-9 -]+$" }, limit: bboxProperties.limit },
        required: ["identifier"],
        additionalProperties: false,
      },
      select: (snapshot, argumentsValue) => {
        const identifier = String(argumentsValue.identifier).trim().toUpperCase();
        return snapshot.observations.filter((observation) => observation.entityType.includes("aircraft")
          && (textAttribute(observation, "callsign")?.toUpperCase() === identifier || textAttribute(observation, "transponderHex")?.toUpperCase() === identifier));
      },
    });
    registerObservations({
      name: "hunter-seeker.vessels-in-bbox",
      description: "Returns current AIS vessel positions inside a bounding box from the operator-selected maritime region. Limited to 30 calls/minute; provenance, freshness, IDs, and explicit regional coverage gaps are included; no history exists.",
      inputSchema: bboxSchema(),
      select: (snapshot, argumentsValue) => {
        const bbox = boundingBox(argumentsValue);
        return snapshot.observations.filter((observation) => observation.entityType.includes("vessel") && inBoundingBox(observation, bbox));
      },
    });
    this.unregisterCallbacks.push(this.registry.register({
      name: "hunter-seeker.satellite-passes-over-area",
      module: TOOL_MODULE,
      description: "Predicts bounded CelesTrak station subpoint crossings over a bounding box using cached orbital elements and SGP4 sampling. Limited to 30 calls/minute; these are estimates, not visibility guarantees, and no history exists.",
      inputSchema: bboxSchema({ hours: { type: "integer", minimum: 1, maximum: 6 }, stepSeconds: { type: "integer", minimum: 30, maximum: 300 } }),
      outputSchema: observationResultSchema,
      rateLimit: TOOL_RATE_LIMIT,
      maxOutputBytes: 512 * 1024,
      tags: ["read-only", "passive-osint", "live-only", "estimated"],
      handler: async (argumentsValue, context) => {
        const { snapshot } = await this.snapshot();
        context.reportCost({ units: 2 });
        const limitations = [...DEFAULT_COVERAGE_LIMITATIONS, "Passes are sampled SGP4 subpoint crossings from cached CelesTrak elements; they do not guarantee optical or radio visibility."];
        return result(snapshot, satellitePasses(snapshot, argumentsValue, context.signal), optionalLimit(argumentsValue), limitations);
      },
    }));
    registerObservations({
      name: "hunter-seeker.recent-seismic",
      description: "Returns seismic observations from the current past-day live snapshot filtered by magnitude and age. Limited to 30 calls/minute; observation IDs are included; no Hunter-Seeker history exists beyond the provider snapshot.",
      inputSchema: {
        type: "object",
        properties: {
          minimumMagnitude: { type: "number", minimum: -2, maximum: 10 },
          maxAgeMinutes: { type: "integer", minimum: 1, maximum: 1_440 },
          limit: bboxProperties.limit,
        },
        additionalProperties: false,
      },
      select: (snapshot, argumentsValue) => {
        const minimumMagnitude = typeof argumentsValue.minimumMagnitude === "number" ? argumentsValue.minimumMagnitude : 0;
        const maximumAgeMs = (typeof argumentsValue.maxAgeMinutes === "number" ? argumentsValue.maxAgeMinutes : 1_440) * 60_000;
        const generatedAt = Date.parse(snapshot.generatedAt);
        return snapshot.observations.filter((observation) => observation.entityType.includes("seismic")
          && (numberAttribute(observation, "magnitude") ?? Number.NEGATIVE_INFINITY) >= minimumMagnitude
          && generatedAt - Date.parse(observation.timestamp) <= maximumAgeMs);
      },
    });
    this.unregisterCallbacks.push(this.registry.register({
      name: "hunter-seeker.feed-health-status",
      module: TOOL_MODULE,
      description: "Reports current Hunter-Seeker feed status, last success, next allowed/scheduled pull, and volatile record counts. Limited to 60 calls/minute; it reports no historical health baseline.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: healthResultSchema(),
      rateLimit: { invocations: 60, windowMs: 60_000, maxConcurrent: 2 },
      maxOutputBytes: 128 * 1024,
      tags: ["read-only", "passive-osint", "live-only", "health"],
      handler: async (_argumentsValue, context) => {
        const { snapshot } = await this.snapshot();
        const supplemental = this.supplementalSnapshot();
        context.reportCost({ units: 0.25 });
        const sourceHealth = [...snapshot.sources.map(({ descriptor, health }) => ({
          id: descriptor.id,
          name: descriptor.displayName,
          status: health.status,
          enabled: health.enabled,
          lastSuccessAt: health.lastSuccessAt ?? null,
          nextAllowedAt: health.nextAllowedAt ?? null,
          nextScheduledAt: health.nextScheduledAt ?? null,
          cachedObservations: health.cachedObservations,
          message: (health.message ?? "No provider status message.").slice(0, 500),
        })), ...(supplemental.healthSources ?? [])].map((source) => {
          const observationId = `feed-health:${source.id}:${snapshot.generatedAt}`;
          return { ...source, observationId, citation: `[HS:${observationId}]` };
        });
        return {
          generatedAt: snapshot.generatedAt,
          running: snapshot.running,
          retention: snapshot.retention,
          historicalResolution: LIVE_ONLY_NOTICE,
          observationIds: [...sourceHealth.map((source) => source.observationId), ...snapshot.observations.map((observation) => observation.observationId)].slice(0, 500),
          provenance: "VoidCat Hunter-Seeker in-process source registry plus authenticated protected-desktop AIS snapshot bridge.",
          confidence: 1,
          freshness: snapshot.generatedAt,
          coverageLimitations: this.supplementalSnapshot().coverageLimitations ?? DEFAULT_COVERAGE_LIMITATIONS,
          sources: sourceHealth,
        };
      },
    }));
    this.registered = true;
  }

  unregister() {
    while (this.unregisterCallbacks.length) this.unregisterCallbacks.pop()!();
    this.registered = false;
  }

  discover() {
    return this.registry.discover({ module: TOOL_MODULE });
  }

  invokeInManagedContext(name: string, argumentsValue: ToolArguments, context: ManagedJobContext, caller: ToolInvocationCaller) {
    if (!HUNTER_SEEKER_TOOL_NAMES.includes(name as HunterSeekerToolName)) throw new Error("Only registered Hunter-Seeker tools may be invoked through this runtime.");
    context.consumeIteration();
    context.reportUsage({ units: 1 });
    return this.registry.invoke(name, argumentsValue, { caller, signal: context.signal });
  }

  startInvocation(name: string, argumentsValue: ToolArguments, caller: ToolInvocationCaller = { kind: "user" }) {
    return this.jobs.start({
      module: TOOL_MODULE,
      name: "tool-invocation",
      caps: { maxIterations: 2, timeoutMs: 10_000, maxExternalCalls: 1 },
      run: async (context) => {
        context.reportProgress({ current: 0, total: 1, message: `Invoking ${name}` });
        const value = await context.externalCall(() => this.invokeInManagedContext(name, argumentsValue, context, caller));
        context.reportProgress({ current: 1, total: 1, message: "Tool complete" });
        return value;
      },
    });
  }
}
