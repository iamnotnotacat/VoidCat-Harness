import type { NormalizedObservation, SourceAdapter } from "./source-adapter.ts";
import { SourceRegistry, type SourceHealthSnapshot, type SourceRefreshResult } from "./source-registry.ts";
import { NwsAlertsAdapter } from "./adapters/nws-alerts-adapter.ts";
import { UsgsEarthquakeAdapter } from "./adapters/usgs-earthquake-adapter.ts";
import { ADSB_LOL_MILITARY_SOURCE_ID, AdsbLolMilitaryAdapter } from "./adapters/adsb-lol-military-adapter.ts";
import { CelestrakStationsAdapter } from "./adapters/celestrak-stations-adapter.ts";
import { OPENSKY_CIVIL_AIRCRAFT_SOURCE_ID, OpenSkyCivilAircraftAdapter } from "./adapters/opensky-civil-aircraft-adapter.ts";

export type HunterSeekerPublicObservation = Omit<NormalizedObservation, "rawPayload">;

export type HunterSeekerSourceSnapshot = {
  descriptor: SourceAdapter["descriptor"];
  health: SourceHealthSnapshot;
};

export type HunterSeekerSnapshot = {
  running: boolean;
  generatedAt: string;
  retention: "memory-only";
  sources: HunterSeekerSourceSnapshot[];
  observationCount: number;
  observations: HunterSeekerPublicObservation[];
  refreshResults?: SourceRefreshResult[];
};

const MAX_PUBLIC_OBSERVATIONS = 2_500;

function removeRawPayload(observation: NormalizedObservation): HunterSeekerPublicObservation {
  const publicObservation = { ...observation };
  delete publicObservation.rawPayload;
  return publicObservation;
}

export class HunterSeekerService {
  private readonly registry: SourceRegistry;
  private running = false;

  constructor(adapters?: SourceAdapter[]) {
    this.registry = new SourceRegistry();
    const registeredAdapters = adapters ?? [new UsgsEarthquakeAdapter(), new NwsAlertsAdapter(), new AdsbLolMilitaryAdapter(), new OpenSkyCivilAircraftAdapter(), new CelestrakStationsAdapter()];
    registeredAdapters.forEach((adapter) => this.registry.register(adapter));
    // Current OpenSky terms require written permission for operational REST API use.
    // Keep the adapter available for licensed operators, but never contact it by default.
    if (!adapters) this.registry.setEnabled(OPENSKY_CIVIL_AIRCRAFT_SOURCE_ID, false);
    this.registry.subscribe((sourceId) => {
      void this.registry.dropRawPayloads(sourceId);
    });
  }

  async start() {
    if (this.running) return this.snapshot();
    this.running = true;
    this.registry.start({ fetchImmediately: false });
    const refreshResults = await this.registry.refreshAll();
    await this.registry.dropRawPayloads();
    return this.snapshot(refreshResults);
  }

  async refresh() {
    if (!this.running) return this.start();
    // Calling the registry directly bypasses the selected scheduler cadence;
    // provider request floors, retry instructions, and hard ceilings still apply.
    const refreshResults = await this.registry.refreshAll();
    await this.registry.dropRawPayloads();
    return this.snapshot(refreshResults);
  }

  async configureSource(sourceId: string, options: { enabled?: boolean; pollCadenceMs?: number }) {
    if (options.enabled === undefined && options.pollCadenceMs === undefined) {
      throw new Error("A source enabled state or pull rate is required.");
    }
    if (options.enabled !== undefined && typeof options.enabled !== "boolean") throw new Error("Source enabled state must be true or false.");
    if (options.pollCadenceMs !== undefined && typeof options.pollCadenceMs !== "number") throw new Error("Source pull rate must be numeric.");
    if (options.pollCadenceMs !== undefined) this.registry.setPollCadence(sourceId, options.pollCadenceMs);
    if (options.enabled !== undefined) {
      this.registry.setEnabled(sourceId, options.enabled);
    }
    return this.snapshot();
  }

  async stop() {
    this.registry.stop();
    this.running = false;
    await this.registry.clearObservations();
    return this.snapshot();
  }

  async snapshot(refreshResults?: SourceRefreshResult[]): Promise<HunterSeekerSnapshot> {
    const [health, observations] = await Promise.all([
      this.registry.healthAll(),
      this.registry.observations(),
    ]);
    const descriptors = new Map(this.registry.list().map((descriptor) => [descriptor.id, descriptor]));
    const sources = health.map((sourceHealth) => ({
      descriptor: descriptors.get(sourceHealth.sourceId)!,
      health: sourceHealth,
    }));
    const enabledSourceIds = new Set(health.filter((sourceHealth) => sourceHealth.enabled).map((sourceHealth) => sourceHealth.sourceId));
    const withoutRawPayloads = observations
      .filter((observation) => enabledSourceIds.has(observation.provenance.sourceFeedId))
      .map(removeRawPayload);
    const militaryAircraftIds = new Set(withoutRawPayloads
      .filter((observation) => observation.provenance.sourceFeedId === ADSB_LOL_MILITARY_SOURCE_ID)
      .map((observation) => observation.entityId));
    const publicObservations = withoutRawPayloads
      .filter((observation) => observation.provenance.sourceFeedId !== OPENSKY_CIVIL_AIRCRAFT_SOURCE_ID || !militaryAircraftIds.has(observation.entityId))
      .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));
    return {
      running: this.running,
      generatedAt: new Date().toISOString(),
      retention: "memory-only",
      sources,
      observationCount: publicObservations.length,
      observations: publicObservations.slice(0, MAX_PUBLIC_OBSERVATIONS),
      ...(refreshResults ? { refreshResults } : {}),
    };
  }
}

export const hunterSeekerService = new HunterSeekerService();
