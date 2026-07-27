import { useEffect, useMemo, useRef, useState } from "react";
import { AttributionControl, Map as MapLibreMap, NavigationControl, ScaleControl, type FilterSpecification, type GeoJSONSource, type MapLayerMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { buildHunterSeekerMapData, type HunterSeekerFeatureCollection, type HunterSeekerObservation } from "./hunter-seeker-map-data";

const OPENFREEMAP_STYLE_URL = "https://tiles.openfreemap.org/styles/dark";
const OPENFREEMAP_ORIGIN = "https://tiles.openfreemap.org";
const LIVE_SOURCE_ID = "hunter-seeker-live";
const INTERACTIVE_LAYERS = ["hunter-weather-points", "hunter-seismic-points", "hunter-weather-areas"];

type MapStatus = "connecting" | "ready" | "fallback" | "degraded";

function token(styles: CSSStyleDeclaration, name: string) {
  return styles.getPropertyValue(name).trim();
}

function blockedResource() {
  return "data:application/octet-stream;base64,";
}

export function HunterSeekerMap({ observations, selectedId, onSelect }: {
  observations: HunterSeekerObservation[];
  selectedId: string | null;
  onSelect: (observationId: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const dataRef = useRef<HunterSeekerFeatureCollection>(buildHunterSeekerMapData(observations));
  const selectRef = useRef(onSelect);
  const selectedRef = useRef(selectedId);
  const [status, setStatus] = useState<MapStatus>("connecting");
  const mapData = useMemo(() => buildHunterSeekerMapData(observations), [observations]);

  useEffect(() => { selectRef.current = onSelect; }, [onSelect]);

  useEffect(() => {
    dataRef.current = mapData;
    const source = mapRef.current?.getSource(LIVE_SOURCE_ID) as GeoJSONSource | undefined;
    if (source) source.setData(mapData);
  }, [mapData]);

  useEffect(() => {
    selectedRef.current = selectedId;
    const map = mapRef.current;
    if (!map) return;
    const filter: FilterSpecification = ["==", ["get", "observationId"], selectedId ?? "__none__"];
    for (const layerId of ["hunter-selected-area", "hunter-selected-point"]) {
      if (map.getLayer(layerId)) map.setFilter(layerId, filter);
    }
  }, [selectedId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const styles = getComputedStyle(container);
    const colors = {
      canvas: token(styles, "--vc-map-background"),
      purple: token(styles, "--vc-accent-primary"),
      acid: token(styles, "--vc-accent-highlight"),
      amber: token(styles, "--vc-status-warning"),
      danger: token(styles, "--vc-status-critical"),
      muted: token(styles, "--vc-intel-stale"),
    };
    let usingFallback = false;
    let layersReady = false;
    const localFallbackStyle = {
      version: 8 as const,
      name: "VoidCat offline map fallback",
      sources: {},
      layers: [{ id: "voidcat-background", type: "background" as const, paint: { "background-color": colors.canvas } }],
    };
    const map = new MapLibreMap({
      container,
      style: OPENFREEMAP_STYLE_URL,
      center: [0, 18],
      zoom: 1.15,
      minZoom: 0.75,
      maxZoom: 12,
      maxPitch: 0,
      pitchWithRotate: false,
      dragRotate: false,
      touchPitch: false,
      renderWorldCopies: false,
      canvasContextAttributes: { antialias: false, preserveDrawingBuffer: false, powerPreference: "low-power" },
      attributionControl: false,
      refreshExpiredTiles: false,
      maxTileCacheSize: 96,
      fadeDuration: 0,
      cancelPendingTileRequestsWhileZooming: true,
      transformRequest: (url) => {
        try {
          const resource = new URL(url);
          if (resource.origin !== OPENFREEMAP_ORIGIN) return { url: blockedResource(), credentials: "same-origin" };
          return { url, credentials: "same-origin" };
        } catch {
          return { url: blockedResource(), credentials: "same-origin" };
        }
      },
    });
    mapRef.current = map;
    map.addControl(new NavigationControl({ showCompass: false, visualizePitch: false }), "top-right");
    map.addControl(new ScaleControl({ maxWidth: 100, unit: "metric" }), "bottom-left");
    map.addControl(new AttributionControl({ compact: true }), "bottom-right");

    const setupLayers = () => {
      if (layersReady) return;
      layersReady = true;
      map.addSource(LIVE_SOURCE_ID, { type: "geojson", data: dataRef.current });
      map.addLayer({
        id: "hunter-weather-areas",
        type: "fill",
        source: LIVE_SOURCE_ID,
        filter: ["==", ["get", "kind"], "weather-area"],
        paint: {
          "fill-color": ["match", ["get", "severity"], "extreme", colors.danger, "severe", colors.danger, "moderate", colors.amber, colors.purple],
          "fill-opacity": ["interpolate", ["linear"], ["get", "stalenessMinutes"], 0, 0.24, 360, 0.08],
          "fill-outline-color": colors.amber,
        },
      });
      map.addLayer({
        id: "hunter-weather-lines",
        type: "line",
        source: LIVE_SOURCE_ID,
        filter: ["==", ["get", "kind"], "weather-area"],
        paint: {
          "line-color": ["match", ["get", "severity"], "extreme", colors.danger, "severe", colors.danger, "moderate", colors.amber, colors.purple],
          "line-opacity": ["interpolate", ["linear"], ["get", "stalenessMinutes"], 0, 0.9, 360, 0.32],
          "line-width": 1.2,
        },
      });
      map.addLayer({
        id: "hunter-seismic-points",
        type: "circle",
        source: LIVE_SOURCE_ID,
        filter: ["==", ["get", "kind"], "seismic-point"],
        paint: {
          "circle-color": ["step", ["get", "magnitude"], colors.purple, 3, colors.amber, 5, colors.danger],
          "circle-radius": ["interpolate", ["linear"], ["get", "magnitude"], -1, 2.5, 3, 4.5, 7, 10],
          "circle-opacity": ["interpolate", ["linear"], ["get", "stalenessMinutes"], 0, 0.96, 360, 0.34],
          "circle-stroke-color": colors.canvas,
          "circle-stroke-width": 1,
        },
      });
      map.addLayer({
        id: "hunter-weather-points",
        type: "circle",
        source: LIVE_SOURCE_ID,
        filter: ["==", ["get", "kind"], "weather-point"],
        paint: {
          "circle-color": ["match", ["get", "severity"], "extreme", colors.danger, "severe", colors.danger, "moderate", colors.amber, colors.purple],
          "circle-radius": ["match", ["get", "severity"], "extreme", 8, "severe", 7, "moderate", 5.5, 4.5],
          "circle-opacity": ["interpolate", ["linear"], ["get", "stalenessMinutes"], 0, 0.92, 360, 0.3],
          "circle-stroke-color": colors.canvas,
          "circle-stroke-width": 1.5,
        },
      });
      map.addLayer({
        id: "hunter-selected-area",
        type: "line",
        source: LIVE_SOURCE_ID,
        filter: ["==", ["get", "observationId"], selectedRef.current ?? "__none__"],
        paint: { "line-color": colors.acid, "line-width": 3, "line-opacity": 1 },
      });
      map.addLayer({
        id: "hunter-selected-point",
        type: "circle",
        source: LIVE_SOURCE_ID,
        filter: ["==", ["get", "observationId"], selectedRef.current ?? "__none__"],
        paint: {
          "circle-color": colors.acid,
          "circle-radius": 10,
          "circle-opacity": 0.24,
          "circle-stroke-color": colors.acid,
          "circle-stroke-width": 2,
        },
      });
      setStatus(usingFallback ? "fallback" : "ready");
    };

    const pickObservation = (event: MapLayerMouseEvent) => {
      const observationId = event.features?.find((feature) => typeof feature.properties?.observationId === "string")?.properties?.observationId;
      if (typeof observationId === "string") selectRef.current(observationId);
    };
    const showPointer = () => { map.getCanvas().style.cursor = "pointer"; };
    const clearPointer = () => { map.getCanvas().style.cursor = ""; };
    map.once("load", setupLayers);
    map.on("click", INTERACTIVE_LAYERS, pickObservation);
    map.on("mouseenter", INTERACTIVE_LAYERS, showPointer);
    map.on("mouseleave", INTERACTIVE_LAYERS, clearPointer);
    map.on("error", () => setStatus((current) => current === "fallback" ? current : "degraded"));

    const fallbackTimer = window.setTimeout(() => {
      if (layersReady) return;
      usingFallback = true;
      map.setStyle(localFallbackStyle);
    }, 8_000);
    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(container);

    return () => {
      window.clearTimeout(fallbackTimer);
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  function resetView() {
    mapRef.current?.jumpTo({ center: [0, 18], zoom: 1.15, bearing: 0, pitch: 0 });
  }

  return <div className="hunter-maplibre-frame">
    <div className="hunter-maplibre" ref={containerRef} />
    <div className={`hunter-basemap-status status-${status}`}><i /> {status === "ready" ? "OPENFREEMAP LIVE" : status === "fallback" ? "LOCAL FALLBACK" : status === "degraded" ? "BASEMAP DEGRADED" : "BASEMAP LINKING"}</div>
    <button className="hunter-map-reset" onClick={resetView}>GLOBAL VIEW</button>
  </div>;
}
