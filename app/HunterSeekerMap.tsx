import { useEffect, useMemo, useRef, useState } from "react";
import { Map as MapLibreMap, NavigationControl, ScaleControl, type ExpressionSpecification, type FilterSpecification, type GeoJSONSource, type MapLayerMouseEvent, type MapMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { buildHunterSeekerMapData, type HunterSeekerFeatureCollection, type HunterSeekerObservation } from "./hunter-seeker-map-data";

const OPENFREEMAP_STYLE_URL = "https://tiles.openfreemap.org/styles/dark";
const OPENFREEMAP_ORIGIN = "https://tiles.openfreemap.org";
const LIVE_SOURCE_ID = "hunter-seeker-live";
const INTERACTIVE_LAYERS = ["hunter-military-aircraft-points", "hunter-civilian-aircraft-points", "hunter-maritime-vessel-points", "hunter-space-station-points", "hunter-weather-points", "hunter-seismic-points", "hunter-weather-areas"];

type MapStatus = "connecting" | "ready" | "fallback" | "degraded";

function token(styles: CSSStyleDeclaration, name: string) {
  return styles.getPropertyValue(name).trim();
}

function blockedResource() {
  return "data:application/octet-stream;base64,";
}

type MapIconKind = "military-aircraft" | "civilian-aircraft" | "maritime-vessel" | "space-station" | "seismic" | "weather";
type MapIconPalette = { canvas: string; purple: string; acid: string; amber: string; danger: string; blue: string; cyan: string };

function drawTargetCorners(context: CanvasRenderingContext2D, color: string) {
  context.strokeStyle = color;
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(6, 18); context.lineTo(6, 7); context.lineTo(18, 7);
  context.moveTo(46, 7); context.lineTo(58, 7); context.lineTo(58, 18);
  context.moveTo(58, 46); context.lineTo(58, 57); context.lineTo(46, 57);
  context.moveTo(18, 57); context.lineTo(6, 57); context.lineTo(6, 46);
  context.stroke();
}

function createMapIcon(kind: MapIconKind, palette: MapIconPalette) {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Hunter-Seeker map icon canvas is unavailable.");
  context.lineJoin = "miter";
  context.lineCap = "square";
  const frameColor = kind === "military-aircraft" ? palette.danger : kind === "civilian-aircraft" ? palette.blue : kind === "maritime-vessel" ? palette.cyan : kind === "space-station" ? palette.acid : palette.purple;
  drawTargetCorners(context, frameColor);

  if (kind === "military-aircraft" || kind === "civilian-aircraft") {
    const aircraftColor = kind === "military-aircraft" ? palette.danger : palette.blue;
    const aircraftPath = () => {
      context.beginPath();
      context.moveTo(32, 4);
      context.lineTo(37, 24);
      context.lineTo(58, 30);
      context.lineTo(58, 36);
      context.lineTo(38, 34);
      context.lineTo(39, 48);
      context.lineTo(49, 55);
      context.lineTo(47, 60);
      context.lineTo(32, 54);
      context.lineTo(17, 60);
      context.lineTo(15, 55);
      context.lineTo(25, 48);
      context.lineTo(26, 34);
      context.lineTo(6, 36);
      context.lineTo(6, 30);
      context.lineTo(27, 24);
      context.closePath();
    };
    aircraftPath();
    context.strokeStyle = palette.canvas;
    context.lineWidth = 7;
    context.stroke();
    aircraftPath();
    context.fillStyle = aircraftColor;
    context.strokeStyle = aircraftColor;
    context.lineWidth = 3;
    context.fill();
    context.stroke();
    context.fillStyle = kind === "military-aircraft" ? palette.amber : palette.acid;
    context.fillRect(30, 18, 4, 7);
  } else if (kind === "maritime-vessel") {
    context.beginPath();
    context.moveTo(12, 31); context.lineTo(52, 31); context.lineTo(45, 53); context.lineTo(20, 53); context.closePath();
    context.fillStyle = palette.canvas; context.strokeStyle = palette.cyan; context.lineWidth = 6; context.fill(); context.stroke();
    context.beginPath();
    context.moveTo(17, 28); context.lineTo(23, 19); context.lineTo(40, 19); context.lineTo(47, 28); context.closePath();
    context.fillStyle = palette.purple; context.strokeStyle = palette.canvas; context.lineWidth = 3; context.fill(); context.stroke();
    context.fillStyle = palette.acid; context.fillRect(29, 8, 5, 12); context.fillRect(34, 10, 8, 3);
    context.strokeStyle = palette.cyan; context.lineWidth = 2;
    context.beginPath(); context.moveTo(8, 57); context.quadraticCurveTo(18, 51, 28, 57); context.quadraticCurveTo(38, 63, 56, 55); context.stroke();
  } else if (kind === "space-station") {
    context.fillStyle = palette.canvas;
    context.strokeStyle = palette.acid;
    context.lineWidth = 5;
    context.fillRect(24, 20, 16, 25);
    context.strokeRect(24, 20, 16, 25);
    context.fillStyle = palette.purple;
    context.strokeStyle = palette.canvas;
    context.lineWidth = 3;
    context.fillRect(4, 23, 18, 19);
    context.strokeRect(4, 23, 18, 19);
    context.fillRect(42, 23, 18, 19);
    context.strokeRect(42, 23, 18, 19);
    context.strokeStyle = palette.amber;
    context.lineWidth = 2;
    for (const x of [10, 16, 48, 54]) {
      context.beginPath(); context.moveTo(x, 25); context.lineTo(x, 40); context.stroke();
    }
    context.beginPath(); context.moveTo(32, 11); context.lineTo(32, 20); context.stroke();
    context.beginPath(); context.arc(32, 10, 5, Math.PI, 2 * Math.PI); context.stroke();
    context.fillStyle = palette.danger;
    context.fillRect(29, 29, 6, 7);
    context.strokeStyle = palette.acid;
    context.lineWidth = 2;
    context.beginPath(); context.moveTo(32, 45); context.lineTo(22, 56); context.moveTo(32, 45); context.lineTo(42, 56); context.stroke();
  } else if (kind === "seismic") {
    context.beginPath();
    context.moveTo(32, 4); context.lineTo(60, 32); context.lineTo(32, 60); context.lineTo(4, 32); context.closePath();
    context.fillStyle = palette.canvas;
    context.strokeStyle = palette.purple;
    context.lineWidth = 6;
    context.fill();
    context.stroke();
    context.beginPath();
    context.moveTo(32, 8); context.lineTo(56, 32); context.lineTo(32, 56); context.lineTo(8, 32); context.closePath();
    context.strokeStyle = palette.amber;
    context.lineWidth = 3;
    context.stroke();
    context.beginPath();
    context.moveTo(10, 34); context.lineTo(21, 34); context.lineTo(27, 20); context.lineTo(34, 47); context.lineTo(40, 29); context.lineTo(54, 29);
    context.strokeStyle = palette.acid;
    context.lineWidth = 4;
    context.stroke();
    context.fillStyle = palette.danger;
    context.fillRect(29, 29, 6, 6);
  } else {
    context.beginPath();
    context.moveTo(32, 4); context.lineTo(60, 56); context.lineTo(4, 56); context.closePath();
    context.fillStyle = palette.canvas;
    context.strokeStyle = palette.purple;
    context.lineWidth = 7;
    context.fill();
    context.stroke();
    context.beginPath();
    context.moveTo(32, 8); context.lineTo(56, 53); context.lineTo(8, 53); context.closePath();
    context.strokeStyle = palette.amber;
    context.lineWidth = 3;
    context.stroke();
    context.beginPath();
    context.moveTo(36, 15); context.lineTo(23, 35); context.lineTo(32, 35); context.lineTo(26, 51); context.lineTo(44, 29); context.lineTo(35, 29); context.closePath();
    context.fillStyle = palette.acid;
    context.fill();
    context.fillStyle = palette.danger;
    context.fillRect(29, 51, 6, 5);
  }
  return context.getImageData(0, 0, 64, 64);
}

function freshnessMap(signature: string) {
  return Object.fromEntries(signature.split("&").filter(Boolean).map((entry) => {
    const separator = entry.indexOf("=");
    return [decodeURIComponent(entry.slice(0, separator)), entry.slice(separator + 1)];
  })) as Record<string, "live" | "cached" | "stale" | "degraded" | "acquiring" | "offline">;
}

const ICON_FRESHNESS_OPACITY: ExpressionSpecification = ["match", ["get", "freshness"], "live", 0.98, "cached", 0.62, "stale", 0.25, "degraded", 0.38, "acquiring", 0.4, 0.15];

export function HunterSeekerMap({ observations, freshnessSignature, selectedId, onSelect, onContextMenu }: {
  observations: HunterSeekerObservation[];
  freshnessSignature: string;
  selectedId: string | null;
  onSelect: (observationId: string) => void;
  onContextMenu: (target: { observationId: string | null; latitude: number; longitude: number; clientX: number; clientY: number }) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const dataRef = useRef<HunterSeekerFeatureCollection>(buildHunterSeekerMapData(observations, freshnessMap(freshnessSignature)));
  const selectRef = useRef(onSelect);
  const contextMenuRef = useRef(onContextMenu);
  const selectedRef = useRef(selectedId);
  const [status, setStatus] = useState<MapStatus>("connecting");
  const mapData = useMemo(() => buildHunterSeekerMapData(observations, freshnessMap(freshnessSignature)), [observations, freshnessSignature]);

  useEffect(() => { selectRef.current = onSelect; }, [onSelect]);
  useEffect(() => { contextMenuRef.current = onContextMenu; }, [onContextMenu]);

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
      blue: token(styles, "--vc-intel-civilian-aircraft"),
      cyan: token(styles, "--vc-intel-maritime"),
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

    const setupLayers = () => {
      if (layersReady) return;
      layersReady = true;
      map.addSource(LIVE_SOURCE_ID, { type: "geojson", data: dataRef.current });
      map.addImage("hunter-military-aircraft-icon", createMapIcon("military-aircraft", colors), { pixelRatio: 2 });
      map.addImage("hunter-civilian-aircraft-icon", createMapIcon("civilian-aircraft", colors), { pixelRatio: 2 });
      map.addImage("hunter-maritime-vessel-icon", createMapIcon("maritime-vessel", colors), { pixelRatio: 2 });
      map.addImage("hunter-space-station-icon", createMapIcon("space-station", colors), { pixelRatio: 2 });
      map.addImage("hunter-seismic-icon", createMapIcon("seismic", colors), { pixelRatio: 2 });
      map.addImage("hunter-weather-icon", createMapIcon("weather", colors), { pixelRatio: 2 });
      map.addLayer({
        id: "hunter-weather-areas",
        type: "fill",
        source: LIVE_SOURCE_ID,
        filter: ["==", ["get", "kind"], "weather-area"],
        paint: {
          "fill-color": ["match", ["get", "severity"], "extreme", colors.danger, "severe", colors.danger, "moderate", colors.amber, colors.purple],
          "fill-opacity": ["match", ["get", "freshness"], "live", 0.24, "cached", 0.15, "stale", 0.06, "degraded", 0.09, 0.08],
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
          "line-opacity": ["match", ["get", "freshness"], "live", 0.9, "cached", 0.55, "stale", 0.22, "degraded", 0.35, 0.25],
          "line-width": 1.2,
        },
      });
      map.addLayer({
        id: "hunter-seismic-points",
        type: "symbol",
        source: LIVE_SOURCE_ID,
        filter: ["==", ["get", "kind"], "seismic-point"],
        layout: {
          "icon-image": "hunter-seismic-icon",
          "icon-size": ["interpolate", ["linear"], ["get", "magnitude"], -1, 0.42, 3, 0.56, 7, 0.88],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: {
          "icon-opacity": ICON_FRESHNESS_OPACITY,
        },
      });
      map.addLayer({
        id: "hunter-weather-points",
        type: "symbol",
        source: LIVE_SOURCE_ID,
        filter: ["==", ["get", "kind"], "weather-point"],
        layout: {
          "icon-image": "hunter-weather-icon",
          "icon-size": ["match", ["get", "severity"], "extreme", 0.82, "severe", 0.74, "moderate", 0.62, 0.52],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: {
          "icon-opacity": ICON_FRESHNESS_OPACITY,
        },
      });
      map.addLayer({
        id: "hunter-military-aircraft-points",
        type: "symbol",
        source: LIVE_SOURCE_ID,
        filter: ["==", ["get", "kind"], "military-aircraft-point"],
        layout: {
          "icon-image": "hunter-military-aircraft-icon",
          "icon-size": ["interpolate", ["linear"], ["zoom"], 0, 0.46, 6, 0.7, 12, 0.9],
          "icon-rotate": ["get", "headingDegrees"],
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: {
          "icon-opacity": ICON_FRESHNESS_OPACITY,
        },
      });
      map.addLayer({
        id: "hunter-civilian-aircraft-points",
        type: "symbol",
        source: LIVE_SOURCE_ID,
        filter: ["==", ["get", "kind"], "civilian-aircraft-point"],
        layout: {
          "icon-image": "hunter-civilian-aircraft-icon",
          "icon-size": ["interpolate", ["linear"], ["zoom"], 0, 0.46, 6, 0.7, 12, 0.9],
          "icon-rotate": ["get", "headingDegrees"],
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: {
          "icon-opacity": ICON_FRESHNESS_OPACITY,
        },
      });
      map.addLayer({
        id: "hunter-space-station-points",
        type: "symbol",
        source: LIVE_SOURCE_ID,
        filter: ["==", ["get", "kind"], "space-station-point"],
        layout: {
          "icon-image": "hunter-space-station-icon",
          "icon-size": ["interpolate", ["linear"], ["zoom"], 0, 0.48, 6, 0.7, 12, 0.9],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: {
          "icon-opacity": ICON_FRESHNESS_OPACITY,
        },
      });
      map.addLayer({
        id: "hunter-maritime-vessel-points",
        type: "symbol",
        source: LIVE_SOURCE_ID,
        filter: ["==", ["get", "kind"], "maritime-vessel-point"],
        layout: {
          "icon-image": "hunter-maritime-vessel-icon",
          "icon-size": ["interpolate", ["linear"], ["zoom"], 0, 0.44, 6, 0.68, 12, 0.88],
          "icon-rotate": ["get", "headingDegrees"],
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: { "icon-opacity": ICON_FRESHNESS_OPACITY },
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
    const openContextMenu = (event: MapMouseEvent) => {
      event.preventDefault();
      const feature = map.queryRenderedFeatures(event.point, { layers: INTERACTIVE_LAYERS }).find((candidate) => typeof candidate.properties?.observationId === "string");
      const observationId = typeof feature?.properties?.observationId === "string" ? feature.properties.observationId : null;
      if (observationId) selectRef.current(observationId);
      contextMenuRef.current({ observationId, latitude: event.lngLat.lat, longitude: event.lngLat.lng, clientX: event.originalEvent.clientX, clientY: event.originalEvent.clientY });
    };
    map.once("load", setupLayers);
    map.on("click", INTERACTIVE_LAYERS, pickObservation);
    map.on("mouseenter", INTERACTIVE_LAYERS, showPointer);
    map.on("mouseleave", INTERACTIVE_LAYERS, clearPointer);
    map.on("contextmenu", openContextMenu);
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
