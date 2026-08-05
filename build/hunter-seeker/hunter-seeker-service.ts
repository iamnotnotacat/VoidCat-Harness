/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import type { NormalizedObservation, SourceAdapter } from "./source-adapter.ts";
import { toCommonEvent, type CommonEvent } from "./common-event.ts";
import { SourceRegistry, type SourceHealthSnapshot, type SourceRefreshResult } from "./source-registry.ts";
import { NwsAlertsAdapter } from "./adapters/nws-alerts-adapter.ts";
import { UsgsEarthquakeAdapter } from "./adapters/usgs-earthquake-adapter.ts";
import { ADSB_LOL_MILITARY_SOURCE_ID, AdsbLolMilitaryAdapter } from "./adapters/adsb-lol-military-adapter.ts";
import { CELESTRAK_ADDITIONAL_GROUPS, CelestrakStationsAdapter } from "./adapters/celestrak-stations-adapter.ts";
import { NASA_EONET_CLASSES, NASA_EONET_SOURCE_ID, createNasaEonetAdapters } from "./adapters/nasa-eonet-adapter.ts";
import { OPENSKY_CIVIL_AIRCRAFT_SOURCE_ID, OpenSkyCivilAircraftAdapter } from "./adapters/opensky-civil-aircraft-adapter.ts";
import { DEFLOCK_ALPR_SOURCE_ID, DeflockAlprAdapter, type DeflockViewport } from "./adapters/deflock-alpr-adapter.ts";
import { PUBLIC_WEBCAM_SOURCE_ID, PublicWebcamAdapter } from "./adapters/public-webcam-adapter.ts";
import { WINDY_WEBCAM_SOURCE_ID, WindyWebcamAdapter } from "./adapters/windy-webcam-adapter.ts";
import { GDACS_EVENTS_SOURCE_ID, GdacsEventsAdapter } from "./adapters/gdacs-events-adapter.ts";
import { NOAA_NHC_SOURCE_ID, NoaaNhcAdapter } from "./adapters/noaa-nhc-adapter.ts";
import { AVIATION_WEATHER_SOURCE_ID, AviationWeatherAdapter } from "./adapters/aviation-weather-adapter.ts";
import { GDELT_GEO_SOURCE_ID, GdeltGeoAdapter } from "./adapters/gdelt-geo-adapter.ts";
import { HunterSourceQueryRegistry, type HunterMapOverlay, type HunterSourceQueryInput, type HunterSourceQueryResult } from "./source-query.ts";
import { queryHunterCredentialBroker } from "./source-query-broker-client.ts";
import { HUNTER_SOURCE_QUERY_PROVIDERS } from "./query-providers/index.ts";

export type HunterSeekerPublicObservation = Omit<NormalizedObservation, "rawPayload"> & { commonEvent?: CommonEvent };

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
  sourceQueryCapabilities: ReturnType<HunterSourceQueryRegistry["list"]>;
  sourceQueries: Array<{ sourceId: string; queriedAt: string; cache: HunterSourceQueryResult["cache"]; observationCount: number; observationIds: string[]; references: HunterSourceQueryResult["references"]; coverageLimitation?: string }>;
  mapOverlays: HunterMapOverlay[];
  refreshResults?: SourceRefreshResult[];
};

const MAX_PUBLIC_OBSERVATIONS = 252_000;

function removeRawPayload(observation: NormalizedObservation): HunterSeekerPublicObservation {
  const publicObservation = { ...observation, commonEvent: toCommonEvent(observation) };
  delete publicObservation.rawPayload;
  return publicObservation;
}

export class HunterSeekerService {
  private readonly registry: SourceRegistry;
  private readonly queryRegistry: HunterSourceQueryRegistry;
  private readonly queryResults = new Map<string, HunterSourceQueryResult>();
  private readonly queryInputs = new Map<string, HunterSourceQueryInput>();
  private readonly deflockAdapter?: DeflockAlprAdapter;
  private readonly observationListeners = new Set<(sourceId: string, observations: readonly HunterSeekerPublicObservation[]) => void>();
  private running = false;

  constructor(adapters?: SourceAdapter[], options: { queryRegistry?: HunterSourceQueryRegistry } = {}) {
    this.registry = new SourceRegistry();
    this.queryRegistry = options.queryRegistry ?? new HunterSourceQueryRegistry({ providers: [...HUNTER_SOURCE_QUERY_PROVIDERS], brokerQuery: queryHunterCredentialBroker });
    const registeredAdapters = adapters ?? [
      new UsgsEarthquakeAdapter(),
      new NwsAlertsAdapter(),
      new AdsbLolMilitaryAdapter(),
      new OpenSkyCivilAircraftAdapter(),
      new CelestrakStationsAdapter(),
      new DeflockAlprAdapter(),
      new PublicWebcamAdapter(),
      new WindyWebcamAdapter(),
      new GdacsEventsAdapter(),
      new NoaaNhcAdapter(),
      new AviationWeatherAdapter(),
      new GdeltGeoAdapter(),
      ...createNasaEonetAdapters(),
      ...CELESTRAK_ADDITIONAL_GROUPS.map((group) => new CelestrakStationsAdapter({ ...group, maximumRecords: 500 })),
    ];
    this.deflockAdapter = registeredAdapters.find((adapter): adapter is DeflockAlprAdapter => adapter instanceof DeflockAlprAdapter);
    registeredAdapters.forEach((adapter) => this.registry.register(adapter));
    // Current OpenSky terms require written permission for operational REST API use.
    // Keep the adapter available for licensed operators, but never contact it by default.
    if (!adapters) {
      this.registry.setEnabled(OPENSKY_CIVIL_AIRCRAFT_SOURCE_ID, false);
      // DeFlock remains operator-controlled. Enabling it retrieves only the
      // lightweight daily region index; camera tiles load on an explicit hub click.
      this.registry.setEnabled(DEFLOCK_ALPR_SOURCE_ID, false);
      // Public webcam discovery is credentialed and operator initiated. The
      // source publishes only lightweight sector hubs until one is selected.
      this.registry.setEnabled(PUBLIC_WEBCAM_SOURCE_ID, false);
      this.registry.setEnabled(WINDY_WEBCAM_SOURCE_ID, false);
      this.registry.setEnabled(GDACS_EVENTS_SOURCE_ID, false);
      this.registry.setEnabled(NOAA_NHC_SOURCE_ID, false);
      this.registry.setEnabled(AVIATION_WEATHER_SOURCE_ID, false);
      this.registry.setEnabled(GDELT_GEO_SOURCE_ID, false);
      // Optional expansion layers are deliberately operator-controlled. NASA
      // EONET is one combined source whose records retain their event class;
      // each CelesTrak group enforces its own two-hour provider request floor.
      this.registry.setEnabled(NASA_EONET_SOURCE_ID, false);
      for (const group of CELESTRAK_ADDITIONAL_GROUPS) this.registry.setEnabled(group.sourceId, false);
    }
    this.registry.subscribe((sourceId, observations) => {
      const publicObservations = observations.map(removeRawPayload);
      for (const listener of this.observationListeners) {
        try { listener(sourceId, publicObservations); } catch { /* persistence subscribers cannot interrupt live publication */ }
      }
      void this.registry.dropRawPayloads(sourceId);
    });
  }

  subscribeObservations(listener: (sourceId: string, observations: readonly HunterSeekerPublicObservation[]) => void) {
    this.observationListeners.add(listener);
    return () => { this.observationListeners.delete(listener); };
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

  async configureSource(sourceId: string, options: { enabled?: boolean; pollCadenceMs?: number; requestBudgetPercent?: number }) {
    if (options.enabled === undefined && options.pollCadenceMs === undefined && options.requestBudgetPercent === undefined) {
      throw new Error("A source enabled state, pull rate, or request budget is required.");
    }
    if (options.enabled !== undefined && typeof options.enabled !== "boolean") throw new Error("Source enabled state must be true or false.");
    if (options.pollCadenceMs !== undefined && typeof options.pollCadenceMs !== "number") throw new Error("Source pull rate must be numeric.");
    if (options.requestBudgetPercent !== undefined && typeof options.requestBudgetPercent !== "number") throw new Error("Source request budget must be numeric.");
    if (options.pollCadenceMs !== undefined && sourceId !== DEFLOCK_ALPR_SOURCE_ID && sourceId !== PUBLIC_WEBCAM_SOURCE_ID && sourceId !== WINDY_WEBCAM_SOURCE_ID) this.registry.setPollCadence(sourceId, options.pollCadenceMs);
    if (options.requestBudgetPercent !== undefined) this.registry.setRequestBudgetPercent(sourceId, options.requestBudgetPercent);
    if (options.enabled !== undefined) {
      this.registry.setEnabled(sourceId, options.enabled);
    }
    if (options.enabled === true && this.running) {
      const result = await this.registry.refresh(sourceId);
      await this.registry.dropRawPayloads(sourceId);
      return this.snapshot([result]);
    }
    return this.snapshot();
  }

  async refreshSource(sourceId: string) {
    if (this.registry.list().some(({ id }) => id === sourceId)) {
      const result = await this.registry.refresh(sourceId);
      await this.registry.dropRawPayloads(sourceId);
      return this.snapshot([result]);
    }
    if (this.queryRegistry.has(sourceId)) {
      const input = this.queryInputs.get(sourceId);
      if (!input) throw new Error(`${sourceId} requires an initial bounded query before it can be refreshed.`);
      await this.querySource(input, { bypassCache: true });
      return this.snapshot();
    }
    throw new Error(`Unknown Hunter-Seeker source: ${sourceId}`);
  }

  async setDeflockViewport(viewport: DeflockViewport, options: { refresh?: boolean } = {}) {
    if (!this.deflockAdapter) throw new Error("The DeFlock camera adapter is not registered.");
    this.deflockAdapter.selectViewportRegion(viewport);
    if (options.refresh && this.running) {
      const result = await this.registry.refresh(DEFLOCK_ALPR_SOURCE_ID);
      await this.registry.dropRawPayloads(DEFLOCK_ALPR_SOURCE_ID);
      return this.snapshot([result]);
    }
    return this.snapshot();
  }

  async setDeflockRegion(regionId: string) {
    if (!this.deflockAdapter) throw new Error("The DeFlock camera adapter is not registered.");
    this.deflockAdapter.selectRegion(regionId);
    if (!this.running) return this.snapshot();
    const result = await this.registry.refresh(DEFLOCK_ALPR_SOURCE_ID);
    await this.registry.dropRawPayloads(DEFLOCK_ALPR_SOURCE_ID);
    return this.snapshot([result]);
  }

  async applySourceSettings(settings: Record<string, { enabled?: boolean; pollCadenceMs?: number; requestBudgetPercent?: number }> = {}) {
    const legacyEonetSettings = NASA_EONET_CLASSES.map((eventClass) => settings[eventClass.legacySourceId]).filter(Boolean);
    const combinedEonetSettings = settings[NASA_EONET_SOURCE_ID] ?? (legacyEonetSettings.length ? {
      enabled: legacyEonetSettings.some((source) => source.enabled === true),
      pollCadenceMs: legacyEonetSettings.map((source) => source.pollCadenceMs).filter((value): value is number => typeof value === "number").sort((left, right) => left - right)[0],
      requestBudgetPercent: legacyEonetSettings.map((source) => source.requestBudgetPercent).filter((value): value is number => typeof value === "number").sort((left, right) => right - left)[0],
    } : undefined);
    for (const [sourceId, sourceSettings] of Object.entries(settings)) {
      if (sourceId.startsWith("nasa.eonet.")) continue;
      if (!this.registry.list().some(({ id }) => id === sourceId)) continue;
      await this.configureSource(sourceId, sourceSettings);
    }
    if (combinedEonetSettings) await this.configureSource(NASA_EONET_SOURCE_ID, combinedEonetSettings);
    return this.snapshot();
  }

  async querySource(input: HunterSourceQueryInput, options: { signal?: AbortSignal; bypassCache?: boolean } = {}) {
    const result = await this.queryRegistry.query(input, options);
    this.queryInputs.set(input.sourceId, structuredClone(input));
    this.queryResults.set(input.sourceId, result);
    const publicObservations = result.observations.map(removeRawPayload);
    for (const listener of this.observationListeners) {
      try { listener(input.sourceId, publicObservations); } catch { /* query publication must not be interrupted by persistence subscribers */ }
    }
    return { result: { ...result, observations: publicObservations }, snapshot: await this.snapshot() };
  }

  clearSourceQuery(sourceId: string) {
    if (!this.queryRegistry.has(sourceId)) throw new Error(`${sourceId} does not have an installed source-query adapter.`);
    this.queryInputs.delete(sourceId);
    return this.queryResults.delete(sourceId);
  }

  async stop() {
    this.registry.stop();
    this.running = false;
    await this.registry.clearObservations();
    this.queryInputs.clear();
    this.queryResults.clear();
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
    const sourceQueries = [...this.queryResults.entries()].map(([sourceId, result]) => ({
      sourceId,
      queriedAt: result.queriedAt,
      cache: result.cache,
      observationCount: result.observations.length,
      observationIds: result.observations.map((observation) => observation.observationId),
      references: result.references,
      ...(result.coverageLimitation ? { coverageLimitation: result.coverageLimitation } : {}),
    }));
    const queryObservations = [...this.queryResults.values()].flatMap((result) => result.observations.map(removeRawPayload));
    const mergedObservations = [...queryObservations, ...publicObservations]
      .filter((observation, index, all) => all.findIndex((candidate) => candidate.observationId === observation.observationId) === index)
      .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));
    return {
      running: this.running,
      generatedAt: new Date().toISOString(),
      retention: "memory-only",
      sources,
      observationCount: mergedObservations.length,
      observations: mergedObservations.slice(0, MAX_PUBLIC_OBSERVATIONS),
      sourceQueryCapabilities: this.queryRegistry.list(),
      sourceQueries,
      mapOverlays: [...this.queryResults.entries()].flatMap(([sourceId, result]) => (result.overlays ?? []).map((overlay) => ({ ...overlay, sourceId }))),
      ...(refreshResults ? { refreshResults } : {}),
    };
  }
}

export const hunterSeekerService = new HunterSeekerService();
