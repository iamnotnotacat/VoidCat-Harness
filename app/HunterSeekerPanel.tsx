import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNotifications } from "./NotificationCenter";
import type { HunterSeekerObservation as PublicObservation } from "./hunter-seeker-map-data";

type SourceSnapshot = {
  descriptor: {
    id: string;
    displayName: string;
    category: string;
    authTier: string;
    pollCadenceMs: number;
    providerDocsUrl: string;
  };
  health: {
    status: string;
    enabled: boolean;
    pollCadenceMs: number;
    message?: string;
    lastAttemptAt?: string;
    lastSuccessAt?: string;
    nextAllowedAt?: string;
    cachedObservations: number;
    hourlyRequests: number;
  };
};

type HunterSeekerSnapshot = {
  running: boolean;
  generatedAt: string;
  retention: "memory-only";
  sources: SourceSnapshot[];
  observationCount: number;
  observations: PublicObservation[];
  refreshResults?: Array<{ status: string; reason?: string; observations: number; error?: string }>;
};

const NWS_SOURCE_ID = "noaa.nws-alerts";
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

function observationTitle(observation: PublicObservation) {
  return textAttribute(observation, "title")
    ?? textAttribute(observation, "event")
    ?? textAttribute(observation, "headline")
    ?? textAttribute(observation, "place")
    ?? textAttribute(observation, "areaDescription")
    ?? "UNLOCATED EVENT";
}

function contactBadge(observation: PublicObservation) {
  const magnitude = numberAttribute(observation, "magnitude");
  if (magnitude !== null) return `M ${magnitude.toFixed(1)}`;
  return textAttribute(observation, "severity")?.toUpperCase() ?? "WEATHER";
}

function statusRank(status: string) {
  return ({ down: 6, degraded: 5, "rate-limited": 4, idle: 3, stopped: 2, disabled: 1, healthy: 0 } as Record<string, number>)[status] ?? 5;
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

export function HunterSeekerPanel() {
  const { notify } = useNotifications();
  const [snapshot, setSnapshot] = useState<HunterSeekerSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rateDrafts, setRateDrafts] = useState<Record<string, number>>({});
  const committedRates = useRef<Record<string, number>>({});
  const [busySources, setBusySources] = useState<string[]>([]);
  const [action, setAction] = useState<"starting" | "refreshing" | "stopping" | null>("starting");
  const [error, setError] = useState<string | null>(null);

  const loadSnapshot = useCallback(async (path = "/api/hunter-seeker/status", method: "GET" | "POST" = "GET") => {
    const response = await fetch(path, { method, cache: "no-store" });
    const data = await response.json() as HunterSeekerSnapshot & { error?: string };
    if (!response.ok) throw new Error(data.error ?? "Hunter-Seeker local service did not respond.");
    setSnapshot(data);
    const serverRates = Object.fromEntries(data.sources.map((source) => [source.descriptor.id, source.health.pollCadenceMs]));
    committedRates.current = serverRates;
    setRateDrafts(serverRates);
    setSelectedId((current) => current && data.observations.some((observation) => observation.observationId === current)
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

  const activeSourceIds = useMemo(() => snapshot?.sources.filter((source) => source.health.enabled).map((source) => source.descriptor.id) ?? [], [snapshot?.sources]);
  const observations = useMemo(() => (snapshot?.observations ?? []).filter((observation) => activeSourceIds.includes(observation.provenance.sourceFeedId)), [snapshot?.observations, activeSourceIds]);
  const visibleSources = useMemo(() => (snapshot?.sources ?? []).filter((source) => activeSourceIds.includes(source.descriptor.id)), [snapshot?.sources, activeSourceIds]);
  const aggregateSource = [...visibleSources].sort((left, right) => statusRank(right.health.status) - statusRank(left.health.status))[0];
  const aggregateStatus = aggregateSource?.health.status ?? "stopped";
  const lastSuccessAt = visibleSources.map((source) => source.health.lastSuccessAt).filter((value): value is string => Boolean(value)).sort().at(-1);
  const selected = observations.find((observation) => observation.observationId === selectedId) ?? observations[0] ?? null;
  const largestMagnitude = useMemo(() => observations.reduce<number | null>((largest, observation) => {
    const magnitude = numberAttribute(observation, "magnitude");
    return magnitude === null ? largest : Math.max(largest ?? magnitude, magnitude);
  }, null), [observations]);

  async function configureSource(sourceId: string, update: { enabled?: boolean; pollCadenceMs?: number }) {
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
      setSelectedId((current) => current && data.observations.some((observation) => observation.observationId === current)
        ? current
        : data.observations[0]?.observationId ?? null);
      const configured = data.sources.find((source) => source.descriptor.id === sourceId);
      notify({
        tone: "success",
        title: update.enabled === false ? "Source offline" : update.enabled === true ? "Source online" : "Pull rate updated",
        message: update.pollCadenceMs !== undefined
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

  function commitPullRate(sourceId: string, pollCadenceMs: number) {
    if (committedRates.current[sourceId] === pollCadenceMs) return;
    void configureSource(sourceId, { pollCadenceMs });
  }

  async function runAction(kind: "refresh" | "stop") {
    setAction(kind === "refresh" ? "refreshing" : "stopping");
    setError(null);
    try {
      const data = await loadSnapshot(`/api/hunter-seeker/${kind}`, "POST");
      const failed = data.refreshResults?.find((result) => result.status === "failed");
      const skipped = data.refreshResults?.find((result) => result.status === "skipped");
      if (failed) throw new Error(failed.error ?? "The source refresh failed.");
      notify({
        tone: skipped ? "info" : "success",
        title: kind === "stop" ? "Hunter-Seeker stopped" : skipped ? "Source request held" : "Situation board refreshed",
        message: kind === "stop"
          ? "Live observations were cleared from volatile memory."
          : skipped ? "The local request budget is preventing an unnecessary repeat request." : `${data.observations.length} live observations available.`,
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

  return <section className="phase-panel hunter-panel">
    <div className="phase-heading hunter-heading">
      <div><p className="kicker">VC HUNTER-SEEKER {"//"} LIVE GEOSPATIAL INTELLIGENCE</p><h2>SITUATION BOARD</h2></div>
      <div className="hunter-summary">
        <article className={`hunter-stat status-${aggregateStatus}`}><span>FEED STATUS</span><strong>{action === "starting" ? "LINKING" : aggregateStatus.toUpperCase()}</strong><small>{visibleSources.filter((source) => source.health.status === "healthy").length} / {visibleSources.length} SOURCES NOMINAL</small></article>
        <article className="hunter-stat"><span>VISIBLE SIGNALS</span><strong>{observations.length.toLocaleString()}</strong><small>{snapshot?.observationCount.toLocaleString() ?? 0} VOLATILE CONTACTS</small></article>
        <article className="hunter-stat"><span>PEAK MAGNITUDE</span><strong>{largestMagnitude === null ? "—" : largestMagnitude.toFixed(1)}</strong><small>PAST-DAY FEED MAX</small></article>
        <article className="hunter-stat status-memory"><span>RETENTION</span><strong>MEMORY ONLY</strong><small>CLEARS ON EXIT</small></article>
      </div>
      <div className="hunter-actions">
        {snapshot?.running
          ? <><button className="cancel-action" disabled={Boolean(action)} onClick={() => void runAction("stop")}>DISCONNECT</button><button className="primary-action" disabled={Boolean(action)} onClick={() => void runAction("refresh")}>{action === "refreshing" ? "REFRESHING..." : "REFRESH NOW"}</button></>
          : <button className="primary-action" disabled={Boolean(action)} onClick={() => void startAfterStop()}>{action === "starting" ? "LINKING..." : "LINK LIVE FEED"}</button>}
      </div>
    </div>

    {error && <div className="hunter-error"><strong>SOURCE LINK DEGRADED</strong><span>{error}</span></div>}

    <div className="hunter-board">
    <section className="hunter-layer-bar" aria-label="Hunter-Seeker source controls">
      <header><div><span>SOURCE CONTROL</span><strong>LIVE SOURCE MATRIX</strong></div><small>{activeSourceIds.length} / {snapshot?.sources.length ?? 0} ONLINE</small></header>
      <div className="hunter-source-list">{snapshot?.sources.map((source) => {
        const enabled = source.health.enabled;
        const busy = busySources.includes(source.descriptor.id);
        const pullRate = rateDrafts[source.descriptor.id] ?? source.health.pollCadenceMs ?? source.descriptor.pollCadenceMs;
        const rateIndex = pullRateIndex(pullRate);
        const selectRate = (index: number) => SOURCE_PULL_RATES[Math.max(0, Math.min(SOURCE_PULL_RATES.length - 1, index))];
        return <article className={`hunter-source-card ${enabled ? "active" : ""} layer-${source.descriptor.category}`} key={source.descriptor.id}>
          <button aria-pressed={enabled} className={`hunter-source-toggle ${enabled ? "active" : ""}`} disabled={busy} onClick={() => void configureSource(source.descriptor.id, { enabled: !enabled })}>
            <i>{sourceCode(source.descriptor.category)}</i><span><strong>{source.descriptor.displayName}</strong><small>{source.health.cachedObservations.toLocaleString()} CONTACTS {"//"} {source.health.status.toUpperCase()}</small></span><b>{busy ? "WAIT" : enabled ? "ON" : "OFF"}</b>
          </button>
          <label className="hunter-pull-rate">
            <span>PULL RATE <strong>EVERY {formatPullRate(pullRate)}</strong></span>
            <input
              aria-label={`${source.descriptor.displayName} pull rate`}
              disabled={!enabled || busy}
              max={SOURCE_PULL_RATES.length - 1}
              min={0}
              onBlur={(event) => commitPullRate(source.descriptor.id, selectRate(Number(event.currentTarget.value)))}
              onChange={(event) => setRateDrafts((current) => ({ ...current, [source.descriptor.id]: selectRate(Number(event.currentTarget.value)) }))}
              onKeyUp={(event) => commitPullRate(source.descriptor.id, selectRate(Number(event.currentTarget.value)))}
              onPointerUp={(event) => commitPullRate(source.descriptor.id, selectRate(Number(event.currentTarget.value)))}
              step={1}
              type="range"
              value={rateIndex}
            />
            <small><span>30 SEC</span><span>12 HR</span></small>
          </label>
        </article>;
      })}</div>
    </section>

    <div className="hunter-workspace">
      <section className="hunter-map-shell">
        <header><div><span>GLOBAL PROJECTION {"//"} WGS84</span><strong>LIVE CONTACT MAP</strong></div><small>{snapshot?.running ? "LIVE LINK" : "LINK CLOSED"}</small></header>
        <div className="hunter-map" aria-label={`Interactive world map showing ${observations.length} live events`}>
          <Suspense fallback={<div className="hunter-map-empty"><span>INITIALIZING MAP</span><small>Loading the isolated geospatial renderer.</small></div>}><HunterSeekerMap observations={observations.slice(0, 1_500)} selectedId={selected?.observationId ?? null} onSelect={setSelectedId} /></Suspense>
          {!observations.length && <div className="hunter-map-empty"><span>{action === "starting" ? "ACQUIRING SIGNAL" : "NO LIVE CONTACTS"}</span><small>{snapshot?.running ? "Waiting for the source feed." : "Link the feed to begin."}</small></div>}
        </div>
        <footer><span>DISPLAYING {Math.min(observations.length, 1_500).toLocaleString()} / {observations.length.toLocaleString()} VISIBLE CONTACTS</span><span>LAST SYNC {formatTime(lastSuccessAt)}</span></footer>
      </section>

      <section className="hunter-event-deck">
        <header><div><span>CONTACT REGISTER</span><strong>RECENT EVENTS</strong></div><small>{visibleSources.map((source) => source.descriptor.category.toUpperCase()).join(" + ") || "NO LAYERS"}</small></header>
        <div className="hunter-event-list">
          {observations.slice(0, 250).map((observation, index) => {
            const isWeather = observation.provenance.sourceFeedId === NWS_SOURCE_ID;
            return <button className={observation.observationId === selected?.observationId ? "selected" : ""} key={observation.observationId} onClick={() => setSelectedId(observation.observationId)}>
              <span>{String(index + 1).padStart(3, "0")}</span><b className={isWeather ? "weather-badge" : ""}>{contactBadge(observation)}</b><div><strong>{observationTitle(observation)}</strong><small>{isWeather ? "NWS ALERT" : "USGS SEISMIC"} {"//"} {formatCoordinates(observation)} {"//"} {formatTime(observation.timestamp)}</small></div>
            </button>;
          })}
          {!observations.length && <div className="hunter-list-empty">CONTACT REGISTER EMPTY</div>}
        </div>
      </section>
    </div>

    {selected && (() => {
      const isWeather = selected.provenance.sourceFeedId === NWS_SOURCE_ID;
      return <article className={`hunter-contact-detail ${isWeather ? "contact-weather" : "contact-seismic"}`}>
        <header><div><span>SELECTED CONTACT {"//"} {selected.entityId}</span><strong>{observationTitle(selected)}</strong></div><b>{contactBadge(selected)}</b></header>
        <dl><div><dt>{isWeather ? "PROVIDER CENTROID" : "POSITION"}</dt><dd>{formatCoordinates(selected)}</dd></div><div><dt>{isWeather ? "EXPIRES" : "DEPTH"}</dt><dd>{isWeather ? formatTime(textAttribute(selected, "expiresAt") ?? undefined) : `${numberAttribute(selected, "depthKm")?.toFixed(1) ?? "—"} KM`}</dd></div><div><dt>{isWeather ? "EFFECTIVE" : "DETECTED"}</dt><dd>{formatTime(selected.timestamp)}</dd></div><div><dt>{isWeather ? "CERTAINTY" : "CONFIDENCE"}</dt><dd>{Math.round(selected.confidence * 100)}% {(textAttribute(selected, isWeather ? "certainty" : "reviewStatus") ?? (isWeather ? "unknown" : "unreviewed")).toUpperCase()}</dd></div><div><dt>STALENESS AT RECEIPT</dt><dd>{formatDuration(selected.provenance.stalenessMs)}</dd></div></dl>
        {isWeather && textAttribute(selected, "description") && <p className="hunter-alert-description">{textAttribute(selected, "description")}</p>}
        <footer><span>SOURCE: {isWeather ? "NOAA / NATIONAL WEATHER SERVICE" : "U.S. GEOLOGICAL SURVEY"}</span>{textAttribute(selected, "eventUrl") && <a href={textAttribute(selected, "eventUrl")!} target="_blank" rel="noreferrer">OPEN {isWeather ? "NWS ALERT" : "USGS EVENT"} ↗</a>}</footer>
      </article>;
    })()}
    </div>
  </section>;
}
