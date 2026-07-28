import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNotifications } from "./NotificationCenter";
import type { HunterSeekerObservation as PublicObservation } from "./hunter-seeker-map-data";
import { freshnessLabel, observationFreshnessState, sourceFreshnessState, type HunterFreshnessState } from "./hunter-seeker-freshness";
import { HunterSeekerCredentialModal } from "./HunterSeekerCredentialModal";
import { HunterSeekerSetupGuide } from "./HunterSeekerSetupGuide";
import { MARITIME_REGIONS } from "./maritime-regions";
import { OverflowMarquee } from "./OverflowMarquee";
import type { VoidCatSettings } from "./WebPanel";

type SourceSnapshot = {
  descriptor: {
    id: string;
    displayName: string;
    category: string;
    authTier: string;
    pollCadenceMs: number;
    providerDocsUrl: string;
    rateLimit?: { requestsPerWindow: number; windowMs: number; hardHourlyBudget: number };
    cache?: { ttlMs: number; maxObservations?: number };
  };
  health: {
    status: string;
    enabled: boolean;
    pollCadenceMs: number;
    requestBudgetPercent?: number;
    effectiveRateLimit?: { requestsPerWindow: number; windowMs: number; hardHourlyBudget: number };
    message?: string;
    lastAttemptAt?: string;
    lastSuccessAt?: string;
    nextAllowedAt?: string;
    nextScheduledAt?: string;
    consecutiveFailures?: number;
    consecutiveBelowExpected?: number;
    cachedObservations: number;
    hourlyRequests: number;
    creditBudget?: {
      remainingCredits?: number;
      requestCostCredits: number;
      reserveCredits: number;
      effectiveRefreshMs: number;
      estimatedRefillAt: string;
      nextNetworkAt: string;
      basis: "rolling-24-hour-estimate" | "provider-retry-after" | "safe-fallback";
    };
  };
};

type HunterSeekerSnapshot = {
  running: boolean;
  generatedAt: string;
  retention: "memory-only" | "live-and-history";
  history?: { enabled: boolean; initialized: boolean; observationCount: number; summaryCount: number; derivedCount: number; vectorCount: number; oldestAt: string | null; newestAt: string | null; lastWriteAt: string | null; databaseBytes: number; walBytes: number; error?: string | null };
  sources: SourceSnapshot[];
  observationCount: number;
  observations: PublicObservation[];
  refreshResults?: Array<{ status: string; reason?: string; observations: number; error?: string }>;
};

type HunterManagedJob = {
  id: string;
  name: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "timed-out" | "limit-exceeded";
  progress: { current: number; total?: number; message?: string };
  caps: { maxIterations: number; timeoutMs: number; maxExternalCalls: number };
  resources: { iterations: number; externalCalls: number; units: number; wallClockMs: number };
  cleanupPending: boolean;
  errorCode?: string;
};

const NWS_SOURCE_ID = "noaa.nws-alerts";
const ADSB_LOL_MILITARY_SOURCE_ID = "adsb.lol.military";
const OPENSKY_CIVIL_AIRCRAFT_SOURCE_ID = "opensky.civil-airspace";
const CELESTRAK_STATIONS_SOURCE_ID = "celestrak.space-stations";
const AISSTREAM_MARITIME_SOURCE_ID = "aisstream.maritime";
const AISSTREAM_CREDENTIAL_NAMESPACE = "vc-hunter-seeker.aisstream";
const AISSTREAM_CREDENTIAL_KEY = "websocket-token";
const SOURCE_PULL_RATES = [30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000, 2 * 60 * 60_000, 4 * 60 * 60_000, 6 * 60 * 60_000, 12 * 60 * 60_000] as const;
const HunterSeekerMap = lazy(() => import("./HunterSeekerMap").then((module) => ({ default: module.HunterSeekerMap })));

function numberAttribute(observation: PublicObservation, key: string) {
  const value = observation.attributes[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textAttribute(observation: PublicObservation, key: string) {
  const value = observation.attributes[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function formatTime(value?: string) {
  if (!value) return "NO SYNC";
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "UNKNOWN";
}

function formatCoordinates(observation: PublicObservation) {
  const latitude = Math.abs(observation.position.latitude).toFixed(2);
  const longitude = Math.abs(observation.position.longitude).toFixed(2);
  return `${latitude}°${observation.position.latitude >= 0 ? "N" : "S"}  ${longitude}°${observation.position.longitude >= 0 ? "E" : "W"}`;
}

function formatDuration(milliseconds: number) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "UNKNOWN";
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "< 1 MIN";
  if (minutes < 60) return `${minutes} MIN`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} HR ${minutes % 60} MIN` : `${Math.floor(hours / 24)} DAY ${hours % 24} HR`;
}

function formatRelativeTime(value: string | undefined, nowMs: number, emptyLabel: string) {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp)) return emptyLabel;
  const delta = timestamp - nowMs;
  if (Math.abs(delta) < 60_000) return delta > 0 ? "< 1 MIN" : "NOW";
  return delta > 0 ? `IN ${formatDuration(delta)}` : `${formatDuration(-delta)} AGO`;
}

function effectiveNextPull(source: SourceSnapshot) {
  const candidates = [source.health.nextScheduledAt, source.health.nextAllowedAt]
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  return candidates.length ? new Date(Math.max(...candidates)).toISOString() : undefined;
}

function observationTitle(observation: PublicObservation) {
  return textAttribute(observation, "title")
    ?? textAttribute(observation, "event")
    ?? textAttribute(observation, "headline")
    ?? textAttribute(observation, "place")
    ?? textAttribute(observation, "areaDescription")
    ?? "UNLOCATED EVENT";
}

function contactBadge(observation: PublicObservation) {
  if (observation.entityType.includes("aircraft")) {
    const aircraftType = textAttribute(observation, "aircraftType")?.toUpperCase();
    if (aircraftType) return aircraftType;
    if (observation.provenance.sourceFeedId === ADSB_LOL_MILITARY_SOURCE_ID) return "MIL";
    const category = textAttribute(observation, "aircraftCategory");
    if (category === "heavy-aircraft") return "HEAVY";
    if (category === "large-aircraft" || category === "high-vortex-large-aircraft") return "LARGE";
    if (category === "rotorcraft") return "ROTOR";
    return "CIV";
  }
  if (observation.entityType.includes("vessel") || observation.entityType.includes("maritime")) return "VESSEL";
  if (observation.provenance.sourceFeedId === CELESTRAK_STATIONS_SOURCE_ID || observation.entityType.includes("space-station")) return "ORBIT";
  const magnitude = numberAttribute(observation, "magnitude");
  if (magnitude !== null) return `M ${magnitude.toFixed(1)}`;
  return textAttribute(observation, "severity")?.toUpperCase() ?? "WEATHER";
}

function sourceLabel(observation: PublicObservation) {
  if (observation.provenance.sourceFeedId === ADSB_LOL_MILITARY_SOURCE_ID) return "ADSB.LOL MIL AIR";
  if (observation.provenance.sourceFeedId === OPENSKY_CIVIL_AIRCRAFT_SOURCE_ID) return "OPENSKY CIV AIR";
  if (observation.entityType.includes("aircraft")) return "CIVILIAN AIR";
  if (observation.provenance.sourceFeedId === CELESTRAK_STATIONS_SOURCE_ID) return "CELESTRAK ORBIT";
  if (observation.provenance.sourceFeedId === AISSTREAM_MARITIME_SOURCE_ID) return "AISSTREAM MARITIME";
  if (observation.provenance.sourceFeedId === NWS_SOURCE_ID) return "NWS ALERT";
  return "USGS SEISMIC";
}

function aircraftAltitude(observation: PublicObservation) {
  const altitude = numberAttribute(observation, "geometricAltitudeFeet") ?? numberAttribute(observation, "barometricAltitudeFeet");
  return altitude === null ? "UNKNOWN" : altitude === 0 ? "GROUND" : `${Math.round(altitude).toLocaleString()} FT`;
}

function aircraftSummary(observation: PublicObservation) {
  const speed = numberAttribute(observation, "groundspeedKnots");
  const track = numberAttribute(observation, "trackDegrees");
  const emergency = textAttribute(observation, "emergency");
  const parts = [
    textAttribute(observation, "registration") && `REG ${textAttribute(observation, "registration")}`,
    textAttribute(observation, "transponderHex") && `ICAO ${textAttribute(observation, "transponderHex")}`,
    textAttribute(observation, "originCountry") && `ORIGIN ${textAttribute(observation, "originCountry")}`,
    textAttribute(observation, "aircraftCategory") && `CATEGORY ${textAttribute(observation, "aircraftCategory")?.replaceAll("-", " ").toUpperCase()}`,
    speed !== null && `SPEED ${speed.toFixed(1)} KT`,
    track !== null && `TRACK ${track.toFixed(1)} DEG`,
    textAttribute(observation, "squawk") && `SQUAWK ${textAttribute(observation, "squawk")}`,
    emergency && emergency !== "none" && `EMERGENCY ${emergency.toUpperCase()}`,
  ].filter((value): value is string => Boolean(value));
  return parts.join("  //  ") || "No additional broadcast fields are available for this contact.";
}

function stationSummary(observation: PublicObservation) {
  const altitudeMeters = observation.position.altitudeMeters;
  const velocity = numberAttribute(observation, "velocityKilometersPerSecond");
  const period = numberAttribute(observation, "orbitalPeriodMinutes");
  const inclination = numberAttribute(observation, "inclinationDegrees");
  const parts = [
    textAttribute(observation, "noradCatalogId") && `NORAD ${textAttribute(observation, "noradCatalogId")}`,
    textAttribute(observation, "internationalDesignator") && `INTDES ${textAttribute(observation, "internationalDesignator")}`,
    Number.isFinite(altitudeMeters) && `ALT ${Math.round(altitudeMeters! / 1_000).toLocaleString()} KM`,
    velocity !== null && `VELOCITY ${velocity.toFixed(2)} KM/S`,
    period !== null && `PERIOD ${period.toFixed(1)} MIN`,
    inclination !== null && `INCLINATION ${inclination.toFixed(2)} DEG`,
  ].filter((value): value is string => Boolean(value));
  return parts.join("  //  ") || "No additional orbital fields are available for this contact.";
}

function vesselSummary(observation: PublicObservation) {
  const speed = numberAttribute(observation, "speedOverGroundKnots");
  const course = numberAttribute(observation, "courseOverGroundDegrees");
  return [
    textAttribute(observation, "mmsi") && `MMSI ${textAttribute(observation, "mmsi")}`,
    speed !== null && `SPEED ${speed.toFixed(1)} KT`,
    course !== null && `COURSE ${course.toFixed(1)} DEG`,
    textAttribute(observation, "coverageRegion") && `REGION ${textAttribute(observation, "coverageRegion")?.toUpperCase()}`,
    textAttribute(observation, "messageType") && `AIS ${textAttribute(observation, "messageType")}`,
  ].filter((value): value is string => Boolean(value)).join("  //  ") || "No additional AIS fields are available for this vessel.";
}

function freshnessRank(status: HunterFreshnessState) {
  return ({ degraded: 6, stale: 5, cached: 4, acquiring: 3, offline: 2, live: 0 } as Record<HunterFreshnessState, number>)[status];
}

function formatPullRate(milliseconds: number) {
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 1_000)} SEC`;
  if (milliseconds < 60 * 60_000) return `${Math.round(milliseconds / 60_000)} MIN`;
  const hours = milliseconds / (60 * 60_000);
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} HR`;
}

function pullRateIndex(milliseconds: number) {
  return SOURCE_PULL_RATES.reduce((best, value, index) => (
    Math.abs(value - milliseconds) < Math.abs(SOURCE_PULL_RATES[best] - milliseconds) ? index : best
  ), 0);
}

function sourceCode(category: string) {
  if (category === "seismic") return "EQ";
  if (category === "weather") return "WX";
  return category.slice(0, 2).toUpperCase();
}

type HistorySearchResult = { id: string; type: "history"; title: string; content: string; score: number; windowStart: string; windowEnd: string; sourceObservationIds: string[]; sourceFeedIds: string[] };
type HistoryDocumentResult = { id: string; type: "document"; documentName: string; content: string; score: number; citation: string };

export function HunterSeekerPanel({ settings, ragFolders = [], onSaveSettings }: {
  settings: VoidCatSettings;
  ragFolders?: Array<{ id: string; name: string; enabled: boolean }>;
  onSaveSettings: (settings: Partial<VoidCatSettings>) => Promise<void>;
}) {
  const { notify } = useNotifications();
  const [snapshot, setSnapshot] = useState<HunterSeekerSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rateDrafts, setRateDrafts] = useState<Record<string, number>>({});
  const [budgetDrafts, setBudgetDrafts] = useState<Record<string, number>>({});
  const committedRates = useRef<Record<string, number>>({});
  const [busySources, setBusySources] = useState<string[]>([]);
  const [action, setAction] = useState<"starting" | "refreshing" | "stopping" | null>("starting");
  const [error, setError] = useState<string | null>(null);
  const [maritimeSnapshot, setMaritimeSnapshot] = useState<(MaritimeDesktopSnapshot & { nextDisplayAt?: string }) | null>(null);
  const [maritimeCredentialSaved, setMaritimeCredentialSaved] = useState<boolean | null>(null);
  const [maritimeCredentialFingerprint, setMaritimeCredentialFingerprint] = useState<string | null>(null);
  const [showMaritimeSetup, setShowMaritimeSetup] = useState(false);
  const [maritimeRegionDraft, setMaritimeRegionDraft] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(!settings.hunterSetupCompleted);
  const [setupStep, setSetupStep] = useState(settings.hunterSetupStep);
  const [resumeSetupAfterMaritime, setResumeSetupAfterMaritime] = useState(false);
  const [managedJobs, setManagedJobs] = useState<HunterManagedJob[]>([]);
  const [historyQuestion, setHistoryQuestion] = useState("");
  const [historyResults, setHistoryResults] = useState<Array<HistorySearchResult | HistoryDocumentResult>>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyMaintenance, setHistoryMaintenance] = useState("");
  const nextMaritimeDisplayAt = useRef(0);
  const maritimeWarmupPasses = useRef(0);

  const loadSnapshot = useCallback(async (path = "/api/hunter-seeker/status", method: "GET" | "POST" = "GET") => {
    const response = await fetch(path, { method, cache: "no-store" });
    const data = await response.json() as HunterSeekerSnapshot & { error?: string };
    if (!response.ok) throw new Error(data.error ?? "Hunter-Seeker local service did not respond.");
    setSnapshot(data);
    const serverRates = Object.fromEntries(data.sources.map((source) => [source.descriptor.id, source.health.pollCadenceMs]));
    committedRates.current = serverRates;
    setRateDrafts(serverRates);
    setBudgetDrafts(Object.fromEntries(data.sources.map((source) => [source.descriptor.id, source.health.requestBudgetPercent ?? 100])));
    setSelectedId((current) => current?.startsWith("aisstream-vessel:") || current && data.observations.some((observation) => observation.observationId === current)
      ? current
      : data.observations[0]?.observationId ?? null);
    return data;
  }, []);

  useEffect(() => {
    let active = true;
    const startTimer = window.setTimeout(() => {
      void loadSnapshot("/api/hunter-seeker/start", "POST")
        .then((data) => {
          if (!active) return;
          const failed = data.refreshResults?.find((result) => result.status === "failed");
          if (failed) setError(failed.error ?? "The source refresh failed.");
        })
        .catch((startError) => {
          if (!active) return;
          const message = startError instanceof Error ? startError.message : "Hunter-Seeker failed to start.";
          setError(message);
          notify({ tone: "error", title: "Hunter-Seeker link failed", message });
        })
        .finally(() => { if (active) setAction(null); });
    }, 0);
    const timer = window.setInterval(() => {
      void loadSnapshot().catch(() => { /* the visible health state remains available */ });
    }, 30_000);
    return () => { active = false; window.clearTimeout(startTimer); window.clearInterval(timer); };
  }, [loadSnapshot, notify]);

  const loadManagedJobs = useCallback(async () => {
    const response = await fetch("/api/hunter-seeker/jobs", { cache: "no-store" });
    const data = await response.json() as { jobs?: HunterManagedJob[]; error?: string };
    if (!response.ok) throw new Error(data.error ?? "Managed job status is unavailable.");
    setManagedJobs(data.jobs ?? []);
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = () => void loadManagedJobs().catch(() => { if (active) setManagedJobs([]); });
    refresh();
    const events = typeof EventSource === "undefined" ? null : new EventSource("/api/hunter-seeker/jobs/events");
    if (events) events.onmessage = refresh;
    const timer = window.setInterval(refresh, 5_000);
    return () => { active = false; events?.close(); window.clearInterval(timer); };
  }, [loadManagedJobs]);

  useEffect(() => {
    const desktop = window.voidcatDesktop;
    if (!desktop?.credentials || !desktop.maritime || desktop.bridgeVersion < 2) return;
    let active = true;
    const refreshMaritime = async () => {
      const [maritime, keys, description] = await Promise.all([desktop.maritime.snapshot(), desktop.credentials.list(AISSTREAM_CREDENTIAL_NAMESPACE), desktop.credentials.describe(AISSTREAM_CREDENTIAL_NAMESPACE, AISSTREAM_CREDENTIAL_KEY)]);
      if (!active) return;
      setMaritimeSnapshot((current) => {
        const now = Date.now();
        const regionChanged = current?.regionIds[0] !== maritime.regionIds[0];
        if (!current && maritime.enabled && maritimeWarmupPasses.current === 0) maritimeWarmupPasses.current = 15;
        const warmingUp = maritime.enabled && maritimeWarmupPasses.current > 0;
        const publishObservations = !current || regionChanged || !maritime.enabled || warmingUp || now >= nextMaritimeDisplayAt.current;
        if (publishObservations) {
          if (warmingUp) maritimeWarmupPasses.current -= 1;
          nextMaritimeDisplayAt.current = now + maritime.displayCadenceMs;
          return { ...maritime, nextDisplayAt: new Date(nextMaritimeDisplayAt.current).toISOString() };
        }
        return { ...maritime, observations: current.observations, nextDisplayAt: current.nextDisplayAt };
      });
      setMaritimeCredentialSaved(keys.includes(AISSTREAM_CREDENTIAL_KEY));
      setMaritimeCredentialFingerprint(description.fingerprint);
    };
    void refreshMaritime().catch(() => { /* source card exposes desktop availability */ });
    const maritimeTimer = window.setInterval(() => { void refreshMaritime().catch(() => { /* keep last known state */ }); }, 2_000);
    return () => { active = false; window.clearInterval(maritimeTimer); };
  }, []);

  const maritimeSource = useMemo<SourceSnapshot>(() => ({
    descriptor: { id: AISSTREAM_MARITIME_SOURCE_ID, displayName: "aisstream.io Maritime", category: "maritime", authTier: "tier-2", pollCadenceMs: maritimeSnapshot?.displayCadenceMs ?? 2 * 60_000, providerDocsUrl: "https://aisstream.io/documentation.html", cache: { ttlMs: 30 * 60_000 } },
    health: {
      status: maritimeSnapshot?.status ?? (window.voidcatDesktop ? "disabled" : "down"),
      enabled: maritimeSnapshot?.enabled ?? false,
      pollCadenceMs: maritimeSnapshot?.displayCadenceMs ?? 2 * 60_000,
      message: maritimeSnapshot?.message ?? (window.voidcatDesktop ? "Credentialed maritime stream is off." : "Maritime streaming requires the VoidCat desktop app."),
      lastSuccessAt: maritimeSnapshot?.lastMessageAt ?? undefined,
      nextScheduledAt: maritimeSnapshot?.enabled ? maritimeSnapshot.nextDisplayAt : undefined,
      consecutiveFailures: maritimeSnapshot?.status === "down" ? 1 : 0,
      consecutiveBelowExpected: 0,
      cachedObservations: maritimeSnapshot?.observations.length ?? 0,
      hourlyRequests: 0,
    },
  }), [maritimeSnapshot]);
  const sources = useMemo(() => [...(snapshot?.sources ?? []), maritimeSource], [snapshot?.sources, maritimeSource]);

  const activeSourceKey = sources.filter((source) => source.health.enabled).map((source) => source.descriptor.id).sort().join("|");
  const activeSourceIds = useMemo(() => activeSourceKey ? activeSourceKey.split("|") : [], [activeSourceKey]);
  const observations = useMemo(() => {
    const enabled = new Set(activeSourceKey ? activeSourceKey.split("|") : []);
    return [...(snapshot?.observations ?? []), ...(maritimeSnapshot?.observations ?? [])].filter((observation) => enabled.has(observation.provenance.sourceFeedId));
  }, [snapshot?.observations, maritimeSnapshot?.observations, activeSourceKey]);
  const mapObservations = useMemo(() => observations.slice(0, 1_500), [observations]);
  const visibleSources = useMemo(() => sources.filter((source) => activeSourceIds.includes(source.descriptor.id)), [sources, activeSourceIds]);
  const generatedAtCandidates = [snapshot?.generatedAt, maritimeSnapshot?.lastMessageAt]
    .map((value) => Date.parse(value ?? ""))
    .filter(Number.isFinite);
  const generatedAtMs = generatedAtCandidates.length ? Math.max(...generatedAtCandidates) : 0;
  const sourceById = new Map(sources.map((source) => [source.descriptor.id, source]));
  const sourceFreshnessById = Object.fromEntries(sources.map((source) => [source.descriptor.id, sourceFreshnessState(source, generatedAtMs)])) as Record<string, HunterFreshnessState>;
  const observationFreshnessById = Object.fromEntries(observations.map((observation) => [observation.observationId, observationFreshnessState(observation, sourceById.get(observation.provenance.sourceFeedId), generatedAtMs)])) as Record<string, HunterFreshnessState>;
  const mapFreshnessSignature = mapObservations.map((observation) => `${encodeURIComponent(observation.observationId)}=${observationFreshnessById[observation.observationId] ?? "degraded"}`).join("&");
  const aggregateFreshness = visibleSources.map((source) => sourceFreshnessById[source.descriptor.id] ?? "degraded").sort((left, right) => freshnessRank(right) - freshnessRank(left))[0] ?? "offline";
  const lastSuccessAt = visibleSources.map((source) => source.health.lastSuccessAt).filter((value): value is string => Boolean(value)).sort().at(-1);
  const selected = observations.find((observation) => observation.observationId === selectedId) ?? observations[0] ?? null;
  const largestMagnitude = useMemo(() => observations.reduce<number | null>((largest, observation) => {
    const magnitude = numberAttribute(observation, "magnitude");
    return magnitude === null ? largest : Math.max(largest ?? magnitude, magnitude);
  }, null), [observations]);

  async function configureSource(sourceId: string, update: { enabled?: boolean; pollCadenceMs?: number; requestBudgetPercent?: number }) {
    if (sourceId === AISSTREAM_MARITIME_SOURCE_ID) {
      if (!window.voidcatDesktop?.credentials || !window.voidcatDesktop.maritime || window.voidcatDesktop.bridgeVersion < 2) {
        notify({ tone: "warning", title: "Restart required", message: "Close VoidCat Harness completely and reopen it once to activate the new protected credential bridge." });
        return;
      }
      if (update.pollCadenceMs !== undefined) {
        if (typeof window.voidcatDesktop.maritime.setDisplayCadence !== "function") {
          notify({ tone: "warning", title: "Restart required", message: "Close VoidCat Harness completely and reopen it once to activate the maritime pull-rate control." });
          return;
        }
        const previousCadence = committedRates.current[sourceId] ?? maritimeSnapshot?.displayCadenceMs ?? 2 * 60_000;
        committedRates.current[sourceId] = update.pollCadenceMs;
        setBusySources((current) => [...new Set([...current, sourceId])]);
        try {
          const result = await window.voidcatDesktop.maritime.setDisplayCadence(update.pollCadenceMs);
          committedRates.current[sourceId] = result.displayCadenceMs;
          setRateDrafts((current) => ({ ...current, [sourceId]: result.displayCadenceMs }));
          nextMaritimeDisplayAt.current = 0;
          setMaritimeSnapshot((current) => current ? { ...current, displayCadenceMs: result.displayCadenceMs } : current);
          notify({ tone: "success", title: "Maritime pull rate saved", message: `Map contacts will update every ${formatPullRate(result.displayCadenceMs)} while the protected AIS stream remains connected.` });
        } catch (sourceError) {
          committedRates.current[sourceId] = previousCadence;
          setRateDrafts((current) => ({ ...current, [sourceId]: previousCadence }));
          notify({ tone: "error", title: "Pull rate change failed", message: sourceError instanceof Error ? sourceError.message : "The maritime pull rate could not be changed." });
        } finally {
          setBusySources((current) => current.filter((id) => id !== sourceId));
        }
        return;
      }
      if (update.enabled) {
        const keys = maritimeCredentialSaved === true ? [AISSTREAM_CREDENTIAL_KEY] : await window.voidcatDesktop.credentials.list(AISSTREAM_CREDENTIAL_NAMESPACE);
        const credentialExists = keys.includes(AISSTREAM_CREDENTIAL_KEY);
        setMaritimeCredentialSaved(credentialExists);
        if (!credentialExists || maritimeSnapshot?.status === "down") { setShowMaritimeSetup(true); return; }
      }
      setBusySources((current) => [...new Set([...current, sourceId])]);
      try {
        if (!update.enabled && typeof window.voidcatDesktop.maritime.disable !== "function") {
          notify({ tone: "warning", title: "Restart required", message: "Close VoidCat Harness completely and reopen it once to activate source snapshot restoration." });
          return;
        }
        const maritime = update.enabled ? await window.voidcatDesktop.maritime.start(maritimeSnapshot?.regionIds) : await window.voidcatDesktop.maritime.disable();
        nextMaritimeDisplayAt.current = 0;
        maritimeWarmupPasses.current = update.enabled ? 15 : 0;
        setMaritimeSnapshot(maritime);
        notify({ tone: "success", title: update.enabled ? "Maritime source online" : "Maritime source offline", message: maritime.message });
      } catch (sourceError) {
        notify({ tone: "error", title: "Maritime link failed", message: sourceError instanceof Error ? sourceError.message : "The maritime source could not be changed." });
      } finally { setBusySources((current) => current.filter((id) => id !== sourceId)); }
      return;
    }
    const previousCommittedRate = committedRates.current[sourceId];
    if (update.pollCadenceMs !== undefined) committedRates.current[sourceId] = update.pollCadenceMs;
    setBusySources((current) => current.includes(sourceId) ? current : [...current, sourceId]);
    setError(null);
    try {
      const response = await fetch(`/api/hunter-seeker/sources/${encodeURIComponent(sourceId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });
      const data = await response.json() as HunterSeekerSnapshot & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "The source control did not respond.");
      setSnapshot(data);
      const serverRates = Object.fromEntries(data.sources.map((source) => [source.descriptor.id, source.health.pollCadenceMs]));
      committedRates.current = serverRates;
      setRateDrafts(serverRates);
      setBudgetDrafts(Object.fromEntries(data.sources.map((source) => [source.descriptor.id, source.health.requestBudgetPercent ?? 100])));
      setSelectedId((current) => current && data.observations.some((observation) => observation.observationId === current)
        ? current
        : data.observations[0]?.observationId ?? null);
      const configured = data.sources.find((source) => source.descriptor.id === sourceId);
      notify({
        tone: "success",
        title: update.enabled === false ? "Source offline" : update.enabled === true ? "Source online" : update.requestBudgetPercent !== undefined ? "Request budget updated" : "Pull rate updated",
        message: update.requestBudgetPercent !== undefined
          ? `${configured?.descriptor.displayName ?? sourceId} is limited to ${update.requestBudgetPercent}% of the fixed provider ceiling.`
          : update.pollCadenceMs !== undefined
          ? `${configured?.descriptor.displayName ?? sourceId} will pull every ${formatPullRate(update.pollCadenceMs).toLowerCase()}.`
          : `${configured?.descriptor.displayName ?? sourceId} is ${configured?.health.enabled ? "enabled" : "disabled"}.`,
      });
    } catch (sourceError) {
      const message = sourceError instanceof Error ? sourceError.message : "Source configuration failed.";
      setError(message);
      if (previousCommittedRate !== undefined) {
        committedRates.current[sourceId] = previousCommittedRate;
        setRateDrafts((current) => ({ ...current, [sourceId]: previousCommittedRate }));
      }
      notify({ tone: "error", title: "Source control failed", message });
    } finally {
      setBusySources((current) => current.filter((id) => id !== sourceId));
    }
  }

  async function selectMaritimeRegion(regionId: string) {
    if (!window.voidcatDesktop?.credentials || !window.voidcatDesktop.maritime || window.voidcatDesktop.bridgeVersion < 2) {
      notify({ tone: "warning", title: "Restart required", message: "Close VoidCat Harness completely and reopen it once to activate the protected maritime bridge." });
      return;
    }
    if (maritimeCredentialSaved !== true) {
      setMaritimeRegionDraft(regionId);
      setShowMaritimeSetup(true);
      return;
    }
    setBusySources((current) => [...new Set([...current, AISSTREAM_MARITIME_SOURCE_ID])]);
    try {
      const maritime = await window.voidcatDesktop.maritime.start([regionId]);
      nextMaritimeDisplayAt.current = 0;
      maritimeWarmupPasses.current = 15;
      setMaritimeSnapshot(maritime);
      notify({ tone: "success", title: "Maritime region changed", message: `${maritime.regionLabel} is now the only active maritime region.` });
    } catch (sourceError) {
      notify({ tone: "error", title: "Region change failed", message: sourceError instanceof Error ? sourceError.message : "The maritime region could not be changed." });
    } finally {
      setBusySources((current) => current.filter((id) => id !== AISSTREAM_MARITIME_SOURCE_ID));
    }
  }

  function commitPullRate(sourceId: string, pollCadenceMs: number) {
    if (committedRates.current[sourceId] === pollCadenceMs) return;
    void configureSource(sourceId, { pollCadenceMs });
  }

  async function runAction(kind: "refresh" | "stop") {
    setAction(kind === "refresh" ? "refreshing" : "stopping");
    setError(null);
    try {
      if (kind === "stop" && window.voidcatDesktop) setMaritimeSnapshot(await window.voidcatDesktop.maritime.stop());
      const data = await loadSnapshot(`/api/hunter-seeker/${kind}`, "POST");
      const failed = data.refreshResults?.find((result) => result.status === "failed");
      const skipped = data.refreshResults?.find((result) => result.status === "skipped");
      if (failed) throw new Error(failed.error ?? "The source refresh failed.");
      notify({
        tone: "success",
        title: kind === "stop" ? "Hunter-Seeker stopped" : "Situation board refreshed",
        message: kind === "stop"
          ? "Live observations were cleared from volatile memory."
          : `${data.observations.length} live observations available.${skipped ? " Disabled or provider-protected sources kept their latest cached snapshot." : ""}`,
      });
    } catch (actionError) {
      const message = actionError instanceof Error ? actionError.message : "Hunter-Seeker operation failed.";
      setError(message);
      notify({ tone: "error", title: "Hunter-Seeker operation failed", message });
    } finally { setAction(null); }
  }

  async function startAfterStop() {
    setAction("starting");
    setError(null);
    try {
      const data = await loadSnapshot("/api/hunter-seeker/start", "POST");
      const failed = data.refreshResults?.find((result) => result.status === "failed");
      if (failed) throw new Error(failed.error ?? "The source refresh failed.");
      notify({ tone: "success", title: "Hunter-Seeker linked", message: `${data.observations.length} live observations available.` });
    } catch (startError) {
      const message = startError instanceof Error ? startError.message : "Hunter-Seeker failed to start.";
      setError(message);
    } finally { setAction(null); }
  }

  async function cancelManagedJob(jobId: string) {
    try {
      const response = await fetch(`/api/hunter-seeker/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "The managed job could not be cancelled.");
      await loadManagedJobs();
      notify({ tone: "success", title: "Analysis job cancelled", message: "The job was stopped and its execution slot will remain guarded until cleanup finishes." });
    } catch (cancelError) {
      notify({ tone: "error", title: "Cancellation failed", message: cancelError instanceof Error ? cancelError.message : "The managed job could not be cancelled." });
    }
  }

  async function saveHistorySettings(patch: Partial<VoidCatSettings["hunterHistory"]>) {
    setHistoryBusy(true);
    try {
      const response = await fetch("/api/hunter-seeker/history/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      const data = await response.json() as { settings?: VoidCatSettings["hunterHistory"]; error?: string };
      if (!response.ok || !data.settings) throw new Error(data.error ?? "Historical settings were not saved.");
      await onSaveSettings({ hunterHistory: data.settings });
      await loadSnapshot();
      notify({ tone: "success", title: data.settings.enabled ? "Historical recording armed" : "Historical recording paused", message: data.settings.enabled ? "New observations will be written to the isolated, budget-governed history store." : "Live feeds continue, but no new historical observations will be written." });
    } catch (historyError) { notify({ tone: "error", title: "History setting failed", message: historyError instanceof Error ? historyError.message : "Historical settings were not saved." }); }
    finally { setHistoryBusy(false); }
  }

  async function askHistory() {
    if (!historyQuestion.trim() || historyBusy) return;
    setHistoryBusy(true);
    try {
      const response = await fetch("/api/hunter-seeker/history/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: historyQuestion }) });
      const data = await response.json() as { historical?: HistorySearchResult[]; documents?: HistoryDocumentResult[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Historical search failed.");
      setHistoryResults([...(data.historical ?? []), ...(data.documents ?? [])]);
    } catch (historyError) { notify({ tone: "error", title: "Historical search failed", message: historyError instanceof Error ? historyError.message : "Historical search failed." }); }
    finally { setHistoryBusy(false); }
  }

  async function planHistoryMaintenance(run = false) {
    if (historyBusy) return;
    setHistoryBusy(true);
    try {
      if (!run) {
        const response = await fetch("/api/hunter-seeker/history/maintenance/plan", { cache: "no-store" });
        const data = await response.json() as { estimatedRecordsRemoved?: number; protectedRecords?: number; error?: string };
        if (!response.ok) throw new Error(data.error ?? "Maintenance preview failed.");
        setHistoryMaintenance(`DRY PLAN // ${data.estimatedRecordsRemoved ?? 0} BULK CANDIDATES // ${data.protectedRecords ?? 0} PROTECTED`);
      } else {
        if (!window.confirm("Run one bounded, backup-first history downsampling pass? Pinned, watchlist, trigger, derived, summary, chat, and RAG-library records are protected.")) return;
        const response = await fetch("/api/hunter-seeker/history/maintenance", { method: "POST" });
        const data = await response.json() as { deleted?: number; summaries?: number; error?: string };
        if (!response.ok) throw new Error(data.error ?? "Maintenance pass failed.");
        setHistoryMaintenance(`COMPLETE // ${data.deleted ?? 0} BULK REMOVED // ${data.summaries ?? 0} SUMMARIES`);
        await loadSnapshot();
      }
    } catch (maintenanceError) { notify({ tone: "error", title: "History maintenance failed", message: maintenanceError instanceof Error ? maintenanceError.message : "History maintenance failed." }); }
    finally { setHistoryBusy(false); }
  }

  return <section className="phase-panel hunter-panel">
    <div className="phase-heading hunter-heading">
      <div><p className="kicker">VC HUNTER-SEEKER {"//"} LIVE GEOSPATIAL INTELLIGENCE</p><h2>SITUATION BOARD</h2></div>
      <div className="hunter-summary">
        <article className={`hunter-stat freshness-${aggregateFreshness}`}><span>FEED STATUS</span><strong>{action === "starting" ? "LINKING" : freshnessLabel(aggregateFreshness)}</strong><small><OverflowMarquee text={`${visibleSources.filter((source) => sourceFreshnessById[source.descriptor.id] === "live").length} / ${visibleSources.length} SOURCES LIVE`} /></small></article>
        <article className="hunter-stat"><span>VISIBLE SIGNALS</span><strong>{observations.length.toLocaleString()}</strong><small><OverflowMarquee text={`${((snapshot?.observationCount ?? 0) + (maritimeSnapshot?.observations.length ?? 0)).toLocaleString()} VOLATILE CONTACTS`} /></small></article>
        <article className="hunter-stat"><span>PEAK MAGNITUDE</span><strong>{largestMagnitude === null ? "—" : largestMagnitude.toFixed(1)}</strong><small><OverflowMarquee text="PAST-DAY FEED MAX" /></small></article>
        <article className="hunter-stat status-memory"><span>RETENTION</span><strong>{snapshot?.history?.enabled ? "HISTORY ON" : "MEMORY ONLY"}</strong><small><OverflowMarquee text={snapshot?.history?.enabled ? `${snapshot.history.observationCount.toLocaleString()} HISTORICAL // LIVE DISTINCT` : "LIVE CACHE CLEARS ON EXIT"} /></small></article>
      </div>
      <div className="hunter-actions">
        <button className="local-only-action" onClick={() => { setSetupStep(0); setShowSetup(true); }}>SETTINGS / SETUP</button>
        {snapshot?.running
          ? <><button className="cancel-action" disabled={Boolean(action)} onClick={() => void runAction("stop")}>DISCONNECT</button><button className="primary-action" disabled={Boolean(action)} onClick={() => void runAction("refresh")}>{action === "refreshing" ? "REFRESHING..." : "REFRESH NOW"}</button></>
          : <button className="primary-action" disabled={Boolean(action)} onClick={() => void startAfterStop()}>{action === "starting" ? "LINKING..." : "LINK LIVE FEED"}</button>}
      </div>
    </div>

    {error && <div className="hunter-error"><strong>SOURCE LINK DEGRADED</strong><span>{error}</span></div>}

    {managedJobs.length > 0 && <section className="hunter-job-monitor" aria-label="Hunter-Seeker managed analysis jobs">
      <header><div><span>BOUNDED ANALYSIS</span><strong>MANAGED JOBS</strong></div><small>{managedJobs.filter((job) => job.status === "queued" || job.status === "running").length} ACTIVE</small></header>
      <div>{managedJobs.slice(0, 4).map((job) => {
        const active = job.status === "queued" || job.status === "running";
        const progress = job.progress.total ? Math.min(100, Math.round(job.progress.current / job.progress.total * 100)) : job.status === "completed" ? 100 : 0;
        return <article className={`hunter-job hunter-job-${job.status}`} key={job.id}>
          <span>{job.status.toUpperCase()}</span>
          <div><strong>{job.name.replaceAll("-", " ").toUpperCase()}</strong><small><OverflowMarquee text={`${job.progress.message ?? "AWAITING STATUS"} // ITER ${job.resources.iterations}/${job.caps.maxIterations} // CALLS ${job.resources.externalCalls}/${job.caps.maxExternalCalls} // ${formatDuration(job.resources.wallClockMs)}${job.cleanupPending ? " // CLEANUP GUARDED" : ""}`} /></small><i style={{ "--hunter-job-progress": `${progress}%` } as React.CSSProperties} /></div>
          {active ? <button onClick={() => void cancelManagedJob(job.id)}>CANCEL</button> : <b>{job.errorCode ?? (job.status === "completed" ? "COMPLETE" : "STOPPED")}</b>}
        </article>;
      })}</div>
    </section>}

    <section className={`hunter-history-console ${snapshot?.history?.enabled ? "active" : ""}`} aria-label="Historical observations and historical RAG">
      <header><div><span>CONTROLLED PERSISTENCE</span><strong>HISTORY / WHAT CHANGED?</strong></div><b>{snapshot?.history?.enabled ? "HISTORICAL ON" : "OPT-IN OFF"}</b></header>
      <div className="hunter-history-controls">
        <button className={snapshot?.history?.enabled ? "cancel-action" : "primary-action"} disabled={historyBusy} onClick={() => void saveHistorySettings({ enabled: !settings.hunterHistory.enabled })}>{snapshot?.history?.enabled ? "PAUSE RECORDING" : "ENABLE RECORDING"}</button>
        <label>RETENTION<select disabled={!snapshot?.history?.enabled || historyBusy} value={settings.hunterHistory.retentionDays} onChange={(event) => void saveHistorySettings({ retentionDays: Number(event.target.value) })}>{[30, 60, 90, 180, 365].map((days) => <option key={days} value={days}>{days} DAYS</option>)}</select></label>
        <label className="hunter-history-query">HISTORICAL QUESTION<input disabled={!snapshot?.history?.initialized || historyBusy} value={historyQuestion} onChange={(event) => setHistoryQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void askHistory(); }} placeholder="What changed in the Gulf today?" /></label>
        <button className="local-only-action" disabled={!snapshot?.history?.initialized || historyBusy || !historyQuestion.trim()} onClick={() => void askHistory()}>{historyBusy ? "WORKING..." : "QUERY HISTORY"}</button>
      </div>
      <div className="hunter-history-libraries"><span>CROSS-REFERENCE LIBRARIES</span>{ragFolders.filter((folder) => folder.enabled).map((folder) => <label key={folder.id}><input type="checkbox" checked={settings.hunterHistory.selectedLibraryIds.includes(folder.id)} onChange={(event) => void saveHistorySettings({ selectedLibraryIds: event.target.checked ? [...settings.hunterHistory.selectedLibraryIds, folder.id] : settings.hunterHistory.selectedLibraryIds.filter((id) => id !== folder.id) })} />{folder.name}</label>)}<label><input type="checkbox" checked={settings.hunterHistory.includeUploads} onChange={(event) => void saveHistorySettings({ includeUploads: event.target.checked })} />UPLOADED FILES</label></div>
      <div className="hunter-history-status"><span>LIVE data is volatile</span><span>HISTORICAL data is opt-in</span><span>{(((snapshot?.history?.databaseBytes ?? 0) + (snapshot?.history?.walBytes ?? 0)) / 1024 ** 2).toFixed(1)} MiB</span><span>{snapshot?.history?.summaryCount ?? 0} summaries / {snapshot?.history?.derivedCount ?? 0} derived</span>{historyMaintenance && <b>{historyMaintenance}</b>}<button disabled={!snapshot?.history?.initialized || historyBusy} onClick={() => void planHistoryMaintenance(false)}>DRY PLAN</button><button disabled={!snapshot?.history?.initialized || historyBusy} onClick={() => void planHistoryMaintenance(true)}>DOWNSAMPLE</button>{snapshot?.history?.error && <em>{snapshot.history.error}</em>}</div>
      {historyResults.length > 0 && <div className="hunter-history-results">{historyResults.map((result) => <article key={`${result.type}:${result.id}`}><b>{result.type === "history" ? "HISTORICAL" : "LIBRARY"}</b><strong>{result.type === "history" ? result.title : result.documentName}</strong><p>{result.content}</p><small>{result.type === "history" ? `${result.windowStart} — ${result.windowEnd} // OBS ${result.sourceObservationIds.slice(0, 3).join(", ")}` : result.citation} // SCORE {result.score.toFixed(3)}</small></article>)}</div>}
    </section>

    <div className="hunter-board">
    <section className="hunter-layer-bar" aria-label="Hunter-Seeker source controls">
      <header><div><span>SOURCE CONTROL</span><strong>LIVE SOURCE MATRIX</strong></div><small>{activeSourceIds.length} / {sources.length} ONLINE</small></header>
      <div className="hunter-source-list">{sources.map((source) => {
        const enabled = source.health.enabled;
        const busy = busySources.includes(source.descriptor.id);
        const pullRate = rateDrafts[source.descriptor.id] ?? source.health.pollCadenceMs ?? source.descriptor.pollCadenceMs;
        const rateIndex = pullRateIndex(pullRate);
        const selectRate = (index: number) => SOURCE_PULL_RATES[Math.max(0, Math.min(SOURCE_PULL_RATES.length - 1, index))];
        const sourceFreshness = sourceFreshnessById[source.descriptor.id] ?? "degraded";
        return <article className={`hunter-source-card ${enabled ? "active" : ""} freshness-${sourceFreshness} layer-${source.descriptor.category} ${source.descriptor.id === ADSB_LOL_MILITARY_SOURCE_ID ? "source-military-aircraft" : source.descriptor.id === OPENSKY_CIVIL_AIRCRAFT_SOURCE_ID ? "source-civilian-aircraft" : ""}`} key={source.descriptor.id}>
          <button aria-pressed={enabled} className={`hunter-source-toggle ${enabled ? "active" : ""}`} disabled={busy} onClick={() => void configureSource(source.descriptor.id, { enabled: !enabled })}>
            <i>{sourceCode(source.descriptor.category)}</i><span><strong><OverflowMarquee text={source.descriptor.displayName} /></strong><small><OverflowMarquee text={`${source.health.cachedObservations.toLocaleString()} CONTACTS // ${freshnessLabel(sourceFreshness)} // LAST ${formatRelativeTime(source.health.lastSuccessAt, generatedAtMs, "NEVER")} // NEXT ${formatRelativeTime(effectiveNextPull(source), generatedAtMs, "UNSCHEDULED")}`} /></small></span><b>{busy ? "WAIT" : enabled ? "ON" : "OFF"}</b>
          </button>
          <label className="hunter-pull-rate">
            <span>PULL RATE <strong>EVERY {formatPullRate(pullRate)}</strong></span>
            <input
              aria-label={`${source.descriptor.displayName} pull rate`}
              disabled={!enabled || busy}
              max={SOURCE_PULL_RATES.length - 1}
              min={0}
              onBlur={(event) => commitPullRate(source.descriptor.id, selectRate(Number(event.currentTarget.value)))}
              onChange={(event) => {
                const selectedRate = selectRate(Number(event.currentTarget.value));
                setRateDrafts((current) => ({ ...current, [source.descriptor.id]: selectedRate }));
              }}
              onKeyUp={(event) => commitPullRate(source.descriptor.id, selectRate(Number(event.currentTarget.value)))}
              onPointerUp={(event) => commitPullRate(source.descriptor.id, selectRate(Number(event.currentTarget.value)))}
              step={1}
              type="range"
              value={rateIndex}
            />
            <small><span>30 SEC</span><span>12 HR</span></small>
          </label>
          {source.descriptor.rateLimit && source.health.effectiveRateLimit && <label className="hunter-pull-rate hunter-request-budget">
            <span>LOCAL REQUEST BUDGET <strong>{budgetDrafts[source.descriptor.id] ?? source.health.requestBudgetPercent ?? 100}%</strong></span>
            <input
              aria-label={`${source.descriptor.displayName} local request budget`}
              disabled={!enabled || busy}
              min={10}
              max={100}
              step={10}
              type="range"
              value={budgetDrafts[source.descriptor.id] ?? source.health.requestBudgetPercent ?? 100}
              onChange={(event) => setBudgetDrafts((current) => ({ ...current, [source.descriptor.id]: Number(event.currentTarget.value) }))}
              onPointerUp={(event) => void configureSource(source.descriptor.id, { requestBudgetPercent: Number(event.currentTarget.value) })}
              onKeyUp={(event) => void configureSource(source.descriptor.id, { requestBudgetPercent: Number(event.currentTarget.value) })}
            />
            <small><span>LOCAL {source.health.effectiveRateLimit.requestsPerWindow}/{formatPullRate(source.health.effectiveRateLimit.windowMs)} // {source.health.effectiveRateLimit.hardHourlyBudget}/HR</span><span>PROVIDER {source.descriptor.rateLimit.requestsPerWindow}/{formatPullRate(source.descriptor.rateLimit.windowMs)} // {source.descriptor.rateLimit.hardHourlyBudget}/HR</span></small>
          </label>}
          {source.descriptor.id === AISSTREAM_MARITIME_SOURCE_ID && <div className="hunter-stream-status">
            <span>SECURE LIVE STREAM</span>
            <strong><OverflowMarquee text={maritimeCredentialSaved === null ? "CHECKING CREDENTIAL" : maritimeCredentialSaved ? `${maritimeSnapshot?.regionLabel ?? "REGION READY"} // CREDENTIAL SAVED` : "CREDENTIAL REQUIRED"} /></strong>
            <select aria-label="Maritime coverage region" className="hunter-stream-region-select" disabled={!enabled || busy || maritimeCredentialSaved !== true} onChange={(event) => void selectMaritimeRegion(event.currentTarget.value)} value={maritimeSnapshot?.regionIds[0] ?? "gulf-of-mexico"}>
              {MARITIME_REGIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <small><OverflowMarquee text={`${source.health.message ?? "NO SOURCE STATUS"} // PROVIDER STREAM SAFETY CAP 1,200 MSG/MIN // LOCAL DISPLAY ${formatPullRate(pullRate)}`} /></small>
          </div>}
          {source.health.creditBudget && <div className="hunter-credit-guard" title="OpenSky does not publish the daily reset boundary on successful anonymous responses, so VoidCat uses a conservative rolling 24-hour estimate. An exact provider retry-after value overrides the estimate.">
            <span>CREDIT GUARD</span>
            <strong>{source.health.creditBudget.remainingCredits?.toLocaleString() ?? "UNREPORTED"} CR // NET {formatPullRate(source.health.creditBudget.effectiveRefreshMs)}</strong>
            <small>REFILL ~{formatDuration(Math.max(0, Date.parse(source.health.creditBudget.estimatedRefillAt) - Date.parse(snapshot?.generatedAt ?? "")))} // NEXT {formatTime(source.health.creditBudget.nextNetworkAt)}</small>
          </div>}
        </article>;
      })}</div>
    </section>

    <div className="hunter-workspace">
      <section className="hunter-map-shell">
        <header><div><span>GLOBAL PROJECTION {"//"} WGS84</span><strong>LIVE CONTACT MAP</strong></div><nav className="hunter-freshness-legend" aria-label="Contact freshness legend"><span className="freshness-live">LIVE</span><span className="freshness-cached">CACHED</span><span className="freshness-stale">STALE</span><span className="freshness-degraded">DEGRADED</span></nav><small>{snapshot?.running ? "LIVE LINK" : "LINK CLOSED"}</small></header>
        <div className="hunter-map" aria-label={`Interactive world map showing ${observations.length} live events`}>
          <Suspense fallback={<div className="hunter-map-empty"><span>INITIALIZING MAP</span><small>Loading the isolated geospatial renderer.</small></div>}><HunterSeekerMap observations={mapObservations} freshnessSignature={mapFreshnessSignature} selectedId={selected?.observationId ?? null} onSelect={setSelectedId} /></Suspense>
          {!observations.length && <div className="hunter-map-empty"><span>{action === "starting" ? "ACQUIRING SIGNAL" : "NO LIVE CONTACTS"}</span><small>{snapshot?.running ? "Waiting for the source feed." : "Link the feed to begin."}</small></div>}
        </div>
          <footer><span>DISPLAYING {Math.min(observations.length, 1_500).toLocaleString()} / {observations.length.toLocaleString()} VISIBLE CONTACTS</span><span aria-label="Map attribution" className="hunter-map-credit"><a href="https://openfreemap.org/" target="_blank" rel="noreferrer">OPENFREEMAP</a> © <a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">OPENMAPTILES</a> DATA FROM <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OPENSTREETMAP</a></span><span>LAST SYNC {formatTime(lastSuccessAt)}</span></footer>
      </section>

      <section className="hunter-event-deck">
        <header><div><span>CONTACT REGISTER</span><strong>RECENT EVENTS</strong></div><small>{visibleSources.map((source) => source.descriptor.category.toUpperCase()).join(" + ") || "NO LAYERS"}</small></header>
        <div className="hunter-event-list">
          {observations.slice(0, 250).map((observation, index) => {
            const isWeather = observation.provenance.sourceFeedId === NWS_SOURCE_ID;
            const isAviation = observation.entityType.includes("aircraft");
            const isMilitaryAviation = observation.provenance.sourceFeedId === ADSB_LOL_MILITARY_SOURCE_ID;
            const isSpace = observation.provenance.sourceFeedId === CELESTRAK_STATIONS_SOURCE_ID;
            const isMaritime = observation.provenance.sourceFeedId === AISSTREAM_MARITIME_SOURCE_ID;
            const freshness = observationFreshnessById[observation.observationId] ?? "degraded";
            return <button className={`${observation.observationId === selected?.observationId ? "selected" : ""} freshness-${freshness}`} key={observation.observationId} onClick={() => setSelectedId(observation.observationId)}>
              <span>{String(index + 1).padStart(3, "0")}</span><b className={isWeather ? "weather-badge" : isMilitaryAviation ? "military-aircraft-badge" : isAviation ? "civilian-aircraft-badge" : isSpace ? "space-station-badge" : isMaritime ? "maritime-vessel-badge" : ""}>{contactBadge(observation)}</b><div><strong>{observationTitle(observation)}</strong><small>{sourceLabel(observation)} {"//"} {formatCoordinates(observation)} {"//"} {formatTime(observation.timestamp)}</small></div><em className={`hunter-freshness-badge freshness-${freshness}`}>{freshnessLabel(freshness)}</em>
            </button>;
          })}
          {!observations.length && <div className="hunter-list-empty">CONTACT REGISTER EMPTY</div>}
        </div>
      </section>
    </div>

    {selected && (() => {
      const isWeather = selected.provenance.sourceFeedId === NWS_SOURCE_ID;
      const isAviation = selected.entityType.includes("aircraft");
      const isMilitaryAviation = selected.provenance.sourceFeedId === ADSB_LOL_MILITARY_SOURCE_ID;
      const isOpenSkyAviation = selected.provenance.sourceFeedId === OPENSKY_CIVIL_AIRCRAFT_SOURCE_ID;
      const isSpace = selected.provenance.sourceFeedId === CELESTRAK_STATIONS_SOURCE_ID;
      const isMaritime = selected.provenance.sourceFeedId === AISSTREAM_MARITIME_SOURCE_ID;
      const selectedFreshness = observationFreshnessById[selected.observationId] ?? "degraded";
      const selectedKind = isWeather ? "weather" : isMilitaryAviation ? "military-aviation" : isAviation ? "civilian-aviation" : isSpace ? "space" : isMaritime ? "maritime" : "seismic";
      const sourceType = (textAttribute(selected, "sourceType") ?? "broadcast").replaceAll("_", " ");
      return <article className={`hunter-contact-detail contact-${selectedKind}`}>
        <header><div><span>SELECTED CONTACT {"//"} {selected.entityId}</span><strong>{observationTitle(selected)}</strong></div><b>{contactBadge(selected)}</b></header>
        <dl><div><dt>{isWeather ? "PROVIDER CENTROID" : isSpace ? "SUBPOINT" : "POSITION"}</dt><dd>{formatCoordinates(selected)}</dd></div><div><dt>{isWeather ? "EXPIRES" : isAviation || isSpace ? "ALTITUDE" : isMaritime ? "SPEED" : "DEPTH"}</dt><dd>{isWeather ? formatTime(textAttribute(selected, "expiresAt") ?? undefined) : isAviation ? aircraftAltitude(selected) : isSpace ? `${Math.round((selected.position.altitudeMeters ?? 0) / 1_000).toLocaleString()} KM` : isMaritime ? `${numberAttribute(selected, "speedOverGroundKnots")?.toFixed(1) ?? "—"} KT` : `${numberAttribute(selected, "depthKm")?.toFixed(1) ?? "—"} KM`}</dd></div><div><dt>{isWeather ? "EFFECTIVE" : isAviation || isMaritime ? "LAST POSITION" : isSpace ? "PROPAGATED" : "DETECTED"}</dt><dd>{formatTime(selected.timestamp)}</dd></div><div><dt>{isWeather ? "CERTAINTY" : isAviation ? "POSITION SOURCE" : isSpace ? "ORBIT MODEL" : isMaritime ? "AIS COURSE" : "CONFIDENCE"}</dt><dd>{isMaritime ? `${numberAttribute(selected, "courseOverGroundDegrees")?.toFixed(1) ?? "—"} DEG` : isSpace ? `${Math.round(selected.confidence * 100)}% SGP4` : `${Math.round(selected.confidence * 100)}% ${(isAviation ? sourceType : textAttribute(selected, isWeather ? "certainty" : "reviewStatus") ?? (isWeather ? "unknown" : "unreviewed")).toUpperCase()}`}</dd></div><div><dt>{isSpace ? "ELEMENT SET AGE" : "STALENESS AT RECEIPT"}</dt><dd>{formatDuration(selected.provenance.stalenessMs)}</dd></div></dl>
        <div className="hunter-detail-freshness"><span>FRESHNESS</span><strong className={`hunter-freshness-badge freshness-${selectedFreshness}`}>{freshnessLabel(selectedFreshness)}</strong><small>{formatRelativeTime(selected.provenance.fetchedAt, generatedAtMs, "UNKNOWN")}</small></div>
        {isWeather && textAttribute(selected, "description") && <p className="hunter-alert-description">{textAttribute(selected, "description")}</p>}
        {isAviation && <p className="hunter-alert-description hunter-aircraft-description">{aircraftSummary(selected)}</p>}
        {isSpace && <p className="hunter-alert-description hunter-space-description">{stationSummary(selected)}</p>}
        {isMaritime && <p className="hunter-alert-description hunter-maritime-description">{vesselSummary(selected)}</p>}
        <footer><span>SOURCE: {isWeather ? "NOAA / NATIONAL WEATHER SERVICE" : isOpenSkyAviation ? "OPENSKY NETWORK" : isAviation ? "ADSB.LOL" : isSpace ? "CELESTRAK" : isMaritime ? "AISSTREAM.IO" : "U.S. GEOLOGICAL SURVEY"}</span>{textAttribute(selected, "eventUrl") && <a href={textAttribute(selected, "eventUrl")!} target="_blank" rel="noreferrer">OPEN {isWeather ? "NWS ALERT" : isAviation ? "AIRCRAFT" : isSpace ? "ORBIT DATA" : isMaritime ? "AIS COVERAGE" : "USGS EVENT"} ↗</a>}</footer>
      </article>;
    })()}
    </div>
    {showSetup && <HunterSeekerSetupGuide
      step={setupStep}
      maritimeCredentialSaved={maritimeCredentialSaved}
      maritimeCredentialFingerprint={maritimeCredentialFingerprint}
      activePublicSources={sources.filter((source) => source.descriptor.id !== AISSTREAM_MARITIME_SOURCE_ID && source.health.enabled).length}
      skippedPublicSources={sources.filter((source) => source.descriptor.id !== AISSTREAM_MARITIME_SOURCE_ID && !source.health.enabled).length}
      onClose={() => setShowSetup(false)}
      onSkip={async () => {
        await onSaveSettings({ hunterSetupCompleted: true, hunterSetupStep: setupStep });
        setShowSetup(false);
      }}
      onStep={async (nextStep) => {
        setSetupStep(nextStep);
        await onSaveSettings({ hunterSetupStep: nextStep });
      }}
      onComplete={async () => {
        setSetupStep(4);
        await onSaveSettings({ hunterSetupCompleted: true, hunterSetupStep: 4 });
        setShowSetup(false);
      }}
      onConfigureMaritime={() => {
        setResumeSetupAfterMaritime(true);
        setShowSetup(false);
        setShowMaritimeSetup(true);
      }}
      onRetestMaritime={async () => {
        try {
          if (!window.voidcatDesktop?.maritime) throw new Error("Protected maritime service is unavailable.");
          const result = await window.voidcatDesktop.maritime.testSavedCredential(maritimeSnapshot?.regionIds);
          notify({ tone: "success", title: "Credential verified", message: `aisstream.io accepted the saved key for ${result.regionIds.length} selected region.` });
        } catch (credentialError) {
          notify({ tone: "error", title: "Credential test failed", message: credentialError instanceof Error ? credentialError.message : "aisstream.io did not accept the saved key." });
        }
      }}
      onRemoveMaritime={async () => {
        if (!window.voidcatDesktop?.credentials || !window.voidcatDesktop.maritime) throw new Error("Protected credential storage is unavailable.");
        if (!window.confirm("Remove the saved aisstream.io credential and disconnect the maritime source?")) return;
        await window.voidcatDesktop.maritime.disable();
        await window.voidcatDesktop.credentials.delete(AISSTREAM_CREDENTIAL_NAMESPACE, AISSTREAM_CREDENTIAL_KEY);
        setMaritimeCredentialSaved(false);
        setMaritimeCredentialFingerprint(null);
        setMaritimeSnapshot(await window.voidcatDesktop.maritime.snapshot());
        notify({ tone: "success", title: "Maritime credential removed", message: "The protected AIS key was deleted and the source was disconnected." });
      }}
    />}
    {showMaritimeSetup && <HunterSeekerCredentialModal
      credentialRequired={maritimeCredentialSaved !== true}
      initialRegionId={maritimeRegionDraft ?? maritimeSnapshot?.regionIds[0] ?? "gulf-of-mexico"}
      onCancel={() => { setMaritimeRegionDraft(null); setShowMaritimeSetup(false); if (resumeSetupAfterMaritime) { setResumeSetupAfterMaritime(false); setShowSetup(true); } }}
      onSubmit={async (credential, regionId) => {
      if (!window.voidcatDesktop?.credentials || !window.voidcatDesktop.maritime || window.voidcatDesktop.bridgeVersion < 2) {
        throw new Error("Close VoidCat Harness completely and reopen it once to activate protected credential storage, then submit the key again.");
      }
      if (credential) {
        await window.voidcatDesktop.maritime.testCredential(credential, [regionId]);
        await window.voidcatDesktop.credentials.set(AISSTREAM_CREDENTIAL_NAMESPACE, AISSTREAM_CREDENTIAL_KEY, credential);
      }
      else if (maritimeCredentialSaved !== true) throw new Error("Enter the API key issued by aisstream.io.");
      const maritime = await window.voidcatDesktop.maritime.start([regionId]);
      setMaritimeCredentialSaved(true);
      const description = await window.voidcatDesktop.credentials.describe(AISSTREAM_CREDENTIAL_NAMESPACE, AISSTREAM_CREDENTIAL_KEY);
      setMaritimeCredentialFingerprint(description.fingerprint);
      nextMaritimeDisplayAt.current = 0;
      maritimeWarmupPasses.current = 15;
      setMaritimeSnapshot(maritime);
      setMaritimeRegionDraft(null);
       setShowMaritimeSetup(false);
       if (resumeSetupAfterMaritime) { setResumeSetupAfterMaritime(false); setShowSetup(true); }
      notify({
        tone: "success",
        title: credential ? "Maritime credential secured" : "Maritime areas updated",
        message: `The ${maritime.regionLabel} vessel stream is connecting. ${credential ? "The credential will be reused on future launches." : "The area selection was saved."}`,
      });
    }}
    />}
  </section>;
}
