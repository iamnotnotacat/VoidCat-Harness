import type { HunterSeekerObservation } from "./hunter-seeker-map-data";

export type HunterFreshnessState = "live" | "cached" | "stale" | "degraded" | "acquiring" | "offline";

export type HunterFreshnessSource = {
  descriptor: {
    id: string;
    pollCadenceMs: number;
    cache?: { ttlMs: number };
  };
  health: {
    status: string;
    enabled: boolean;
    pollCadenceMs: number;
    lastSuccessAt?: string;
    consecutiveFailures?: number;
    consecutiveBelowExpected?: number;
    cachedObservations: number;
  };
};

const MINIMUM_FALLBACK_TTL_MS = 5 * 60_000;
const TRACK_STALE_WINDOWS: Array<[RegExp, number]> = [
  [/space-station|satellite/i, 7 * 24 * 60 * 60_000],
  [/vessel|maritime/i, 30 * 60_000],
  [/aircraft/i, 25 * 60_000],
];

function ageSince(value: string | undefined, nowMs: number) {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? Math.max(0, nowMs - timestamp) : Number.POSITIVE_INFINITY;
}

export function sourceCacheTtlMs(source: HunterFreshnessSource) {
  return Math.max(
    source.descriptor.cache?.ttlMs ?? 0,
    source.health.pollCadenceMs * 2,
    MINIMUM_FALLBACK_TTL_MS,
  );
}

export function sourceFreshnessState(source: HunterFreshnessSource, nowMs: number): HunterFreshnessState {
  if (!source.health.enabled) return "offline";
  if (source.health.status === "down" || source.health.status === "degraded") return "degraded";
  if (!source.health.lastSuccessAt) return "acquiring";

  const ageMs = ageSince(source.health.lastSuccessAt, nowMs);
  if (ageMs > sourceCacheTtlMs(source)) return "stale";
  if (source.health.status === "rate-limited" || source.health.status === "idle" || source.health.status === "stopped" || ageMs > source.health.pollCadenceMs) return "cached";
  return "live";
}

export function observationFreshnessState(observation: HunterSeekerObservation, source: HunterFreshnessSource | undefined, nowMs: number): HunterFreshnessState {
  if (!source) return "degraded";
  const sourceState = sourceFreshnessState(source, nowMs);
  if (sourceState === "offline" || sourceState === "degraded" || sourceState === "acquiring" || sourceState === "stale") return sourceState;

  const fetchedAgeMs = ageSince(observation.provenance.fetchedAt, nowMs);
  if (fetchedAgeMs > sourceCacheTtlMs(source)) return "stale";

  const trackStaleWindow = TRACK_STALE_WINDOWS.find(([pattern]) => pattern.test(observation.entityType))?.[1];
  if (trackStaleWindow !== undefined && observation.provenance.stalenessMs > trackStaleWindow) return "stale";
  if (sourceState === "cached" || fetchedAgeMs > source.health.pollCadenceMs || (trackStaleWindow !== undefined && observation.provenance.stalenessMs > source.health.pollCadenceMs)) return "cached";
  return "live";
}

export function freshnessLabel(state: HunterFreshnessState) {
  return state.toUpperCase();
}
