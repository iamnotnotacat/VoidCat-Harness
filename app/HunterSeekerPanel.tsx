/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNotifications } from "./NotificationCenter";
import type { HunterSeekerObservation as PublicObservation } from "./hunter-seeker-map-data";
import { freshnessLabel, observationFreshnessState, sourceFreshnessState, type HunterFreshnessState } from "./hunter-seeker-freshness";
import { HunterSeekerCredentialModal } from "./HunterSeekerCredentialModal";
import { HunterSourceQueryModal, type HunterQueryCapability } from "./HunterSourceQueryModal";
import type { HunterMapOverlay, HunterMapViewport } from "./HunterSeekerMap";
import { HunterSeekerSetupGuide } from "./HunterSeekerSetupGuide";
import { HunterStageFivePanel } from "./HunterStageFivePanel";
import { OverflowMarquee } from "./OverflowMarquee";
import { PublicWebcamCredentialModal } from "./PublicWebcamCredentialModal";
import { WindyWebcamCredentialModal } from "./WindyWebcamCredentialModal";
import { HunterDynamicLegend, HunterLayerControl } from "./HunterLayerControl";
import { HunterSourceExplorer, type HunterExplorerSourceState } from "./HunterSourceExplorer";
import { HunterSourceSettingsDialog } from "./HunterSourceSettingsDialog";
import {
  applyHunterPreset,
  mergeHunterSourceDefinitions,
  migrateHunterWorkspaceSettings,
  type HunterSavedView,
  type HunterSeekerSourceDefinition,
} from "../build/hunter-seeker/source-workspace";
import type { HunterOsintCandidate, HunterOsintDraft } from "./osint-hunter-types";
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
    metrics?: { errorRate: number; recordsPerHour: number; expectedBaseline: number; silentZero: boolean; aiContextEligible: boolean; sampleCount: number };
  };
};

type HunterSeekerSnapshot = {
  running: boolean;
  generatedAt: string;
  retention: "memory-only" | "live-and-history";
  history?: { enabled: boolean; initialized: boolean; observationCount: number; summaryCount: number; derivedCount: number; vectorCount: number; oldestAt: string | null; newestAt: string | null; lastWriteAt: string | null; databaseBytes: number; walBytes: number; error?: string | null };
  stageFive?: { watchlistCount: number; enabledWatchlistCount: number; unacknowledgedTriggerCount: number; activeReplay: { id: string; recordCount: number; endsAt: string } | null };
  sources: SourceSnapshot[];
  observationCount: number;
  observations: PublicObservation[];
  sourceQueryCapabilities?: HunterQueryCapability[];
  sourceQueries?: Array<{ sourceId: string; queriedAt: string; cache: { status: "live" | "cached"; ageMs: number; expiresAt: string }; observationCount: number; observationIds: string[]; references?: Array<{ id: string; title: string; url: string; description?: string; publishedAt?: string; license: string }>; coverageLimitation?: string }>;
  mapOverlays?: HunterMapOverlay[];
  refreshResults?: Array<{ status: string; reason?: string; observations: number; error?: string }>;
};

type HunterSourceCatalogEntry = {
  id: string; name: string; description: string; providerUrl?: string; documentationUrl: string; mode: string; auth: string; mapCapable: boolean;
  temporal: string; license: string; limitation: string; adapterInstalled?: boolean; runtimeStatus: "integrated" | "adapter-required" | "credential-setup-required";
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
const DEFLOCK_ALPR_SOURCE_ID = "deflock.osm-alpr";
const PUBLIC_WEBCAM_SOURCE_ID = "youtube.live-webcams";
const WINDY_WEBCAM_SOURCE_ID = "windy.public-webcams";
const AISSTREAM_CREDENTIAL_NAMESPACE = "vc-hunter-seeker.aisstream";
const AISSTREAM_CREDENTIAL_KEY = "websocket-token";
const HunterSeekerMap = lazy(() => import("./HunterSeekerMap").then((module) => ({ default: module.HunterSeekerMap })));

function isWebcamSource(sourceId: string) { return sourceId === PUBLIC_WEBCAM_SOURCE_ID || sourceId === WINDY_WEBCAM_SOURCE_ID; }

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

function observationTitle(observation: PublicObservation) {
  return textAttribute(observation, "title")
    ?? textAttribute(observation, "event")
    ?? textAttribute(observation, "headline")
    ?? textAttribute(observation, "place")
    ?? textAttribute(observation, "areaDescription")
    ?? "UNLOCATED EVENT";
}

function contactBadge(observation: PublicObservation) {
  if (observation.provenance.sourceFeedId === DEFLOCK_ALPR_SOURCE_ID || observation.entityType.includes("alpr-camera")) return "ALPR";
  if (observation.provenance.sourceFeedId === PUBLIC_WEBCAM_SOURCE_ID || observation.entityType.includes("public-webcam")) return "CAM";
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
  if (observation.entityType.startsWith("natural-event.")) return observation.entityType.slice("natural-event.".length).replace(/-.*/, "").slice(0, 8).toUpperCase();
  if (observation.provenance.sourceFeedId === CELESTRAK_STATIONS_SOURCE_ID || observation.entityType.includes("space-station")) return "ORBIT";
  const magnitude = numberAttribute(observation, "magnitude");
  if (magnitude !== null) return `M ${magnitude.toFixed(1)}`;
  return textAttribute(observation, "severity")?.toUpperCase() ?? "WEATHER";
}

function sourceLabel(observation: PublicObservation) {
  if (observation.provenance.sourceFeedId === DEFLOCK_ALPR_SOURCE_ID) return "DEFLOCK CAMERA";
  if (observation.provenance.sourceFeedId === PUBLIC_WEBCAM_SOURCE_ID) return "YOUTUBE LIVE CAM";
  if (observation.provenance.sourceFeedId === WINDY_WEBCAM_SOURCE_ID) return "WINDY WEBCAM";
  if (observation.provenance.sourceFeedId === ADSB_LOL_MILITARY_SOURCE_ID) return "ADSB.LOL MIL AIR";
  if (observation.provenance.sourceFeedId === OPENSKY_CIVIL_AIRCRAFT_SOURCE_ID) return "OPENSKY CIV AIR";
  if (observation.entityType.includes("aircraft")) return "CIVILIAN AIR";
  if (observation.provenance.sourceFeedId === CELESTRAK_STATIONS_SOURCE_ID) return "CELESTRAK ORBIT";
  if (observation.provenance.sourceFeedId === AISSTREAM_MARITIME_SOURCE_ID) return "AISSTREAM MARITIME";
  if (observation.provenance.sourceFeedId === NWS_SOURCE_ID) return "NWS ALERT";
  if (observation.provenance.sourceFeedId.startsWith("nasa.eonet.")) return "NASA EONET";
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

function cameraSummary(observation: PublicObservation) {
  return [
    textAttribute(observation, "manufacturer") && `MAKE ${textAttribute(observation, "manufacturer")?.toUpperCase()}`,
    textAttribute(observation, "direction") && textAttribute(observation, "direction") !== "unknown" && `FACING ${textAttribute(observation, "direction")?.toUpperCase()}`,
    textAttribute(observation, "operator") && textAttribute(observation, "operator") !== "unknown" && `OPERATOR ${textAttribute(observation, "operator")?.toUpperCase()}`,
    textAttribute(observation, "surveillanceZone") && textAttribute(observation, "surveillanceZone") !== "unknown" && `ZONE ${textAttribute(observation, "surveillanceZone")?.toUpperCase()}`,
  ].filter((value): value is string => Boolean(value)).join("  //  ") || "Crowdsourced ALPR location; make, direction, and operator are not recorded for this camera.";
}

function publicWebcamPlayerUrl(observation: PublicObservation | null) {
  if (!observation || ![PUBLIC_WEBCAM_SOURCE_ID, WINDY_WEBCAM_SOURCE_ID].includes(observation.provenance.sourceFeedId)) return "";
  const value = textAttribute(observation, "playerUrl");
  if (!value) return "";
  try {
    const url = new URL(value);
    if (observation.provenance.sourceFeedId === PUBLIC_WEBCAM_SOURCE_ID) return url.protocol === "https:" && url.hostname === "www.youtube-nocookie.com" && /^\/embed\/[A-Za-z0-9_-]{11}$/.test(url.pathname) ? url.toString() : "";
    return url.protocol === "https:" && (url.hostname === "windy.com" || url.hostname.endsWith(".windy.com")) ? url.toString() : "";
  }
  catch { return ""; }
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

type HistorySearchResult = { id: string; type: "history"; title: string; content: string; score: number; windowStart: string; windowEnd: string; sourceObservationIds: string[]; sourceFeedIds: string[] };
type HistoryDocumentResult = { id: string; type: "document"; documentName: string; content: string; score: number; citation: string };

export function HunterSeekerPanel({ settings, settingsReady = true, setupRequested = false, ragFolders = [], onSaveSettings, onSetupRequestHandled, onAnalyzeObservation, onInvestigateOsint }: {
  settings: VoidCatSettings;
  settingsReady?: boolean;
  setupRequested?: boolean;
  ragFolders?: Array<{ id: string; name: string; enabled: boolean }>;
  onSaveSettings: (settings: Partial<VoidCatSettings>) => Promise<void>;
  onSetupRequestHandled?: () => void;
  onAnalyzeObservation?: (prompt: string) => void;
  onInvestigateOsint?: (draft: HunterOsintDraft) => void;
}) {
  const { notify } = useNotifications();
  const [snapshot, setSnapshot] = useState<HunterSeekerSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const committedRates = useRef<Record<string, number>>({});
  const [busySources, setBusySources] = useState<string[]>([]);
  const [action, setAction] = useState<"starting" | "refreshing" | "stopping" | null>("starting");
  const [error, setError] = useState<string | null>(null);
  const [maritimeSnapshot, setMaritimeSnapshot] = useState<(MaritimeDesktopSnapshot & { nextDisplayAt?: string }) | null>(null);
  const [maritimeCredentialSaved, setMaritimeCredentialSaved] = useState<boolean | null>(null);
  const [maritimeCredentialFingerprint, setMaritimeCredentialFingerprint] = useState<string | null>(null);
  const [webcamStatus, setWebcamStatus] = useState<PublicWebcamDesktopStatus | null>(null);
  const [webcamDiscovery, setWebcamDiscovery] = useState<PublicWebcamDiscoveryResult | null>(null);
  const [webcamObservations, setWebcamObservations] = useState<PublicObservation[]>([]);
  const [, setWebcamRegionLabel] = useState("");
  const [showWebcamSetup, setShowWebcamSetup] = useState(false);
  const [windyWebcamStatus, setWindyWebcamStatus] = useState<PublicWebcamDesktopStatus | null>(null);
  const [windyWebcamObservations, setWindyWebcamObservations] = useState<PublicObservation[]>([]);
  const [, setWindyWebcamRegionLabel] = useState("");
  const [showWindyWebcamSetup, setShowWindyWebcamSetup] = useState(false);
  const [activeWebcamId, setActiveWebcamId] = useState<string | null>(null);
  const [cameraExpanded, setCameraExpanded] = useState(false);
  const cameraPopupRef = useRef<HTMLElement | null>(null);
  const [showMaritimeSetup, setShowMaritimeSetup] = useState(false);
  const [maritimeRegionDraft, setMaritimeRegionDraft] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [setupStep, setSetupStep] = useState(settings.hunterSetupStep);
  const [setupAutoDismissed, setSetupAutoDismissed] = useState(false);
  const [resumeSetupAfterMaritime, setResumeSetupAfterMaritime] = useState(false);
  const [managedJobs, setManagedJobs] = useState<HunterManagedJob[]>([]);
  const [historyQuestion, setHistoryQuestion] = useState("");
  const [historyResults, setHistoryResults] = useState<Array<HistorySearchResult | HistoryDocumentResult>>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyMaintenance, setHistoryMaintenance] = useState("");
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [showStageFive, setShowStageFive] = useState(false);
  const [replay, setReplay] = useState<{ observations: PublicObservation[]; label: string; id: string } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ observationId: string | null; latitude: number; longitude: number; clientX: number; clientY: number } | null>(null);
  const [research, setResearch] = useState<{ title: string; query: string; loading: boolean; results: Array<{ id?: string; title: string; url?: string; snippet?: string; evidence?: string; content?: string }> } | null>(null);
  const [osintCandidates, setOsintCandidates] = useState<HunterOsintCandidate[]>([]);
  const [sourceCatalog, setSourceCatalog] = useState<HunterSourceCatalogEntry[]>([]);
  const [protectedProviderStatus, setProtectedProviderStatus] = useState<OsintProviderDesktopStatus[]>([]);
  const [mapViewport, setMapViewport] = useState<HunterMapViewport>({ west: -180, south: -85, east: 180, north: 85, zoom: 1.15, latitude: 18, longitude: 0 });
  const [mapFocus, setMapFocus] = useState<{ id: number; west?: number; south?: number; east?: number; north?: number; longitude?: number; latitude?: number; zoom?: number } | null>(null);
  const mapFocusSequence = useRef(0);
  const [mapDataSearch, setMapDataSearch] = useState("");
  const [querySource, setQuerySource] = useState<HunterSourceCatalogEntry | null>(null);
  const [queryEnableSourceId, setQueryEnableSourceId] = useState<string | null>(null);
  const [queryResultsSourceId, setQueryResultsSourceId] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState(() => migrateHunterWorkspaceSettings(settings.hunterWorkspace, settings.hunterSourceSettings));
  const [settingsSourceId, setSettingsSourceId] = useState<string | null>(null);
  const hunterBoardRef = useRef<HTMLDivElement>(null);
  const hunterLayoutResize = useRef<{ axis: "events" | "map"; pointerId: number; bounds: DOMRect } | null>(null);
  const nextMaritimeDisplayAt = useRef(0);
  const maritimeWarmupPasses = useRef(0);
  const webcamDiscoveryAttempted = useRef(false);
  const webcamDiscoveryInFlight = useRef<Promise<PublicWebcamDiscoveryResult> | null>(null);
  const automaticQueryRefreshInFlight = useRef<string | null>(null);
  const setupVisible = setupRequested || showSetup || (settingsReady && !settings.hunterSetupCompleted && !setupAutoDismissed);
  const visibleSetupStep = setupRequested ? 0 : showSetup ? setupStep : settings.hunterSetupStep;

  const discoverPublicWebcamRegions = useCallback(async () => {
    if (webcamDiscoveryInFlight.current) return webcamDiscoveryInFlight.current;
    const desktop = window.voidcatDesktop;
    if (!desktop?.webcams || desktop.bridgeVersion < 9 || typeof desktop.webcams.discoverRegions !== "function") throw new Error("Restart VoidCat once to activate confirmed YouTube live-camera sectors.");
    webcamDiscoveryAttempted.current = true;
    const operation = (async () => {
      const result = await desktop.webcams.discoverRegions();
      setWebcamDiscovery(result);
      setWebcamStatus(await desktop.webcams.status());
      setSelectedId((current) => current ?? result.observations[0]?.observationId ?? null);
      return result;
    })();
    webcamDiscoveryInFlight.current = operation;
    try {
      return await operation;
    } catch (discoveryError) {
      webcamDiscoveryAttempted.current = false;
      throw discoveryError;
    } finally {
      if (webcamDiscoveryInFlight.current === operation) webcamDiscoveryInFlight.current = null;
    }
  }, []);

  const loadSnapshot = useCallback(async (path = "/api/hunter-seeker/status", method: "GET" | "POST" = "GET") => {
    const response = await fetch(path, { method, cache: "no-store" });
    const data = await response.json() as HunterSeekerSnapshot & { error?: string };
    if (!response.ok) throw new Error(data.error ?? "Hunter-Seeker local service did not respond.");
    setSnapshot(data);
    const serverRates = Object.fromEntries(data.sources.map((source) => [source.descriptor.id, source.health.pollCadenceMs]));
    committedRates.current = serverRates;
    setSelectedId((current) => current?.startsWith("aisstream-vessel:") || current?.startsWith(`${PUBLIC_WEBCAM_SOURCE_ID}:`) || current?.startsWith(`${WINDY_WEBCAM_SOURCE_ID}:`) || current && data.observations.some((observation) => observation.observationId === current)
      ? current
      : data.observations[0]?.observationId ?? null);
    return data;
  }, []);

  useEffect(() => {
    let active = true;
    void fetch("/api/hunter-seeker/source-catalog", { cache: "no-store" })
      .then(async (response) => { const data = await response.json() as { sources?: HunterSourceCatalogEntry[]; error?: string }; if (!response.ok) throw new Error(data.error ?? "Source catalog unavailable."); return data.sources ?? []; })
      .then((sources) => { if (active) setSourceCatalog(sources); })
      .catch(() => { if (active) setSourceCatalog([]); });
    return () => { active = false; };
  }, []);

  const refreshProtectedProviderStatus = useCallback(async () => {
    if (!window.voidcatDesktop?.osint) return;
    try { setProtectedProviderStatus((await window.voidcatDesktop.osint.status()).providers); }
    catch { setProtectedProviderStatus([]); }
  }, []);

  useEffect(() => {
    let active = true;
    if (!window.voidcatDesktop?.osint) return;
    void window.voidcatDesktop.osint.status().then((status) => { if (active) setProtectedProviderStatus(status.providers); }).catch(() => { if (active) setProtectedProviderStatus([]); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!window.voidcatDesktop?.webcams || window.voidcatDesktop.bridgeVersion < 9) return;
    void window.voidcatDesktop.webcams.status().then(setWebcamStatus).catch(() => setWebcamStatus(null));
  }, []);

  useEffect(() => {
    const enabled = snapshot?.sources.some((source) => source.descriptor.id === PUBLIC_WEBCAM_SOURCE_ID && source.health.enabled) ?? false;
    if (!enabled || !webcamStatus?.configured || webcamDiscovery || webcamDiscoveryAttempted.current) return;
    void discoverPublicWebcamRegions().catch((discoveryError) => {
      notify({ tone: "error", title: "Live-camera sector discovery failed", message: discoveryError instanceof Error ? discoveryError.message : "Confirmed live-camera sectors could not be loaded." });
    });
  }, [snapshot?.sources, webcamStatus?.configured, webcamDiscovery, discoverPublicWebcamRegions, notify]);

  useEffect(() => {
    if (!window.voidcatDesktop?.windyWebcams || window.voidcatDesktop.bridgeVersion < 8) return;
    void window.voidcatDesktop.windyWebcams.status().then(setWindyWebcamStatus).catch(() => setWindyWebcamStatus(null));
  }, []);

  const loadOsintCandidates = useCallback(async () => {
    const response = await fetch("/api/hunter-seeker/osint-candidates", { cache: "no-store" });
    const data = await response.json() as { candidates?: HunterOsintCandidate[]; error?: string };
    if (!response.ok) throw new Error(data.error ?? "OSINT candidate inbox is unavailable.");
    setOsintCandidates(data.candidates ?? []);
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

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadOsintCandidates().catch(() => { /* candidate inbox remains optional and explicit */ }); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadOsintCandidates]);

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
      metrics: { errorRate: maritimeSnapshot?.errorRate ?? (maritimeSnapshot?.status === "down" ? 1 : 0), recordsPerHour: maritimeSnapshot?.recordsPerHour ?? 0, expectedBaseline: maritimeSnapshot?.expectedBaseline ?? 1, silentZero: maritimeSnapshot?.silentZero ?? false, aiContextEligible: maritimeSnapshot?.aiContextEligible ?? false, sampleCount: maritimeSnapshot ? 1 : 0 },
    },
  }), [maritimeSnapshot]);
  const sources = useMemo(() => [...(snapshot?.sources ?? []), maritimeSource], [snapshot?.sources, maritimeSource]);
  const workspaceDefinitionKey = sources.map((source) => source.descriptor.id).sort().join("|");
  const workspaceDefinitions = useMemo(() => mergeHunterSourceDefinitions(sources.map((source) => ({
    id: source.descriptor.id,
    displayName: source.descriptor.displayName,
    category: source.descriptor.category,
    providerDocsUrl: source.descriptor.providerDocsUrl,
    pollCadenceMs: source.descriptor.pollCadenceMs,
    credentialType: [AISSTREAM_MARITIME_SOURCE_ID, PUBLIC_WEBCAM_SOURCE_ID, WINDY_WEBCAM_SOURCE_ID].includes(source.descriptor.id) ? "api-key" : "none",
  }))), [sources]);
  const workspaceDefinitionBySourceId = useMemo(() => new Map(workspaceDefinitions.flatMap((definition) => [definition.id, ...definition.runtimeSourceIds].map((id) => [id, definition] as const))), [workspaceDefinitions]);
  const mapDisplayBySource = useMemo(() => Object.fromEntries(workspaceDefinitions.flatMap((definition) => {
    const preference = workspace.sourcePreferences[definition.id] ?? definition.defaultSettings;
    return [definition.id, ...definition.runtimeSourceIds].map((sourceId) => [sourceId, { opacity: preference.opacity, order: preference.order, markerSize: preference.markerSize, labels: preference.labels }] as const);
  })), [workspaceDefinitions, workspace.sourcePreferences]);
  const visibleMapOverlays = useMemo(() => (snapshot?.mapOverlays ?? []).filter((overlay) => {
    if (!overlay.sourceId) return true;
    const definition = workspaceDefinitionBySourceId.get(overlay.sourceId);
    const preference = definition ? workspace.sourcePreferences[definition.id] ?? definition.defaultSettings : undefined;
    return preference?.enabled === true && preference.layerVisible;
  }).map((overlay) => {
    const definition = overlay.sourceId ? workspaceDefinitionBySourceId.get(overlay.sourceId) : undefined;
    const preference = definition ? workspace.sourcePreferences[definition.id] ?? definition.defaultSettings : undefined;
    return { ...overlay, opacity: overlay.opacity * (preference?.opacity ?? 1) };
  }), [snapshot?.mapOverlays, workspaceDefinitionBySourceId, workspace.sourcePreferences]);
  const workspacePersistReady = useRef(false);
  const workspaceDefinitionKeyRef = useRef("");
  useEffect(() => {
    if (workspaceDefinitionKeyRef.current === workspaceDefinitionKey) return;
    workspaceDefinitionKeyRef.current = workspaceDefinitionKey;
    const timer = window.setTimeout(() => setWorkspace((current) => migrateHunterWorkspaceSettings(current, settings.hunterSourceSettings, workspaceDefinitions)), 0);
    return () => window.clearTimeout(timer);
  }, [settings.hunterSourceSettings, workspaceDefinitionKey, workspaceDefinitions]);
  useEffect(() => {
    if (!workspacePersistReady.current) { workspacePersistReady.current = true; return; }
    const timer = window.setTimeout(() => { void onSaveSettings({ hunterWorkspace: workspace }).catch((saveError) => notify({ tone: "error", title: "Workspace settings not saved", message: saveError instanceof Error ? saveError.message : "The source workspace preference could not be saved." })); }, 350);
    return () => window.clearTimeout(timer);
  }, [workspace, onSaveSettings, notify]);

  const activeSourceKey = sources.filter((source) => source.health.enabled).map((source) => source.descriptor.id).sort().join("|");
  const activeSourceIds = useMemo(() => activeSourceKey ? activeSourceKey.split("|") : [], [activeSourceKey]);
  const liveObservations = useMemo(() => {
    const enabledRuntime = new Set(activeSourceKey ? activeSourceKey.split("|") : []);
    const backendObservations = (snapshot?.observations ?? []).filter((observation) => !(observation.provenance.sourceFeedId === PUBLIC_WEBCAM_SOURCE_ID && observation.entityType.includes("public-webcam-region")));
    return [...backendObservations, ...(maritimeSnapshot?.observations ?? []), ...(webcamDiscovery?.observations ?? []), ...webcamObservations, ...windyWebcamObservations].filter((observation) => {
      const definition = workspaceDefinitionBySourceId.get(observation.provenance.sourceFeedId);
      return definition ? workspace.sourcePreferences[definition.id]?.enabled === true : enabledRuntime.has(observation.provenance.sourceFeedId);
    });
  }, [snapshot?.observations, maritimeSnapshot?.observations, webcamDiscovery?.observations, webcamObservations, windyWebcamObservations, activeSourceKey, workspaceDefinitionBySourceId, workspace.sourcePreferences]);
  const observations = replay?.observations ?? liveObservations;
  const observationFilterNowMs = Date.parse(snapshot?.generatedAt ?? "1970-01-01T00:00:00.000Z");
  const mapObservations = useMemo(() => {
    // DeFlock exposes lightweight worldwide hubs plus cameras from only the
    // explicitly selected sector, so map work remains bounded.
    const layerVisible = (observation: PublicObservation) => {
      const definition = workspaceDefinitionBySourceId.get(observation.provenance.sourceFeedId);
      if (!definition) return true;
      const preference = workspace.sourcePreferences[definition.id] ?? definition.defaultSettings;
      if (!preference.layerVisible || mapViewport.zoom < preference.minimumZoom || mapViewport.zoom > preference.maximumZoom) return false;
      if (preference.recentOnlyMinutes > 0 && observationFilterNowMs - Date.parse(observation.timestamp) > preference.recentOnlyMinutes * 60_000) return false;
      for (const [key, expected] of Object.entries(preference.filters)) {
        if (expected === "" || expected === false) continue;
        const actual = key === "minimumConfidence" ? observation.confidence
          : key === "minimumSeverity" ? observation.commonEvent?.severity ?? observation.attributes.severity
          : key === "minimumAltitude" ? (observation.position.altitudeMeters ?? 0) * 3.28084
          : key === "magnitude" ? observation.attributes.magnitude
          : observation.attributes[key] ?? observation.commonEvent?.eventType;
        if (typeof expected === "number") { if (!Number.isFinite(Number(actual)) || Number(actual) < expected) return false; }
        else if (typeof expected === "boolean") { if (Boolean(actual) !== expected) return false; }
        else if (!String(actual ?? "").toLowerCase().includes(expected.toLowerCase())) return false;
      }
      return true;
    };
    const displayObservations = observations.filter(layerVisible);
    const cameras = displayObservations.filter((observation) => observation.provenance.sourceFeedId === DEFLOCK_ALPR_SOURCE_ID).slice(0, 250_000);
    const cameraIds = new Set(cameras.map((observation) => observation.observationId));
    const other = displayObservations.filter((observation) => !cameraIds.has(observation.observationId)).slice(0, 1_500);
    return [...other, ...cameras];
  }, [observations, workspace.sourcePreferences, workspaceDefinitionBySourceId, mapViewport.zoom, observationFilterNowMs]);
  const visibleSources = useMemo(() => sources.filter((source) => activeSourceIds.includes(source.descriptor.id)), [sources, activeSourceIds]);
  const generatedAtCandidates = [snapshot?.generatedAt, maritimeSnapshot?.lastMessageAt, webcamDiscovery?.fetchedAt, webcamObservations[0]?.provenance.fetchedAt, windyWebcamObservations[0]?.provenance.fetchedAt]
    .map((value) => Date.parse(value ?? ""))
    .filter(Number.isFinite);
  const generatedAtMs = generatedAtCandidates.length ? Math.max(...generatedAtCandidates) : 0;
  const sourceById = useMemo(() => new Map(sources.map((source) => [source.descriptor.id, source])), [sources]);
  const sourceFreshnessById = useMemo(() => Object.fromEntries(sources.map((source) => [source.descriptor.id, sourceFreshnessState(source, generatedAtMs)])) as Record<string, HunterFreshnessState>, [sources, generatedAtMs]);
  const observationFreshnessById = useMemo(() => Object.fromEntries(observations.map((observation) => [observation.observationId, observationFreshnessState(observation, sourceById.get(observation.provenance.sourceFeedId), generatedAtMs)])) as Record<string, HunterFreshnessState>, [observations, sourceById, generatedAtMs]);
  const explorerSourceState = useMemo(() => Object.fromEntries(workspaceDefinitions.map((definition) => {
    const enabled = workspace.sourcePreferences[definition.id]?.enabled === true;
    const runtime = definition.runtimeSourceIds.map((id) => sourceById.get(id)).filter((source): source is SourceSnapshot => Boolean(source));
    const enabledRuntime = runtime.filter((source) => source.health.enabled);
    const activeQuery = snapshot?.sourceQueries?.find((query) => query.sourceId === definition.id);
    const queryCapability = snapshot?.sourceQueryCapabilities?.find((query) => query.sourceId === definition.id);
    const catalog = sourceCatalog.find((source) => source.id === definition.id);
    const freshness = enabledRuntime.map((source) => sourceFreshnessById[source.descriptor.id]).find((value) => value === "degraded" || value === "stale") ?? enabledRuntime.map((source) => sourceFreshnessById[source.descriptor.id]).find(Boolean);
    let status: HunterExplorerSourceState["status"] = !enabled ? "disabled" : runtime.length ? freshness ?? "offline" : activeQuery?.cache.status === "cached" ? "cached" : activeQuery ? "live" : queryCapability ? "scope-required" : catalog?.runtimeStatus === "adapter-required" ? "adapter-required" : catalog?.runtimeStatus === "credential-setup-required" ? "setup-required" : "offline";
    const credentialState: HunterExplorerSourceState["credentialState"] = !definition.capabilities.supportsCredentials ? "not-required"
      : definition.runtimeSourceIds.includes(AISSTREAM_MARITIME_SOURCE_ID) ? maritimeCredentialSaved === null ? "checking" : maritimeCredentialSaved ? "saved" : "missing"
      : definition.runtimeSourceIds.includes(PUBLIC_WEBCAM_SOURCE_ID) ? webcamStatus?.configured ? "saved" : "missing"
      : definition.runtimeSourceIds.includes(WINDY_WEBCAM_SOURCE_ID) ? windyWebcamStatus?.configured ? "saved" : "missing"
      : definition.credentialBrokerId ? protectedProviderStatus.find((provider) => provider.id === definition.credentialBrokerId)?.configured ? "saved" : "missing"
      : catalog?.runtimeStatus === "credential-setup-required" ? "missing" : undefined;
    if (credentialState === "missing" && enabled) status = "setup-required";
    const state: HunterExplorerSourceState = {
      status,
      statusText: status === "scope-required" ? "BOUNDED QUERY REQUIRED" : status.replaceAll("-", " ").toUpperCase(),
      observationCount: runtime.reduce((sum, source) => sum + source.health.cachedObservations, 0) || (activeQuery?.observationCount ?? 0) + (activeQuery?.references?.length ?? 0),
      lastSuccessAt: runtime.map((source) => source.health.lastSuccessAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? activeQuery?.queriedAt,
      nextScheduledAt: runtime.map((source) => source.health.nextScheduledAt).filter((value): value is string => Boolean(value)).sort().at(0),
      credentialState,
      busy: definition.runtimeSourceIds.some((id) => busySources.includes(id)),
      error: runtime.find((source) => source.health.status === "down")?.health.message,
    };
    return [definition.id, state];
  })), [workspaceDefinitions, sourceById, snapshot?.sourceQueries, snapshot?.sourceQueryCapabilities, sourceCatalog, sourceFreshnessById, maritimeCredentialSaved, webcamStatus?.configured, windyWebcamStatus?.configured, protectedProviderStatus, workspace.sourcePreferences, busySources]);
  const activeSettingsDefinition = workspaceDefinitions.find((definition) => definition.id === settingsSourceId) ?? null;
  const aggregateFreshness = visibleSources.map((source) => sourceFreshnessById[source.descriptor.id] ?? "degraded").sort((left, right) => freshnessRank(right) - freshnessRank(left))[0] ?? "offline";
  const lastSuccessAt = visibleSources.map((source) => source.health.lastSuccessAt).filter((value): value is string => Boolean(value)).sort().at(-1);
  const selected = observations.find((observation) => observation.observationId === selectedId) ?? observations[0] ?? null;
  const mapSearchResults = useMemo(() => {
    const query = mapDataSearch.trim().toLowerCase();
    if (query.length < 2) return [];
    return observations.filter((observation) => `${observationTitle(observation)} ${observation.entityId} ${observation.entityType} ${observation.provenance.sourceFeedId} ${Object.values(observation.attributes ?? {}).join(" ")}`.toLowerCase().includes(query)).slice(0, 12);
  }, [mapDataSearch, observations]);
  const activeWebcam = observations.find((observation) => observation.observationId === activeWebcamId && [PUBLIC_WEBCAM_SOURCE_ID, WINDY_WEBCAM_SOURCE_ID].includes(observation.provenance.sourceFeedId)) ?? null;
  const activeWebcamPlayerUrl = publicWebcamPlayerUrl(activeWebcam);
  const largestMagnitude = useMemo(() => observations.reduce<number | null>((largest, observation) => {
    const magnitude = numberAttribute(observation, "magnitude");
    return magnitude === null ? largest : Math.max(largest ?? magnitude, magnitude);
  }, null), [observations]);

  async function configureSource(sourceId: string, update: { enabled?: boolean; pollCadenceMs?: number; requestBudgetPercent?: number }) {
    if (sourceId === PUBLIC_WEBCAM_SOURCE_ID && update.enabled) {
      if (!window.voidcatDesktop?.webcams || window.voidcatDesktop.bridgeVersion < 9) {
        notify({ tone: "warning", title: "Restart required", message: "Close VoidCat Harness completely and reopen it once to activate the protected public-webcam bridge." });
        return;
      }
      const status = await window.voidcatDesktop.webcams.status();
      setWebcamStatus(status);
      if (!status.configured) { setShowWebcamSetup(true); return; }
      try {
        const discovery = webcamDiscovery ?? await discoverPublicWebcamRegions();
        setSelectedId((current) => current ?? discovery.observations[0]?.observationId ?? null);
        notify({ tone: "info", title: "Live-camera sectors verified", message: `${discovery.returned.toLocaleString()} sector${discovery.returned === 1 ? "" : "s"} contain ${discovery.confirmedLiveStreams.toLocaleString()} located active stream${discovery.confirmedLiveStreams === 1 ? "" : "s"} in the bounded discovery sample. Empty and unverified sectors are hidden.` });
      } catch (discoveryError) {
        notify({ tone: "error", title: "Live-camera discovery failed", message: discoveryError instanceof Error ? discoveryError.message : "Confirmed live-camera sectors could not be loaded." });
        return;
      }
    }
    if (sourceId === PUBLIC_WEBCAM_SOURCE_ID && update.enabled === false) {
      setWebcamDiscovery(null); webcamDiscoveryAttempted.current = true; setWebcamObservations([]); setWebcamRegionLabel(""); setActiveWebcamId(null);
    }
    if (sourceId === WINDY_WEBCAM_SOURCE_ID && update.enabled) {
      if (!window.voidcatDesktop?.windyWebcams || window.voidcatDesktop.bridgeVersion < 8) {
        notify({ tone: "warning", title: "Restart required", message: "Close VoidCat Harness completely and reopen it once to activate the restored Windy webcam bridge." });
        return;
      }
      const status = await window.voidcatDesktop.windyWebcams.status();
      setWindyWebcamStatus(status);
      if (!status.configured) { setShowWindyWebcamSetup(true); return; }
    }
    if (sourceId === WINDY_WEBCAM_SOURCE_ID && update.enabled === false) {
      setWindyWebcamObservations([]); setWindyWebcamRegionLabel(""); setActiveWebcamId(null);
    }
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
          nextMaritimeDisplayAt.current = 0;
          setMaritimeSnapshot((current) => current ? { ...current, displayCadenceMs: result.displayCadenceMs } : current);
          notify({ tone: "success", title: "Maritime pull rate saved", message: `Map contacts will update every ${formatPullRate(result.displayCadenceMs)} while the protected AIS stream remains connected.` });
        } catch (sourceError) {
          committedRates.current[sourceId] = previousCadence;
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
        notify({ tone: "success", title: update.enabled ? "Maritime source online" : "Maritime source offline", message: maritime.message, sound: false });
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
      setSelectedId((current) => current && (current.startsWith(`${PUBLIC_WEBCAM_SOURCE_ID}:`) || current.startsWith(`${WINDY_WEBCAM_SOURCE_ID}:`) || current.startsWith("aisstream-vessel:") || data.observations.some((observation) => observation.observationId === current))
        ? current
        : data.observations[0]?.observationId ?? null);
      const configured = data.sources.find((source) => source.descriptor.id === sourceId);
      if (sourceId === PUBLIC_WEBCAM_SOURCE_ID && update.enabled === false) webcamDiscoveryAttempted.current = false;
      notify({
        tone: "success",
        title: update.enabled === false ? "Source offline" : update.enabled === true ? "Source online" : update.requestBudgetPercent !== undefined ? "Request budget updated" : "Pull rate updated",
        sound: update.enabled === undefined ? undefined : false,
        message: update.requestBudgetPercent !== undefined
          ? `${configured?.descriptor.displayName ?? sourceId} is limited to ${update.requestBudgetPercent}% of the fixed provider ceiling.`
          : update.pollCadenceMs !== undefined
          ? `${configured?.descriptor.displayName ?? sourceId} will pull every ${formatPullRate(update.pollCadenceMs).toLowerCase()}.`
          : `${configured?.descriptor.displayName ?? sourceId} is ${configured?.health.enabled ? "enabled" : "disabled"}.`,
      });
    } catch (sourceError) {
      const message = sourceError instanceof Error ? sourceError.message : "Source configuration failed.";
      setError(message);
      if (sourceId === PUBLIC_WEBCAM_SOURCE_ID && update.enabled === false) webcamDiscoveryAttempted.current = false;
      if (previousCommittedRate !== undefined) {
        committedRates.current[sourceId] = previousCommittedRate;
      }
      notify({ tone: "error", title: "Source control failed", message });
    } finally {
      setBusySources((current) => current.filter((id) => id !== sourceId));
    }
  }

  async function toggleCameraFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await cameraPopupRef.current?.requestFullscreen();
    } catch {
      notify({ tone: "warning", title: "Fullscreen unavailable", message: "The operating system did not allow the camera display to enter fullscreen mode." });
    }
  }

  async function loadDeflockRegion(regionId: string, regionLabel: string) {
    if (busySources.includes(DEFLOCK_ALPR_SOURCE_ID)) return;
    setBusySources((current) => [...new Set([...current, DEFLOCK_ALPR_SOURCE_ID])]);
    try {
      const response = await fetch("/api/hunter-seeker/deflock/region", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ regionId }),
      });
      const data = await response.json() as HunterSeekerSnapshot & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "The DeFlock region could not be loaded.");
      const failed = data.refreshResults?.find((result) => result.status === "failed");
      if (failed) throw new Error(failed.error ?? "The DeFlock region request failed.");
      setSnapshot(data);
      const firstCamera = data.observations.find((observation) => observation.provenance.sourceFeedId === DEFLOCK_ALPR_SOURCE_ID && observation.entityType.includes("alpr-camera"));
      setSelectedId(firstCamera?.observationId ?? `${DEFLOCK_ALPR_SOURCE_ID}:region:${regionId}`);
      notify({ tone: "success", title: "DeFlock sector loaded", message: `${regionLabel}: ${data.observations.filter((observation) => observation.provenance.sourceFeedId === DEFLOCK_ALPR_SOURCE_ID && observation.entityType.includes("alpr-camera")).length.toLocaleString()} known cameras displayed. Other sectors remain lightweight map hubs.` });
    } catch (regionError) {
      notify({ tone: "error", title: "DeFlock sector unavailable", message: regionError instanceof Error ? regionError.message : "The selected DeFlock sector could not be loaded." });
    } finally {
      setBusySources((current) => current.filter((id) => id !== DEFLOCK_ALPR_SOURCE_ID));
    }
  }

  async function loadPublicWebcamRegion(regionId: string, regionLabel: string) {
    if (busySources.includes(PUBLIC_WEBCAM_SOURCE_ID)) return;
    if (!window.voidcatDesktop?.webcams || window.voidcatDesktop.bridgeVersion < 9) { notify({ tone: "warning", title: "Restart required", message: "Restart VoidCat once to activate public webcams." }); return; }
    if (!webcamStatus?.configured) { setShowWebcamSetup(true); return; }
    setBusySources((current) => [...new Set([...current, PUBLIC_WEBCAM_SOURCE_ID])]);
    try {
      const result = await window.voidcatDesktop.webcams.loadRegion(regionId);
      if (result.returned === 0) setWebcamDiscovery((current) => current ? { ...current, returned: Math.max(0, current.returned - (current.observations.some((observation) => observation.attributes.regionId === regionId) ? 1 : 0)), observations: current.observations.filter((observation) => observation.attributes.regionId !== regionId) } : current);
      setWebcamObservations(result.observations);
      setWebcamRegionLabel(regionLabel);
      const first = result.observations[0];
      setSelectedId(first?.observationId ?? `${PUBLIC_WEBCAM_SOURCE_ID}:region:${regionId}`);
      setActiveWebcamId(null);
      notify({ tone: "success", title: "Live video sector loaded", message: `${regionLabel}: ${result.returned.toLocaleString()} verified active video streams found among ${result.providerCandidates.toLocaleString()} live-search candidates${result.truncated ? " (bounded result ceiling reached)" : ""}. Still-frame, ended, and non-embeddable results were excluded. ${result.cacheState === "cached" ? "Protected cache reused." : "Fresh live search received."}` });
    } catch (regionError) {
      notify({ tone: "error", title: "Public camera sector unavailable", message: regionError instanceof Error ? regionError.message : "The selected public-camera sector could not be loaded." });
    } finally { setBusySources((current) => current.filter((id) => id !== PUBLIC_WEBCAM_SOURCE_ID)); }
  }

  async function loadWindyWebcamRegion(regionId: string, regionLabel: string) {
    if (busySources.includes(WINDY_WEBCAM_SOURCE_ID)) return;
    if (!window.voidcatDesktop?.windyWebcams || window.voidcatDesktop.bridgeVersion < 8) { notify({ tone: "warning", title: "Restart required", message: "Restart VoidCat once to activate the restored Windy webcam layer." }); return; }
    if (!windyWebcamStatus?.configured) { setShowWindyWebcamSetup(true); return; }
    setBusySources((current) => [...new Set([...current, WINDY_WEBCAM_SOURCE_ID])]);
    try {
      const result = await window.voidcatDesktop.windyWebcams.loadRegion(regionId);
      setWindyWebcamObservations(result.observations);
      setWindyWebcamRegionLabel(regionLabel);
      const first = result.observations[0];
      setSelectedId(first?.observationId ?? `${WINDY_WEBCAM_SOURCE_ID}:region:${regionId}`);
      setActiveWebcamId(null);
      notify({ tone: "success", title: "Windy webcam sector loaded", message: `${regionLabel}: ${result.returned.toLocaleString()} Windy camera players loaded among ${result.providerCandidates.toLocaleString()} indexed records${result.truncated ? " (bounded listing ceiling reached)" : ""}. ${result.cacheState === "cached" ? "Protected cache reused." : "Fresh Windy index received."}` });
    } catch (regionError) {
      notify({ tone: "error", title: "Windy camera sector unavailable", message: regionError instanceof Error ? regionError.message : "The selected Windy camera sector could not be loaded." });
    } finally { setBusySources((current) => current.filter((id) => id !== WINDY_WEBCAM_SOURCE_ID)); }
  }

  function selectObservation(observationId: string) {
    setSelectedId(observationId);
    const observation = observations.find((candidate) => candidate.observationId === observationId);
    setActiveWebcamId(observation && [PUBLIC_WEBCAM_SOURCE_ID, WINDY_WEBCAM_SOURCE_ID].includes(observation.provenance.sourceFeedId) && !observation.entityType.includes("region") ? observationId : null);
    setCameraExpanded(false);
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
      setHistoryExpanded(true);
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
        setHistoryExpanded(true);
      } else {
        if (!window.confirm("Run one bounded, backup-first history downsampling pass? Pinned, watchlist, trigger, derived, summary, chat, and RAG-library records are protected.")) return;
        const response = await fetch("/api/hunter-seeker/history/maintenance", { method: "POST" });
        const data = await response.json() as { deleted?: number; summaries?: number; error?: string };
        if (!response.ok) throw new Error(data.error ?? "Maintenance pass failed.");
        setHistoryMaintenance(`COMPLETE // ${data.deleted ?? 0} BULK REMOVED // ${data.summaries ?? 0} SUMMARIES`);
        setHistoryExpanded(true);
        await loadSnapshot();
      }
    } catch (maintenanceError) { notify({ tone: "error", title: "History maintenance failed", message: maintenanceError instanceof Error ? maintenanceError.message : "History maintenance failed." }); }
    finally { setHistoryBusy(false); }
  }

  function researchQuery(target = contextMenu) {
    if (!target) return "";
    const observation = observations.find((item) => item.observationId === target.observationId);
    if (!observation) return `current events and geographic context near ${target.latitude.toFixed(4)}, ${target.longitude.toFixed(4)}`;
    const identifiers = [textAttribute(observation, "callsign"), textAttribute(observation, "transponderHex"), textAttribute(observation, "registration"), textAttribute(observation, "mmsi"), textAttribute(observation, "noradCatalogId")].filter(Boolean).join(" ");
    return `${observationTitle(observation)} ${identifiers} ${observation.entityType} ${target.latitude.toFixed(4)}, ${target.longitude.toFixed(4)}`.trim();
  }

  async function runContextResearch(mode: "search" | "research") {
    const query = researchQuery(); if (!query) return; setContextMenu(null); setResearch({ title: mode === "search" ? "WEB SEARCH RESULTS" : "CLEANED RESEARCH EVIDENCE", query, loading: true, results: [] });
    try {
      const response = await fetch(mode === "search" ? "/api/web/discover" : "/api/web/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) });
      const data = await response.json() as { results?: Array<{ id?: string; title: string; url?: string; snippet?: string; evidence?: string; content?: string }>; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Research request failed."); setResearch({ title: mode === "search" ? "WEB SEARCH RESULTS" : "CLEANED RESEARCH EVIDENCE", query, loading: false, results: data.results ?? [] });
    } catch (researchError) { setResearch(null); notify({ tone: "error", title: "Research failed", message: researchError instanceof Error ? researchError.message : "Research request failed." }); }
  }

  async function investigateContextInOsint() {
    const target = contextMenu; if (!target) return;
    const observation = observations.find((item) => item.observationId === target.observationId);
    setContextMenu(null);
    try {
      const response = await fetch("/api/osint/hunter/intake", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(observation ? { observationId: observation.observationId, observation } : { latitude: target.latitude, longitude: target.longitude, radiusKm: 25 }),
      });
      const draft = await response.json() as HunterOsintDraft & { error?: string };
      if (!response.ok) throw new Error(draft.error ?? "The Hunter-Seeker seed could not be prepared for OSINT.");
      onInvestigateOsint?.(draft);
      notify({ tone: "info", title: "OSINT draft prepared", message: "Original Hunter provenance was retained. Select a provider and explicitly start any lookup." });
    } catch (intakeError) { notify({ tone: "error", title: "OSINT handoff held", message: intakeError instanceof Error ? intakeError.message : "The Hunter-Seeker seed could not be prepared for OSINT." }); }
  }

  async function dismissOsintCandidate(id: string) {
    const response = await fetch(`/api/hunter-seeker/osint-candidates/${encodeURIComponent(id)}`, { method: "DELETE" });
    const data = await response.json() as { error?: string };
    if (!response.ok) throw new Error(data.error ?? "The candidate could not be dismissed.");
    await loadOsintCandidates();
  }

  async function addContextWatch(region = false) {
    const target = contextMenu; if (!target) return; const observation = observations.find((item) => item.observationId === target.observationId); setContextMenu(null);
    let body: Record<string, unknown>;
    if (region || !observation) body = { kind: "geofence", label: `Region ${target.latitude.toFixed(2)}, ${target.longitude.toFixed(2)}`, geometry: { type: "circle", latitude: target.latitude, longitude: target.longitude, radiusKm: 25 } };
    else if (observation.entityType.includes("aircraft")) body = { kind: "aircraft-icao", label: observationTitle(observation), value: textAttribute(observation, "transponderHex") ?? observation.entityId.replace(/^aircraft:/i, "") };
    else if (observation.entityType.includes("vessel")) body = { kind: "vessel-mmsi", label: observationTitle(observation), value: textAttribute(observation, "mmsi") ?? observation.entityId.replace(/^vessel:/i, "") };
    else if (observation.entityType.includes("space") || observation.provenance.sourceFeedId === CELESTRAK_STATIONS_SOURCE_ID) body = { kind: "satellite-norad", label: observationTitle(observation), value: textAttribute(observation, "noradCatalogId") ?? observation.entityId.replace(/^(?:satellite|station):/i, "") };
    else body = { kind: "geofence", label: `${observationTitle(observation)} region`, geometry: { type: "circle", latitude: target.latitude, longitude: target.longitude, radiusKm: 25 } };
    try { const response = await fetch("/api/hunter-seeker/watchlists", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const data = await response.json() as { error?: string }; if (!response.ok) throw new Error(data.error ?? "Watch rule failed."); notify({ tone: "success", title: "Target rule armed", message: "Matching observations will trigger notifications and protected retention." }); await loadSnapshot(); }
    catch (watchError) { notify({ tone: "error", title: "Target rule failed", message: watchError instanceof Error ? watchError.message : "Target rule failed." }); }
  }

  function analyzeContext() {
    const target = contextMenu; if (!target) return; const observation = observations.find((item) => item.observationId === target.observationId); const query = researchQuery(target); setContextMenu(null);
    onAnalyzeObservation?.(observation
      ? `Analyze this Hunter-Seeker contact using the available live tools and cite observation IDs. Contact: ${query}. Current observation ID: ${observation.observationId}. Explain provenance, freshness, confidence, coverage limitations, notable behavior, and what additional evidence would be needed.`
      : `Analyze the Hunter-Seeker region near ${target.latitude.toFixed(4)}, ${target.longitude.toFixed(4)} using available live tools. Cite observation IDs for factual findings, mark unsupported claims, and explain source coverage limitations.`);
  }

  function catalogEntryFor(definition: HunterSeekerSourceDefinition) {
    return sourceCatalog.find((source) => source.id === definition.id) ?? sourceCatalog.find((source) => definition.runtimeSourceIds.includes(source.id));
  }

  function openDefinitionQuery(definition: HunterSeekerSourceDefinition) {
    const catalog = catalogEntryFor(definition);
    if (catalog && snapshot?.sourceQueryCapabilities?.some((capability) => capability.sourceId === catalog.id)) { setQueryEnableSourceId(definition.id); setQuerySource(catalog); }
    else notify({ tone: "info", title: "Operational source", message: `${definition.name} is controlled through its retrieval toggle and map settings.` });
  }

  function beginHunterLayoutResize(axis: "events" | "map", event: React.PointerEvent<HTMLDivElement>) {
    const bounds = hunterBoardRef.current?.getBoundingClientRect();
    if (!bounds) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    hunterLayoutResize.current = { axis, pointerId: event.pointerId, bounds };
    document.body.classList.add("hunter-resizing");
  }

  function moveHunterLayoutResize(event: React.PointerEvent<HTMLDivElement>) {
    const resize = hunterLayoutResize.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (resize.axis === "events") {
      const explorerWidth = workspace.explorerCollapsed ? 34 : workspace.explorerWidth;
      const maximum = Math.max(280, Math.min(720, resize.bounds.width - explorerWidth - 7 - 430));
      const eventsPaneWidth = Math.max(280, Math.min(maximum, resize.bounds.right - event.clientX));
      setWorkspace((current) => ({ ...current, eventsPaneWidth }));
      return;
    }
    const mapPanePercent = Math.max(35, Math.min(78, ((event.clientY - resize.bounds.top) / resize.bounds.height) * 100));
    setWorkspace((current) => ({ ...current, mapPanePercent }));
  }

  function endHunterLayoutResize(event: React.PointerEvent<HTMLDivElement>) {
    if (hunterLayoutResize.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    hunterLayoutResize.current = null;
    document.body.classList.remove("hunter-resizing");
  }

  function resizeHunterLayoutWithKeyboard(axis: "events" | "map", event: React.KeyboardEvent<HTMLDivElement>) {
    if (axis === "events" && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      setWorkspace((current) => ({ ...current, eventsPaneWidth: Math.max(280, Math.min(720, current.eventsPaneWidth + (event.key === "ArrowLeft" ? 20 : -20))) }));
    }
    if (axis === "map" && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      setWorkspace((current) => ({ ...current, mapPanePercent: Math.max(35, Math.min(78, current.mapPanePercent + (event.key === "ArrowDown" ? 2 : -2))) }));
    }
  }

  function completeDefinitionQuery(nextSnapshot: unknown, summary: string) {
    const completedSnapshot = nextSnapshot as HunterSeekerSnapshot;
    setSnapshot(completedSnapshot);
    const definition = workspaceDefinitions.find((item) => item.id === queryEnableSourceId);
    if (definition) {
      setWorkspace((current) => ({ ...current, activePresetId: null, sourcePreferences: { ...current.sourcePreferences, [definition.id]: { ...(current.sourcePreferences[definition.id] ?? definition.defaultSettings), enabled: true, layerVisible: true } } }));
      if (completedSnapshot.sourceQueries?.find((query) => query.sourceId === definition.id)?.references?.length) setQueryResultsSourceId(definition.id);
    }
    void refreshProtectedProviderStatus();
    setQuerySource(null); setQueryEnableSourceId(null);
    notify({ tone: "success", title: "Bounded source loaded", message: summary });
  }

  function toggleWorkspaceSources(definitions: readonly HunterSeekerSourceDefinition[], enabled: boolean) {
    const missingCredentials = enabled ? definitions.filter((definition) => ["missing", "invalid", "checking"].includes(explorerSourceState[definition.id]?.credentialState ?? "not-required")) : [];
    const requiresInitialQuery = enabled ? definitions.filter((definition) => !definition.runtimeSourceIds.length && snapshot?.sourceQueryCapabilities?.some((capability) => capability.sourceId === definition.id) && !snapshot?.sourceQueries?.some((query) => query.sourceId === definition.id)) : [];
    setWorkspace((current) => ({
      ...current,
      activePresetId: null,
      sourcePreferences: {
        ...current.sourcePreferences,
        ...Object.fromEntries(definitions.map((definition) => [definition.id, { ...(current.sourcePreferences[definition.id] ?? definition.defaultSettings), enabled }])),
      },
    }));
    if (missingCredentials.length) notify({ tone: "warning", title: "Source enabled — setup required", message: `${missingCredentials.length} source${missingCredentials.length === 1 ? " is" : "s are"} enabled but cannot retrieve until its protected credential is configured with the gear button.` });
    if (requiresInitialQuery.length) notify({ tone: "warning", title: "Source enabled — scope required", message: `${requiresInitialQuery.length} source${requiresInitialQuery.length === 1 ? " needs" : "s need"} a bounded query scope. Use the source's gear button to configure it.` });
    void (async () => {
      const operationalDefinitions = enabled ? definitions.filter((definition) => !missingCredentials.includes(definition)) : definitions;
      for (const sourceId of [...new Set(operationalDefinitions.flatMap((definition) => definition.runtimeSourceIds))]) {
        const runtime = sourceById.get(sourceId);
        if (runtime && runtime.health.enabled !== enabled) await configureSource(sourceId, { enabled });
      }
    })();
  }

  function refreshWorkspaceSources(definitions: readonly HunterSeekerSourceDefinition[]) {
    void (async () => {
      const sourceIds = [...new Set(definitions.flatMap((definition) => definition.runtimeSourceIds.length ? definition.runtimeSourceIds : snapshot?.sourceQueries?.some((query) => query.sourceId === definition.id) ? [definition.id] : []))];
      for (const sourceId of sourceIds) {
        if (sourceId === AISSTREAM_MARITIME_SOURCE_ID) continue;
        try {
          const response = await fetch(`/api/hunter-seeker/sources/${encodeURIComponent(sourceId)}/refresh`, { method: "POST", cache: "no-store" });
          const data = await response.json() as HunterSeekerSnapshot & { error?: string };
          if (!response.ok) throw new Error(data.error ?? `Could not refresh ${sourceId}.`);
          setSnapshot(data);
        } catch (refreshError) {
          notify({ tone: "error", title: "Source refresh failed", message: refreshError instanceof Error ? refreshError.message : `Could not refresh ${sourceId}.` });
        }
      }
    })();
  }

  function configureDefinitionCredential(definition: HunterSeekerSourceDefinition) {
    if (definition.runtimeSourceIds.includes(AISSTREAM_MARITIME_SOURCE_ID)) setShowMaritimeSetup(true);
    else if (definition.runtimeSourceIds.includes(PUBLIC_WEBCAM_SOURCE_ID)) setShowWebcamSetup(true);
    else if (definition.runtimeSourceIds.includes(WINDY_WEBCAM_SOURCE_ID)) setShowWindyWebcamSetup(true);
    else openDefinitionQuery(definition);
  }

  function testDefinitionCredential(definition: HunterSeekerSourceDefinition) {
    if (!definition.credentialBrokerId || !window.voidcatDesktop?.osint) { configureDefinitionCredential(definition); return; }
    void window.voidcatDesktop.osint.test(definition.credentialBrokerId)
      .then(() => { void refreshProtectedProviderStatus(); notify({ tone: "success", title: "Credential verified", message: `${definition.name} accepted the protected credential.` }); })
      .catch((credentialError) => notify({ tone: "error", title: "Credential test failed", message: credentialError instanceof Error ? credentialError.message : `${definition.name} rejected the protected credential.` }));
  }

  function removeDefinitionCredential(definition: HunterSeekerSourceDefinition) {
    if (!window.confirm(`Remove the protected credential for ${definition.name}? The source will be disconnected.`)) return;
    void (async () => {
      if (definition.runtimeSourceIds.includes(AISSTREAM_MARITIME_SOURCE_ID)) {
        await window.voidcatDesktop?.maritime.disable();
        await window.voidcatDesktop?.credentials.delete(AISSTREAM_CREDENTIAL_NAMESPACE, AISSTREAM_CREDENTIAL_KEY);
        setMaritimeCredentialSaved(false);
      } else if (definition.runtimeSourceIds.includes(PUBLIC_WEBCAM_SOURCE_ID)) { await window.voidcatDesktop?.webcams.remove(); setWebcamStatus((current) => current ? { ...current, configured: false } : current); }
      else if (definition.runtimeSourceIds.includes(WINDY_WEBCAM_SOURCE_ID)) { await window.voidcatDesktop?.windyWebcams.remove(); setWindyWebcamStatus((current) => current ? { ...current, configured: false } : current); }
      else if (definition.credentialBrokerId) { await window.voidcatDesktop?.osint.remove(definition.credentialBrokerId); await refreshProtectedProviderStatus(); }
      toggleWorkspaceSources([definition], false);
      notify({ tone: "success", title: "Credential removed", message: `${definition.name} was disconnected and its protected credential was removed.` });
    })().catch((credentialError) => notify({ tone: "error", title: "Credential removal failed", message: credentialError instanceof Error ? credentialError.message : "The protected credential could not be removed." }));
  }

  function applyWorkspacePreset(preset: HunterSavedView) {
    const next = applyHunterPreset(workspace, preset, workspaceDefinitions);
    setWorkspace(next);
    mapFocusSequence.current += 1;
    setMapFocus({ id: mapFocusSequence.current, longitude: preset.map.longitude, latitude: preset.map.latitude, zoom: preset.map.zoom });
    void (async () => {
      for (const definition of workspaceDefinitions) {
        const enabled = next.sourcePreferences[definition.id]?.enabled ?? false;
        for (const sourceId of definition.runtimeSourceIds) if (sourceById.get(sourceId)?.health.enabled !== enabled) await configureSource(sourceId, { enabled });
      }
    })();
  }

  function saveWorkspacePreset(name: string) {
    const idBase = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "saved-view";
    const id = `${idBase}-${Date.now().toString(36)}`;
    const sourceIds = workspaceDefinitions.filter((definition) => workspace.sourcePreferences[definition.id]?.enabled).map((definition) => definition.id);
    const visibleSourceIds = workspaceDefinitions.filter((definition) => workspace.sourcePreferences[definition.id]?.enabled && workspace.sourcePreferences[definition.id]?.layerVisible).map((definition) => definition.id);
    const preset: HunterSavedView = { id, name, sourceIds, visibleSourceIds, map: { longitude: mapViewport.longitude, latitude: mapViewport.latitude, zoom: mapViewport.zoom }, timeWindowHours: Math.max(1, Math.round(Math.max(...workspaceDefinitions.map((definition) => workspace.sourcePreferences[definition.id]?.recentOnlyMinutes ?? 0), 60) / 60)), sourcePreferences: Object.fromEntries(workspaceDefinitions.map((definition) => [definition.id, { ...(workspace.sourcePreferences[definition.id] ?? definition.defaultSettings) }])) };
    setWorkspace({ ...workspace, activePresetId: id, customPresets: [...workspace.customPresets, preset].slice(-30) });
  }

  function duplicateWorkspacePreset(preset: HunterSavedView) {
    const duplicate = { ...preset, id: `${preset.id.replace(/-[a-z0-9]+$/i, "").slice(0, 60)}-copy-${Date.now().toString(36)}`, name: `${preset.name} Copy`.slice(0, 80), builtIn: false };
    setWorkspace({ ...workspace, activePresetId: duplicate.id, customPresets: [...workspace.customPresets, duplicate].slice(-30) });
  }

  function restoreWorkspaceDefaults() {
    const defaults = migrateHunterWorkspaceSettings(undefined, {}, workspaceDefinitions);
    setWorkspace({ ...defaults, customPresets: workspace.customPresets });
    void (async () => {
      for (const definition of workspaceDefinitions) for (const sourceId of definition.runtimeSourceIds) if (sourceById.get(sourceId)?.health.enabled) await configureSource(sourceId, { enabled: false });
    })().catch((restoreError) => notify({ tone: "error", title: "Defaults partially restored", message: restoreError instanceof Error ? restoreError.message : "One or more active connectors could not be disabled." }));
  }

  function zoomToDefinition(definition: HunterSeekerSourceDefinition) {
    const ids = new Set(definition.runtimeSourceIds.length ? definition.runtimeSourceIds : [definition.id]);
    const positions = observations.filter((observation) => ids.has(observation.provenance.sourceFeedId)).map((observation) => observation.position).filter((position) => Number.isFinite(position.latitude) && Number.isFinite(position.longitude));
    if (!positions.length) { notify({ tone: "info", title: "No positioned records", message: `${definition.name} has no visible positioned observations to zoom to.` }); return; }
    const latitudes = positions.map(({ latitude }) => latitude); const longitudes = positions.map(({ longitude }) => longitude);
    setMapFocus({ id: Date.now(), west: Math.min(...longitudes), east: Math.max(...longitudes), south: Math.min(...latitudes), north: Math.max(...latitudes) });
  }

  function commitSourcePreference(definition: HunterSeekerSourceDefinition, preference: (typeof workspace.sourcePreferences)[string], operational: { pollCadenceMs?: number; requestBudgetPercent?: number }) {
    const previous = workspace.sourcePreferences[definition.id] ?? definition.defaultSettings;
    const persistedPreference = { ...preference, refreshIntervalSeconds: Math.round((operational.pollCadenceMs ?? preference.refreshIntervalSeconds * 1000) / 1000), requestBudgetPercent: operational.requestBudgetPercent ?? preference.requestBudgetPercent };
    setWorkspace((current) => ({ ...current, activePresetId: null, sourcePreferences: { ...current.sourcePreferences, [definition.id]: persistedPreference } }));
    void (async () => {
      for (const sourceId of definition.runtimeSourceIds) {
        const update: { enabled?: boolean; pollCadenceMs?: number; requestBudgetPercent?: number } = { pollCadenceMs: operational.pollCadenceMs, requestBudgetPercent: operational.requestBudgetPercent };
        if (previous.enabled !== preference.enabled) update.enabled = preference.enabled;
        await configureSource(sourceId, update);
      }
    })().catch((settingsError) => notify({ tone: "error", title: "Source settings not applied", message: settingsError instanceof Error ? settingsError.message : `${definition.name} could not be updated.` }));
  }

  useEffect(() => {
    if (!snapshot?.running || automaticQueryRefreshInFlight.current) return;
    const now = Date.now();
    const due = (snapshot.sourceQueries ?? []).map((query) => {
      const definition = workspaceDefinitionBySourceId.get(query.sourceId);
      const preference = definition ? workspace.sourcePreferences[definition.id] ?? definition.defaultSettings : undefined;
      if (!definition || !preference?.enabled || !preference.automaticRefresh) return null;
      const minimum = definition.refreshConstraints?.minimumIntervalSeconds ?? 30;
      const selected = Math.max(minimum, preference.refreshIntervalSeconds);
      const trafficAdjusted = Math.ceil(selected * (100 / Math.max(10, preference.requestBudgetPercent)));
      return { sourceId: query.sourceId, dueAt: Date.parse(query.queriedAt) + trafficAdjusted * 1000 };
    }).filter((entry): entry is { sourceId: string; dueAt: number } => Boolean(entry)).sort((left, right) => left.dueAt - right.dueAt)[0];
    if (!due) return;
    const delay = Math.max(0, Math.min(30_000, due.dueAt - now));
    const timer = window.setTimeout(() => {
      if (automaticQueryRefreshInFlight.current || Date.now() < due.dueAt) return;
      automaticQueryRefreshInFlight.current = due.sourceId;
      void fetch(`/api/hunter-seeker/sources/${encodeURIComponent(due.sourceId)}/refresh`, { method: "POST", cache: "no-store" })
        .then(async (response) => { const data = await response.json() as HunterSeekerSnapshot & { error?: string }; if (!response.ok) throw new Error(data.error ?? `Could not refresh ${due.sourceId}.`); setSnapshot(data); })
        .catch((refreshError) => notify({ tone: "error", title: "Scheduled source refresh failed", message: refreshError instanceof Error ? refreshError.message : `Could not refresh ${due.sourceId}.` }))
        .finally(() => { automaticQueryRefreshInFlight.current = null; });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [snapshot, workspaceDefinitionBySourceId, workspace.sourcePreferences, notify]);

  const queryResult = queryResultsSourceId ? snapshot?.sourceQueries?.find((query) => query.sourceId === queryResultsSourceId) : undefined;
  const queryResultDefinition = queryResultsSourceId ? workspaceDefinitionBySourceId.get(queryResultsSourceId) : undefined;

  return <section className="phase-panel hunter-panel">
    <div className="phase-heading hunter-heading">
      <div className="hunter-summary">
        <article className={`hunter-stat freshness-${aggregateFreshness}`}><strong>{action === "starting" ? "LINKING" : freshnessLabel(aggregateFreshness)}</strong><small><OverflowMarquee text={`${visibleSources.filter((source) => sourceFreshnessById[source.descriptor.id] === "live").length} / ${visibleSources.length} SOURCES LIVE`} /></small></article>
        <article className="hunter-stat"><strong>{observations.length.toLocaleString()}</strong><small><OverflowMarquee text={`${((snapshot?.observationCount ?? 0) + (maritimeSnapshot?.observations.length ?? 0)).toLocaleString()} VOLATILE CONTACTS`} /></small></article>
        <article className="hunter-stat"><strong>{largestMagnitude === null ? "—" : largestMagnitude.toFixed(1)}</strong><small><OverflowMarquee text="PAST-DAY FEED MAX" /></small></article>
      </div>
      <div className="hunter-actions">
        <button className="local-only-action" onClick={() => { setSetupStep(0); setShowSetup(true); }}>SETTINGS / SETUP</button>
        <button className="local-only-action" onClick={() => setShowStageFive(true)}>TARGETS / REPLAY{snapshot?.stageFive?.unacknowledgedTriggerCount ? ` // ${snapshot.stageFive.unacknowledgedTriggerCount}` : ""}</button>
        {snapshot?.running
          ? <><button className="cancel-action" disabled={Boolean(action)} onClick={() => void runAction("stop")}>DISCONNECT</button><button className="primary-action" disabled={Boolean(action)} onClick={() => void runAction("refresh")}>{action === "refreshing" ? "REFRESHING..." : "REFRESH NOW"}</button></>
          : <button className="primary-action" disabled={Boolean(action)} onClick={() => void startAfterStop()}>{action === "starting" ? "LINKING..." : "LINK LIVE FEED"}</button>}
      </div>
    </div>

    {error && <div className="hunter-error"><strong>SOURCE LINK DEGRADED</strong><span>{error}</span></div>}

    {osintCandidates.length > 0 && <section className="hunter-osint-candidates" aria-label="OSINT candidate lead inbox">
      <header><div><span>DELIBERATE RETURN PATH</span><strong>OSINT CANDIDATE INBOX</strong></div><b>{osintCandidates.length} REVIEW REQUIRED</b></header>
      <div>{osintCandidates.map((candidate) => <article key={candidate.id}>
        <i>CANDIDATE</i><div><strong>{candidate.lead.seed.label ?? candidate.lead.seed.value}</strong><small>{candidate.lead.seed.type.toUpperCase()} // {candidate.providerId.toUpperCase()} // {candidate.lead.reason}</small><em>NO WATCHLIST // NO TRIGGER // NO PROVIDER REQUEST</em></div>
        <button onClick={() => void dismissOsintCandidate(candidate.id).catch((dismissError) => notify({ tone: "error", title: "Candidate not dismissed", message: dismissError instanceof Error ? dismissError.message : "The candidate could not be dismissed." }))}>DISMISS</button>
      </article>)}</div>
    </section>}

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
      })}
      </div>
    </section>}

    <div ref={hunterBoardRef} className={`hunter-board ${workspace.explorerCollapsed ? "explorer-collapsed" : ""} ${workspace.detailsOpen ? "details-open" : "details-closed"}`} style={{ "--hunter-explorer-width": `${workspace.explorerWidth}px`, "--hunter-events-width": `${workspace.eventsPaneWidth}px`, "--hunter-map-track": `${workspace.mapPanePercent}fr`, "--hunter-detail-track": `${100 - workspace.mapPanePercent}fr` } as React.CSSProperties}>
    <HunterSourceExplorer definitions={workspaceDefinitions} workspace={workspace} sourceState={explorerSourceState} activeAlertsCount={snapshot?.stageFive?.unacknowledgedTriggerCount ?? 0} lastCompleteRefresh={lastSuccessAt} onWorkspaceChange={setWorkspace} onToggleSources={toggleWorkspaceSources} onRefreshSources={refreshWorkspaceSources} onOpenSettings={(definition) => setSettingsSourceId(definition.id)} onQuerySource={openDefinitionQuery} onApplyPreset={applyWorkspacePreset} onSavePreset={saveWorkspacePreset} onDeletePreset={(id) => setWorkspace({ ...workspace, activePresetId: workspace.activePresetId === id ? null : workspace.activePresetId, customPresets: workspace.customPresets.filter((preset) => preset.id !== id) })} onRenamePreset={(id, name) => setWorkspace({ ...workspace, customPresets: workspace.customPresets.map((preset) => preset.id === id ? { ...preset, name: name.slice(0, 80) } : preset) })} onDuplicatePreset={duplicateWorkspacePreset} onRestoreDefaults={restoreWorkspaceDefaults} onImportPreset={(preset) => setWorkspace(migrateHunterWorkspaceSettings({ ...workspace, customPresets: [...workspace.customPresets, preset] }, settings.hunterSourceSettings, workspaceDefinitions))} onImportError={(message) => notify({ tone: "error", title: "Saved view import failed", message })} />
    {workspace.detailsOpen && <div className="hunter-layout-splitter hunter-layout-splitter-vertical" role="separator" aria-label="Resize recent events panel" aria-orientation="vertical" aria-valuemin={280} aria-valuemax={720} aria-valuenow={Math.round(workspace.eventsPaneWidth)} tabIndex={0} onKeyDown={(event) => resizeHunterLayoutWithKeyboard("events", event)} onPointerDown={(event) => beginHunterLayoutResize("events", event)} onPointerMove={moveHunterLayoutResize} onPointerUp={endHunterLayoutResize} onPointerCancel={endHunterLayoutResize}><span /></div>}

    <div className="hunter-workspace">
      <section className="hunter-map-shell">
        <header><div><span>GLOBAL PROJECTION {"//"} WGS84</span><strong>{replay ? "OFFLINE REPLAY MAP" : "LIVE CONTACT MAP"}</strong></div><nav className="hunter-freshness-legend" aria-label="Contact freshness legend"><span className="freshness-live">LIVE</span><span className="freshness-cached">CACHED</span><span className="freshness-stale">STALE</span><span className="freshness-degraded">DEGRADED</span></nav><div className="hunter-map-header-actions"><button aria-controls="hunter-contact-register" aria-expanded={workspace.detailsOpen} onClick={() => setWorkspace({ ...workspace, detailsOpen: !workspace.detailsOpen })}>{workspace.detailsOpen ? "HIDE CONTACTS" : "SHOW CONTACTS"}</button><small>{replay ? "REPLAY // 0 API CALLS" : snapshot?.running ? "LIVE LINK" : "LINK CLOSED"}</small></div></header>
        <div className="hunter-map" aria-label={`Interactive world map showing ${observations.length} ${replay ? "recorded" : "live"} events`}>
          <div className="hunter-map-data-search"><label><span className="sr-only">Search loaded map data</span><input value={mapDataSearch} onChange={(event) => setMapDataSearch(event.currentTarget.value)} placeholder="SEARCH MAP DATA" type="search" /></label>{mapSearchResults.length > 0 && <div>{mapSearchResults.map((observation) => <button key={observation.observationId} onClick={() => { selectObservation(observation.observationId); setMapDataSearch(""); setMapFocus({ id: Date.now(), west: observation.position.longitude - 1, east: observation.position.longitude + 1, south: observation.position.latitude - 1, north: observation.position.latitude + 1 }); }}><strong>{observationTitle(observation)}</strong><small>{observation.provenance.sourceFeedId} // {formatCoordinates(observation)}</small></button>)}</div>}</div>
          <HunterLayerControl definitions={workspaceDefinitions} workspace={workspace} sourceState={explorerSourceState} onWorkspaceChange={setWorkspace} onRefresh={(definition) => refreshWorkspaceSources([definition])} onOpenSettings={(definition) => setSettingsSourceId(definition.id)} onZoom={zoomToDefinition} />
          <HunterDynamicLegend definitions={workspaceDefinitions} workspace={workspace} onWorkspaceChange={setWorkspace} />
          <Suspense fallback={<div className="hunter-map-empty"><span>INITIALIZING MAP</span><small>Loading the isolated geospatial renderer.</small></div>}><HunterSeekerMap observations={mapObservations} freshnessByObservationId={observationFreshnessById} selectedId={selected?.observationId ?? null} overlays={visibleMapOverlays} focusRequest={mapFocus} displayBySource={mapDisplayBySource} onSelect={selectObservation} onDeflockRegionSelect={(regionId, regionLabel) => void loadDeflockRegion(regionId, regionLabel)} onPublicWebcamRegionSelect={(regionId, regionLabel, sourceId) => void (sourceId === WINDY_WEBCAM_SOURCE_ID ? loadWindyWebcamRegion(regionId, regionLabel) : loadPublicWebcamRegion(regionId, regionLabel))} onContextMenu={setContextMenu} onViewportChange={setMapViewport} /></Suspense>
          {!observations.length && <div className="hunter-map-empty"><span>{action === "starting" ? "ACQUIRING SIGNAL" : "NO LIVE CONTACTS"}</span><small>{snapshot?.running ? "Waiting for the source feed." : "Link the feed to begin."}</small></div>}
          {activeWebcam && activeWebcamPlayerUrl && !cameraExpanded && <section className="hunter-webcam-player" aria-label={`Public webcam player: ${observationTitle(activeWebcam)}`}>
            <header><div><span>{activeWebcam.provenance.sourceFeedId === WINDY_WEBCAM_SOURCE_ID ? `WINDY WEBCAM // ${(textAttribute(activeWebcam, "playerMode") ?? "PROVIDER PLAYER").toUpperCase()}` : "VERIFIED ACTIVE BROADCAST // YOUTUBE LIVE"}</span><strong>{observationTitle(activeWebcam)}</strong><small>{activeWebcam.provenance.sourceFeedId === WINDY_WEBCAM_SOURCE_ID ? [textAttribute(activeWebcam, "city"), textAttribute(activeWebcam, "region"), textAttribute(activeWebcam, "country")].filter(Boolean).join(" // ") : textAttribute(activeWebcam, "channelTitle") || "PUBLIC CAMERA BROADCAST"}</small></div><nav><button type="button" aria-label="Enlarge camera in tactical display" title="Enlarge camera" onClick={() => setCameraExpanded(true)}>FULL</button><button type="button" aria-label="Close public webcam video and return to map" onClick={() => { setCameraExpanded(false); setActiveWebcamId(null); }}>×</button></nav></header>
            <iframe title={`Public live video: ${observationTitle(activeWebcam)}`} src={activeWebcamPlayerUrl} allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation allow-popups" />
            <footer>{activeWebcam.provenance.sourceFeedId === WINDY_WEBCAM_SOURCE_ID ? <><span>PROVIDER PLAYER // MAY BE LIVE, REFRESHED IMAGE, OR TIMELAPSE</span><span>WEBCAMS PROVIDED BY <a href="https://www.windy.com/" target="_blank" rel="noopener noreferrer">WINDY.COM ↗</a></span></> : <><span>CONTINUOUS LIVE VIDEO // AVAILABILITY CONTROLLED BY BROADCASTER</span><span>POWERED BY <a href="https://www.youtube.com/" target="_blank" rel="noopener noreferrer">YOUTUBE ↗</a></span></>}</footer>
          </section>}
        </div>
          <footer><span>DISPLAYING {mapObservations.length.toLocaleString()} / {observations.length.toLocaleString()} {replay ? "REPLAY" : "VISIBLE"} CONTACTS</span><span aria-label="Map attribution" className="hunter-map-credit"><a href="https://openfreemap.org/" target="_blank" rel="noreferrer">OPENFREEMAP</a> © <a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">OPENMAPTILES</a> DATA FROM <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OPENSTREETMAP</a></span><span>{replay ? replay.label : `LAST SYNC ${formatTime(lastSuccessAt)}`}</span></footer>
      </section>

      {workspace.detailsOpen && <section id="hunter-contact-register" className="hunter-event-deck">
        <header><div><span>CONTACT REGISTER</span><strong>RECENT EVENTS</strong></div><div className="hunter-event-header-actions"><small>{visibleSources.map((source) => source.descriptor.category.toUpperCase()).join(" + ") || "NO LAYERS"}</small><button type="button" aria-label="Collapse contact register" onClick={() => setWorkspace({ ...workspace, detailsOpen: false })}>COLLAPSE</button></div></header>
        <div className="hunter-event-list">
          {observations.slice(0, 250).map((observation, index) => {
            const isWeather = observation.provenance.sourceFeedId === NWS_SOURCE_ID;
            const isAviation = observation.entityType.includes("aircraft");
            const isMilitaryAviation = observation.provenance.sourceFeedId === ADSB_LOL_MILITARY_SOURCE_ID;
            const isSpace = observation.provenance.sourceFeedId === CELESTRAK_STATIONS_SOURCE_ID;
            const isMaritime = observation.provenance.sourceFeedId === AISSTREAM_MARITIME_SOURCE_ID;
            const isCamera = observation.provenance.sourceFeedId === DEFLOCK_ALPR_SOURCE_ID;
            const isPublicWebcam = isWebcamSource(observation.provenance.sourceFeedId);
            const freshness = observationFreshnessById[observation.observationId] ?? "degraded";
            return <button className={`${observation.observationId === selected?.observationId ? "selected" : ""} freshness-${freshness}`} key={observation.observationId} onClick={() => selectObservation(observation.observationId)}>
              <span>{String(index + 1).padStart(3, "0")}</span><b className={isWeather ? "weather-badge" : isMilitaryAviation ? "military-aircraft-badge" : isAviation ? "civilian-aircraft-badge" : isSpace ? "space-station-badge" : isMaritime ? "maritime-vessel-badge" : isCamera ? "alpr-camera-badge" : isPublicWebcam ? "public-webcam-badge" : ""}>{contactBadge(observation)}</b><div><strong>{observationTitle(observation)}</strong><small>{sourceLabel(observation)} {"//"} {formatCoordinates(observation)} {"//"} {formatTime(observation.timestamp)}</small></div><em className={`hunter-freshness-badge freshness-${freshness}`}>{freshnessLabel(freshness)}</em>
            </button>;
          })}
          {!observations.length && <div className="hunter-list-empty">CONTACT REGISTER EMPTY</div>}
        </div>
      </section>}
    </div>

    {selected && <div className="hunter-layout-splitter hunter-layout-splitter-horizontal" role="separator" aria-label="Resize map and selected contact panels" aria-orientation="horizontal" aria-valuemin={35} aria-valuemax={78} aria-valuenow={Math.round(workspace.mapPanePercent)} tabIndex={0} onKeyDown={(event) => resizeHunterLayoutWithKeyboard("map", event)} onPointerDown={(event) => beginHunterLayoutResize("map", event)} onPointerMove={moveHunterLayoutResize} onPointerUp={endHunterLayoutResize} onPointerCancel={endHunterLayoutResize}><span /></div>}

    {cameraExpanded && activeWebcam && activeWebcamPlayerUrl && <div className="hunter-camera-popup-backdrop" role="presentation">
      <section className="hunter-camera-popup" ref={cameraPopupRef} role="dialog" aria-modal="true" aria-label={`Enlarged tactical camera display: ${observationTitle(activeWebcam)}`}>
        <header>
          <div><span>MAGI OPTICAL CHANNEL // EXTERNAL VISUAL LINK</span><strong>{observationTitle(activeWebcam)}</strong><small>{activeWebcam.provenance.sourceFeedId === WINDY_WEBCAM_SOURCE_ID ? `WINDY // ${(textAttribute(activeWebcam, "playerMode") ?? "PROVIDER PLAYER").toUpperCase()}` : `YOUTUBE LIVE // ${textAttribute(activeWebcam, "channelTitle") || "PUBLIC BROADCAST"}`}</small></div>
          <aside><b>VISUAL LINK</b><button type="button" aria-label="Toggle true fullscreen camera display" title="Toggle fullscreen" onClick={() => void toggleCameraFullscreen()}>FULLSCREEN</button><button type="button" aria-label="Close enlarged camera display" title="Return to map player" onClick={() => setCameraExpanded(false)}>×</button></aside>
        </header>
        <div className="hunter-camera-popup-screen">
          <div className="hunter-camera-hud" aria-hidden="true"><span>OPTICAL FEED</span><i>LIVE</i><b>VC-HS // WGS84</b></div>
          <iframe title={`Enlarged public live video: ${observationTitle(activeWebcam)}`} src={activeWebcamPlayerUrl} allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation allow-popups" />
        </div>
        <footer><span>PASSIVE PUBLIC SOURCE // NO CAMERA CONTROL</span><strong>{activeWebcam.provenance.sourceFeedId === WINDY_WEBCAM_SOURCE_ID ? "PROVIDER MODE MAY BE LIVE, IMAGE, OR TIMELAPSE" : "CONTINUOUS STREAM SUBJECT TO BROADCASTER AVAILABILITY"}</strong><span>CLOSE RETURNS TO MAP</span></footer>
      </section>
    </div>}

    {selected && (() => {
      const isWeather = selected.provenance.sourceFeedId === NWS_SOURCE_ID;
      const isAviation = selected.entityType.includes("aircraft");
      const isMilitaryAviation = selected.provenance.sourceFeedId === ADSB_LOL_MILITARY_SOURCE_ID;
      const isOpenSkyAviation = selected.provenance.sourceFeedId === OPENSKY_CIVIL_AIRCRAFT_SOURCE_ID;
      const isSpace = selected.provenance.sourceFeedId === CELESTRAK_STATIONS_SOURCE_ID;
      const isMaritime = selected.provenance.sourceFeedId === AISSTREAM_MARITIME_SOURCE_ID;
      const isCamera = selected.provenance.sourceFeedId === DEFLOCK_ALPR_SOURCE_ID;
      const isPublicWebcam = isWebcamSource(selected.provenance.sourceFeedId);
      const selectedFreshness = observationFreshnessById[selected.observationId] ?? "degraded";
      const selectedKind = isWeather ? "weather" : isMilitaryAviation ? "military-aviation" : isAviation ? "civilian-aviation" : isSpace ? "space" : isMaritime ? "maritime" : isCamera || isPublicWebcam ? "infrastructure" : "seismic";
      const sourceType = (textAttribute(selected, "sourceType") ?? "broadcast").replaceAll("_", " ");
      return <article className={`hunter-contact-detail contact-${selectedKind}`}>
        <header><div><span>SELECTED CONTACT {"//"} {selected.entityId}</span><strong>{observationTitle(selected)}</strong></div><b>{contactBadge(selected)}</b></header>
        <dl><div><dt>{isWeather ? "PROVIDER CENTROID" : isSpace ? "SUBPOINT" : "POSITION"}</dt><dd>{formatCoordinates(selected)}</dd></div><div><dt>{isWeather ? "EXPIRES" : isAviation || isSpace ? "ALTITUDE" : isMaritime ? "SPEED" : isCamera ? "CAMERA TYPE" : "DEPTH"}</dt><dd>{isWeather ? formatTime(textAttribute(selected, "expiresAt") ?? undefined) : isAviation ? aircraftAltitude(selected) : isSpace ? `${Math.round((selected.position.altitudeMeters ?? 0) / 1_000).toLocaleString()} KM` : isMaritime ? `${numberAttribute(selected, "speedOverGroundKnots")?.toFixed(1) ?? "—"} KT` : isCamera ? "ALPR" : `${numberAttribute(selected, "depthKm")?.toFixed(1) ?? "—"} KM`}</dd></div><div><dt>{isWeather ? "EFFECTIVE" : isAviation || isMaritime ? "LAST POSITION" : isSpace ? "PROPAGATED" : isCamera ? "OSM RECORD" : "DETECTED"}</dt><dd>{formatTime(selected.timestamp)}</dd></div><div><dt>{isWeather ? "CERTAINTY" : isAviation ? "POSITION SOURCE" : isSpace ? "ORBIT MODEL" : isMaritime ? "AIS COURSE" : isCamera ? "MANUFACTURER" : "CONFIDENCE"}</dt><dd>{isMaritime ? `${numberAttribute(selected, "courseOverGroundDegrees")?.toFixed(1) ?? "—"} DEG` : isSpace ? `${Math.round(selected.confidence * 100)}% SGP4` : isCamera ? (textAttribute(selected, "manufacturer") ?? "UNKNOWN").toUpperCase() : `${Math.round(selected.confidence * 100)}% ${(isAviation ? sourceType : textAttribute(selected, isWeather ? "certainty" : "reviewStatus") ?? (isWeather ? "unknown" : "unreviewed")).toUpperCase()}`}</dd></div><div><dt>{isSpace ? "ELEMENT SET AGE" : "STALENESS AT RECEIPT"}</dt><dd>{formatDuration(selected.provenance.stalenessMs)}</dd></div></dl>
        <div className="hunter-detail-freshness"><span>FRESHNESS</span><strong className={`hunter-freshness-badge freshness-${selectedFreshness}`}>{freshnessLabel(selectedFreshness)}</strong><small>{formatRelativeTime(selected.provenance.fetchedAt, generatedAtMs, "UNKNOWN")}</small></div>
        {isWeather && textAttribute(selected, "description") && <p className="hunter-alert-description">{textAttribute(selected, "description")}</p>}
        {isAviation && <p className="hunter-alert-description hunter-aircraft-description">{aircraftSummary(selected)}</p>}
        {isSpace && <p className="hunter-alert-description hunter-space-description">{stationSummary(selected)}</p>}
        {isMaritime && <p className="hunter-alert-description hunter-maritime-description">{vesselSummary(selected)}</p>}
        {isCamera && <p className="hunter-alert-description hunter-camera-description">{cameraSummary(selected)}</p>}
        {isPublicWebcam && <p className="hunter-alert-description hunter-camera-description">{[textAttribute(selected, "city"), textAttribute(selected, "region"), textAttribute(selected, "country")].filter(Boolean).join(" // ") || "Public webcam location metadata is limited."} // LIVE PLAYER AVAILABLE.</p>}
        <footer><span>SOURCE: {isWeather ? "NOAA / NATIONAL WEATHER SERVICE" : isOpenSkyAviation ? "OPENSKY NETWORK" : isAviation ? "ADSB.LOL" : isSpace ? "CELESTRAK" : isMaritime ? "AISSTREAM.IO" : isCamera ? "DEFLOCK / OPENSTREETMAP" : "U.S. GEOLOGICAL SURVEY"}</span>{textAttribute(selected, "eventUrl") && <a href={textAttribute(selected, "eventUrl")!} target="_blank" rel="noreferrer">OPEN {isWeather ? "NWS ALERT" : isAviation ? "AIRCRAFT" : isSpace ? "ORBIT DATA" : isMaritime ? "AIS COVERAGE" : isCamera ? "OSM CAMERA RECORD" : "USGS EVENT"} ↗</a>}</footer>
      </article>;
    })()}
    </div>

    <section className={`hunter-history-console ${snapshot?.history?.enabled ? "active" : ""} ${historyExpanded ? "expanded" : ""}`} aria-label="Historical observations and historical RAG">
      <header><div><span>CONTROLLED PERSISTENCE</span><strong>HISTORY / WHAT CHANGED?</strong></div><b>{snapshot?.history?.enabled ? "HISTORICAL ON" : "OPT-IN OFF"}</b></header>
      <div className="hunter-history-controls">
        <button className={snapshot?.history?.enabled ? "cancel-action" : "primary-action"} disabled={historyBusy} onClick={() => void saveHistorySettings({ enabled: !settings.hunterHistory.enabled })}>{snapshot?.history?.enabled ? "PAUSE RECORDING" : "ENABLE RECORDING"}</button>
        <label className="hunter-history-retention"><span>RETENTION</span><select aria-label="Historical retention period" disabled={!snapshot?.history?.enabled || historyBusy} value={settings.hunterHistory.retentionDays} onChange={(event) => void saveHistorySettings({ retentionDays: Number(event.target.value) })}>{[30, 60, 90, 180, 365].map((days) => <option key={days} value={days}>{days} DAYS</option>)}</select></label>
        <label className="hunter-history-query"><span>HISTORICAL QUESTION</span><input aria-label="Historical question" disabled={!snapshot?.history?.initialized || historyBusy} value={historyQuestion} onChange={(event) => setHistoryQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void askHistory(); }} placeholder="What changed in the Gulf today?" /></label>
        <button className="local-only-action" disabled={!snapshot?.history?.initialized || historyBusy || !historyQuestion.trim()} onClick={() => void askHistory()}>{historyBusy ? "WORKING..." : "QUERY HISTORY"}</button>
        <button className="hunter-history-expand" aria-expanded={historyExpanded} aria-controls="hunter-history-expanded" onClick={() => setHistoryExpanded((current) => !current)}>{historyExpanded ? "CLOSE" : `DETAILS${historyResults.length ? ` // ${historyResults.length}` : ""}`}</button>
      </div>
      {historyExpanded && <div className="hunter-history-expanded" id="hunter-history-expanded">
        <div className="hunter-history-libraries"><span>CROSS-REFERENCE LIBRARIES</span>{ragFolders.filter((folder) => folder.enabled).map((folder) => <label key={folder.id}><input type="checkbox" checked={settings.hunterHistory.selectedLibraryIds.includes(folder.id)} onChange={(event) => void saveHistorySettings({ selectedLibraryIds: event.target.checked ? [...settings.hunterHistory.selectedLibraryIds, folder.id] : settings.hunterHistory.selectedLibraryIds.filter((id) => id !== folder.id) })} />{folder.name}</label>)}<label><input type="checkbox" checked={settings.hunterHistory.includeUploads} onChange={(event) => void saveHistorySettings({ includeUploads: event.target.checked })} />UPLOADED FILES</label></div>
        <div className="hunter-history-status"><span>LIVE data is volatile</span><span>HISTORICAL data is opt-in</span><span>{(((snapshot?.history?.databaseBytes ?? 0) + (snapshot?.history?.walBytes ?? 0)) / 1024 ** 2).toFixed(1)} MiB</span><span>{snapshot?.history?.summaryCount ?? 0} summaries / {snapshot?.history?.derivedCount ?? 0} derived</span>{historyMaintenance && <b>{historyMaintenance}</b>}<button disabled={!snapshot?.history?.initialized || historyBusy} onClick={() => void planHistoryMaintenance(false)}>DRY PLAN</button><button disabled={!snapshot?.history?.initialized || historyBusy} onClick={() => void planHistoryMaintenance(true)}>DOWNSAMPLE</button>{snapshot?.history?.error && <em>{snapshot.history.error}</em>}</div>
        {historyResults.length > 0 && <div className="hunter-history-results">{historyResults.map((result) => <article key={`${result.type}:${result.id}`}><b>{result.type === "history" ? "HISTORICAL" : "LIBRARY"}</b><strong>{result.type === "history" ? result.title : result.documentName}</strong><p>{result.content}</p><small>{result.type === "history" ? `${result.windowStart} — ${result.windowEnd} // OBS ${result.sourceObservationIds.slice(0, 3).join(", ")}` : result.citation} // SCORE {result.score.toFixed(3)}</small></article>)}</div>}
      </div>}
    </section>

    {contextMenu && <div className="hunter-map-context-menu" style={{ left: Math.max(8, Math.min(contextMenu.clientX, window.innerWidth - 250)), top: Math.max(40, Math.min(contextMenu.clientY, window.innerHeight - 270)) }} onContextMenu={(event) => event.preventDefault()}>
      <header><span>{contextMenu.observationId ? "CONTACT ACTIONS" : "REGION ACTIONS"}</span><button onClick={() => setContextMenu(null)}>×</button></header>
      <button disabled={!onInvestigateOsint} onClick={() => void investigateContextInOsint()}>INVESTIGATE IN OSINT</button>
      <button onClick={() => void runContextResearch("search")}>SEARCH WEB</button>
      <button onClick={() => void runContextResearch("research")}>PULL INFO / RESEARCH</button>
      <button disabled={!onAnalyzeObservation} onClick={analyzeContext}>ANALYZE WITH ACTIVE UNIT</button>
      {contextMenu.observationId && <button onClick={() => void addContextWatch(false)}>WATCH CONTACT</button>}
      <button onClick={() => void addContextWatch(true)}>WATCH 25 KM REGION</button>
      <small>{contextMenu.latitude.toFixed(4)}, {contextMenu.longitude.toFixed(4)} // EXTERNAL ACTIONS REQUIRE THIS CLICK</small>
    </div>}
    {research && <div className="hunter-research-backdrop" role="presentation" onMouseDown={() => setResearch(null)}><section className="hunter-research-dialog" role="dialog" aria-modal="true" aria-label={research.title} onMouseDown={(event) => event.stopPropagation()}><header><div><span>OPERATOR-INITIATED EXTERNAL RESEARCH</span><strong>{research.title}</strong><small>{research.query}</small></div><button onClick={() => setResearch(null)}>×</button></header><div className="hunter-research-results">{research.loading ? <p>ACQUIRING AND CLEANING EVIDENCE...</p> : research.results.map((result, index) => <article key={result.id ?? `${result.title}:${index}`}><b>{String(index + 1).padStart(2, "0")}</b><div><strong>{result.title}</strong><p>{result.evidence ?? result.snippet ?? result.content?.slice(0, 700) ?? "No excerpt returned."}</p>{result.url && <a href={result.url} target="_blank" rel="noreferrer">OPEN SOURCE ↗</a>}</div></article>)}{!research.loading && !research.results.length && <p>NO RESEARCH RESULTS RETURNED</p>}</div></section></div>}
    {showStageFive && <HunterStageFivePanel sourceIds={sources.filter((source) => source.health.enabled).map((source) => source.descriptor.id)} onClose={() => setShowStageFive(false)} onReplayExit={() => { setReplay(null); setSelectedId(liveObservations[0]?.observationId ?? null); }} onReplayLoaded={(values, manifest) => { const recorded = values as PublicObservation[]; setReplay({ observations: recorded, label: manifest.label, id: manifest.id }); setSelectedId(recorded[0]?.observationId ?? null); setShowStageFive(false); }} />}
    {setupVisible && <HunterSeekerSetupGuide
      step={visibleSetupStep}
      maritimeCredentialSaved={maritimeCredentialSaved}
      maritimeCredentialFingerprint={maritimeCredentialFingerprint}
      activePublicSources={sources.filter((source) => source.descriptor.id !== AISSTREAM_MARITIME_SOURCE_ID && source.health.enabled).length}
      skippedPublicSources={sources.filter((source) => source.descriptor.id !== AISSTREAM_MARITIME_SOURCE_ID && !source.health.enabled).length}
      onClose={() => {
        setSetupAutoDismissed(true);
        setShowSetup(false);
        onSetupRequestHandled?.();
        if (!settings.hunterSetupCompleted) void onSaveSettings({ hunterSetupCompleted: true, hunterSetupStep: visibleSetupStep }).catch((saveError) => {
          notify({ tone: "error", title: "Setup state not saved", message: saveError instanceof Error ? saveError.message : "The first-run guide may appear again." });
        });
      }}
      onSkip={async () => {
        setSetupAutoDismissed(true);
        onSetupRequestHandled?.();
        await onSaveSettings({ hunterSetupCompleted: true, hunterSetupStep: visibleSetupStep });
        setShowSetup(false);
      }}
      onStep={async (nextStep) => {
        onSetupRequestHandled?.();
        setSetupStep(nextStep);
        setShowSetup(true);
        await onSaveSettings({ hunterSetupStep: nextStep });
      }}
      onComplete={async () => {
        setSetupAutoDismissed(true);
        onSetupRequestHandled?.();
        setSetupStep(4);
        await onSaveSettings({ hunterSetupCompleted: true, hunterSetupStep: 4 });
        setShowSetup(false);
      }}
      onConfigureMaritime={() => {
        setSetupAutoDismissed(true);
        onSetupRequestHandled?.();
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
    {showWebcamSetup && <PublicWebcamCredentialModal onCancel={() => setShowWebcamSetup(false)} onSubmit={async (credential) => {
      if (!window.voidcatDesktop?.webcams || window.voidcatDesktop.bridgeVersion < 9) throw new Error("Close VoidCat Harness completely and reopen it once to activate protected webcam credentials.");
      const status = await window.voidcatDesktop.webcams.configure(credential);
      setWebcamStatus(status);
      setShowWebcamSetup(false);
      await configureSource(PUBLIC_WEBCAM_SOURCE_ID, { enabled: true });
      notify({ tone: "success", title: "Public live-video link secured", message: `YouTube accepted the key. Protected fingerprint ${status.fingerprint ?? "SAVED"}; only sectors confirmed by the bounded live discovery sample are shown.` });
    }} />}
    {showWindyWebcamSetup && <WindyWebcamCredentialModal onCancel={() => setShowWindyWebcamSetup(false)} onSubmit={async (credential) => {
      if (!window.voidcatDesktop?.windyWebcams || window.voidcatDesktop.bridgeVersion < 8) throw new Error("Close VoidCat Harness completely and reopen it once to activate protected Windy webcam credentials.");
      const status = await window.voidcatDesktop.windyWebcams.configure(credential);
      setWindyWebcamStatus(status);
      setShowWindyWebcamSetup(false);
      await configureSource(WINDY_WEBCAM_SOURCE_ID, { enabled: true });
      notify({ tone: "success", title: "Windy webcam link restored", message: `Windy accepted the key. Protected fingerprint ${status.fingerprint ?? "SAVED"}; select a WINDY camera hub to load that sector independently.` });
    }} />}
    {activeSettingsDefinition && <HunterSourceSettingsDialog
      definition={activeSettingsDefinition}
      preference={workspace.sourcePreferences[activeSettingsDefinition.id] ?? activeSettingsDefinition.defaultSettings}
      state={explorerSourceState[activeSettingsDefinition.id] ?? { status: "offline", statusText: "OFFLINE", observationCount: 0 }}
      refreshIntervalMs={activeSettingsDefinition.runtimeSourceIds.map((id) => sourceById.get(id)?.health.pollCadenceMs).find((value): value is number => typeof value === "number")}
      requestBudgetPercent={activeSettingsDefinition.runtimeSourceIds.map((id) => sourceById.get(id)?.health.requestBudgetPercent).find((value): value is number => typeof value === "number")}
      onClose={() => setSettingsSourceId(null)}
      onApply={(preference, operational) => commitSourcePreference(activeSettingsDefinition, preference, operational)}
      onConfigureCredential={() => configureDefinitionCredential(activeSettingsDefinition)}
      onQuery={snapshot?.sourceQueryCapabilities?.some((capability) => capability.sourceId === (catalogEntryFor(activeSettingsDefinition)?.id ?? activeSettingsDefinition.id)) ? () => { setSettingsSourceId(null); openDefinitionQuery(activeSettingsDefinition); } : undefined}
      onTest={() => testDefinitionCredential(activeSettingsDefinition)}
      onRemoveCredential={activeSettingsDefinition.capabilities.supportsCredentials ? () => removeDefinitionCredential(activeSettingsDefinition) : undefined}
      onReset={() => {
        setWorkspace({ ...workspace, activePresetId: null, sourcePreferences: { ...workspace.sourcePreferences, [activeSettingsDefinition.id]: activeSettingsDefinition.defaultSettings } });
        setSettingsSourceId(null);
      }}
      onSave={(preference, operational) => {
        commitSourcePreference(activeSettingsDefinition, preference, operational);
        setSettingsSourceId(null);
      }}
    />}
    {querySource && snapshot?.sourceQueryCapabilities?.find((item) => item.sourceId === querySource.id) && <HunterSourceQueryModal source={querySource} capability={snapshot.sourceQueryCapabilities.find((item) => item.sourceId === querySource.id)!} viewport={mapViewport} onClose={() => { setQuerySource(null); setQueryEnableSourceId(null); }} onComplete={completeDefinitionQuery} />}
    {queryResult?.references?.length && <div className="hunter-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setQueryResultsSourceId(null); }}>
      <section className="hunter-query-results-dialog" role="dialog" aria-modal="true" aria-labelledby="hunter-query-results-title">
        <header><div><span>BOUNDED SOURCE RESULTS // {queryResult.cache.status.toUpperCase()}</span><strong id="hunter-query-results-title">{queryResultDefinition?.name ?? queryResult.sourceId}</strong><small>{queryResult.references.length} REFERENCES // QUERIED {new Date(queryResult.queriedAt).toLocaleString()}</small></div><button aria-label="Close source results" onClick={() => setQueryResultsSourceId(null)}>X</button></header>
        <div className="hunter-query-results-list">{queryResult.references.map((reference) => <article key={reference.id}><div><strong>{reference.title}</strong><span>{reference.publishedAt ? new Date(reference.publishedAt).toLocaleString() : "PUBLICATION TIME UNAVAILABLE"}</span></div>{reference.description && <p>{reference.description}</p>}<footer><small>{reference.license}</small><a href={reference.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${reference.title} in a new window`}>OPEN EVIDENCE -&gt;</a></footer></article>)}</div>
        {queryResult.coverageLimitation && <p className="hunter-query-coverage"><strong>COVERAGE LIMITATION</strong>{queryResult.coverageLimitation}</p>}
        <footer><button onClick={() => setQueryResultsSourceId(null)}>CLOSE</button>{queryResultDefinition && <button className="primary-action" onClick={() => { setQueryResultsSourceId(null); openDefinitionQuery(queryResultDefinition); }}>NEW BOUNDED QUERY</button>}</footer>
      </section>
    </div>}
  </section>;
}
