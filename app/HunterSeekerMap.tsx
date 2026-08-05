/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Map as MapLibreMap, NavigationControl, ScaleControl, type ExpressionSpecification, type FilterSpecification, type GeoJSONSource, type MapLayerMouseEvent, type MapMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { buildHunterSeekerMapData, type HunterSeekerFeatureCollection, type HunterSeekerObservation } from "./hunter-seeker-map-data";

const OPENFREEMAP_STYLE_URL = "https://tiles.openfreemap.org/styles/dark";
const OPENFREEMAP_ORIGIN = "https://tiles.openfreemap.org";
const LIVE_SOURCE_ID = "hunter-seeker-live";
const DEFLOCK_SOURCE_ID = "hunter-seeker-deflock-world";
const DEFLOCK_REGION_SOURCE_ID = "hunter-seeker-deflock-regions";
const INTERACTIVE_LAYERS = ["hunter-military-aircraft-points", "hunter-civilian-aircraft-points", "hunter-maritime-vessel-points", "hunter-space-station-points", "hunter-alpr-camera-points", "hunter-public-webcam-points", "hunter-weather-points", "hunter-natural-event-points", "hunter-seismic-points", "hunter-weather-areas"];

type MapStatus = "connecting" | "ready" | "fallback" | "degraded";

function token(styles: CSSStyleDeclaration, name: string) {
  return styles.getPropertyValue(name).trim();
}

function blockedResource() {
  return "data:application/octet-stream;base64,";
}

type MapIconKind = "military-aircraft" | "civilian-aircraft" | "maritime-vessel" | "space-station" | "weather-satellite" | "navigation-satellite" | "science-satellite" | "recent-launch" | "visual-satellite" | "alpr-camera" | "public-webcam" | "seismic" | "weather" | "storm" | "wildfire" | "volcano" | "flood" | "landslide" | "drought" | "dust-haze" | "ice" | "snow" | "temperature" | "manmade" | "water-color" | "climate";
type MapIconPalette = { canvas: string; purple: string; acid: string; amber: string; danger: string; blue: string; cyan: string; infrastructure: string };

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
  const frameColor = kind === "military-aircraft" ? palette.danger : kind === "civilian-aircraft" ? palette.blue : kind === "maritime-vessel" || kind === "public-webcam" ? palette.cyan : kind.includes("satellite") || kind === "space-station" || kind === "recent-launch" ? palette.acid : kind === "alpr-camera" ? palette.infrastructure : palette.purple;
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
  } else if (kind === "recent-launch") {
    context.beginPath();
    context.moveTo(32, 5); context.bezierCurveTo(45, 17, 44, 37, 37, 46); context.lineTo(27, 46); context.bezierCurveTo(20, 37, 19, 17, 32, 5); context.closePath();
    context.fillStyle = palette.canvas; context.strokeStyle = palette.acid; context.lineWidth = 5; context.fill(); context.stroke();
    context.beginPath(); context.arc(32, 25, 6, 0, Math.PI * 2); context.fillStyle = palette.blue; context.fill();
    context.beginPath(); context.moveTo(26, 40); context.lineTo(16, 51); context.lineTo(27, 48); context.moveTo(38, 40); context.lineTo(48, 51); context.lineTo(37, 48); context.strokeStyle = palette.purple; context.lineWidth = 4; context.stroke();
    context.beginPath(); context.moveTo(27, 48); context.lineTo(32, 60); context.lineTo(37, 48); context.closePath(); context.fillStyle = palette.danger; context.fill();
  } else if (["space-station", "weather-satellite", "navigation-satellite", "science-satellite", "visual-satellite"].includes(kind)) {
    context.fillStyle = palette.canvas;
    context.strokeStyle = kind === "weather-satellite" ? palette.cyan : palette.acid;
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
    context.lineWidth = 2;
    if (kind === "space-station") {
      context.fillStyle = palette.danger; context.fillRect(29, 29, 6, 7);
      context.strokeStyle = palette.acid; context.beginPath(); context.moveTo(32, 45); context.lineTo(22, 56); context.moveTo(32, 45); context.lineTo(42, 56); context.stroke();
    } else if (kind === "weather-satellite") {
      context.strokeStyle = palette.cyan; context.beginPath(); context.arc(32, 34, 9, Math.PI * .15, Math.PI * 1.45); context.stroke();
      context.beginPath(); context.arc(31, 34, 4, 0, Math.PI * 2); context.fillStyle = palette.blue; context.fill();
      context.strokeStyle = palette.acid; context.beginPath(); context.arc(32, 47, 10, Math.PI, 0); context.stroke();
    } else if (kind === "navigation-satellite") {
      context.strokeStyle = palette.amber; context.lineWidth = 3; context.beginPath(); context.moveTo(32, 24); context.lineTo(32, 42); context.moveTo(23, 33); context.lineTo(41, 33); context.stroke();
      context.beginPath(); context.moveTo(32, 22); context.lineTo(28, 29); context.lineTo(36, 29); context.closePath(); context.fillStyle = palette.acid; context.fill();
    } else if (kind === "science-satellite") {
      context.strokeStyle = palette.purple; context.lineWidth = 2; context.beginPath(); context.ellipse(32, 33, 13, 5, Math.PI / 4, 0, Math.PI * 2); context.stroke(); context.beginPath(); context.ellipse(32, 33, 13, 5, -Math.PI / 4, 0, Math.PI * 2); context.stroke();
      context.beginPath(); context.arc(32, 33, 4, 0, Math.PI * 2); context.fillStyle = palette.acid; context.fill();
    } else {
      context.strokeStyle = palette.blue; context.lineWidth = 3; context.beginPath(); context.moveTo(21, 33); context.quadraticCurveTo(32, 22, 43, 33); context.quadraticCurveTo(32, 44, 21, 33); context.stroke();
      context.beginPath(); context.arc(32, 33, 4, 0, Math.PI * 2); context.fillStyle = palette.acid; context.fill();
    }
  } else if (kind === "alpr-camera" || kind === "public-webcam") {
    context.beginPath();
    context.moveTo(9, 18); context.lineTo(47, 18); context.lineTo(55, 27); context.lineTo(55, 42); context.lineTo(17, 42); context.lineTo(9, 34); context.closePath();
    context.fillStyle = palette.canvas; context.strokeStyle = kind === "public-webcam" ? palette.cyan : palette.infrastructure; context.lineWidth = 6; context.fill(); context.stroke();
    context.beginPath(); context.arc(42, 30, 9, 0, Math.PI * 2); context.fillStyle = palette.purple; context.fill();
    context.beginPath(); context.arc(42, 30, 4, 0, Math.PI * 2); context.fillStyle = palette.acid; context.fill();
    context.strokeStyle = palette.purple; context.lineWidth = 4;
    context.beginPath(); context.moveTo(22, 43); context.lineTo(22, 55); context.lineTo(49, 55); context.stroke();
    context.fillStyle = kind === "public-webcam" ? palette.acid : palette.danger; context.fillRect(12, 23, 5, 13);
  } else if (["storm", "wildfire", "volcano", "flood", "landslide", "drought", "dust-haze", "ice", "snow", "temperature", "manmade", "water-color", "climate"].includes(kind)) {
    context.beginPath();
    context.moveTo(32, 4); context.lineTo(60, 32); context.lineTo(32, 60); context.lineTo(4, 32); context.closePath();
    context.fillStyle = palette.canvas; context.strokeStyle = palette.amber; context.lineWidth = 5; context.fill(); context.stroke();
    context.strokeStyle = palette.acid; context.fillStyle = kind === "wildfire" ? palette.danger : palette.purple; context.lineWidth = 4;
    if (kind === "storm") {
      context.beginPath(); context.arc(32, 32, 17, .2, Math.PI * 1.75); context.stroke(); context.beginPath(); context.arc(32, 32, 9, Math.PI * 1.2, Math.PI * 2.7); context.stroke(); context.beginPath(); context.arc(32, 32, 3, 0, Math.PI * 2); context.fill();
    } else if (kind === "wildfire") {
      context.beginPath(); context.moveTo(32, 12); context.bezierCurveTo(48, 28, 43, 47, 32, 53); context.bezierCurveTo(18, 45, 20, 30, 29, 23); context.lineTo(32, 12); context.fill(); context.stroke();
    } else if (kind === "volcano") {
      context.beginPath(); context.moveTo(12, 49); context.lineTo(27, 21); context.lineTo(37, 21); context.lineTo(53, 49); context.closePath(); context.stroke(); context.beginPath(); context.arc(32, 14, 7, Math.PI, 2 * Math.PI); context.stroke();
    } else if (kind === "flood") {
      for (const y of [22, 34, 46]) { context.beginPath(); context.moveTo(12, y); context.quadraticCurveTo(22, y - 8, 32, y); context.quadraticCurveTo(42, y + 8, 52, y); context.stroke(); }
    } else if (kind === "landslide") {
      context.beginPath(); context.moveTo(12, 49); context.lineTo(22, 19); context.lineTo(52, 49); context.stroke(); for (const [x,y] of [[27,30],[37,37],[44,45]]) { context.beginPath(); context.arc(x,y,4,0,Math.PI*2); context.fill(); }
    } else if (kind === "drought") {
      context.beginPath(); context.arc(32, 25, 10, 0, Math.PI * 2); context.stroke();
      for (let index = 0; index < 8; index += 1) { const angle = index * Math.PI / 4; context.beginPath(); context.moveTo(32 + Math.cos(angle) * 14, 25 + Math.sin(angle) * 14); context.lineTo(32 + Math.cos(angle) * 20, 25 + Math.sin(angle) * 20); context.stroke(); }
      context.beginPath(); context.moveTo(15, 50); context.lineTo(26, 42); context.lineTo(31, 52); context.lineTo(39, 41); context.lineTo(50, 50); context.stroke();
    } else if (kind === "dust-haze") {
      for (const y of [22, 32, 42]) { context.beginPath(); context.moveTo(10, y); context.bezierCurveTo(21, y - 8, 35, y + 8, 54, y); context.stroke(); }
      context.fillStyle = palette.amber; for (const [x,y] of [[17,17],[43,18],[25,47],[49,46]]) { context.beginPath(); context.arc(x,y,2,0,Math.PI*2); context.fill(); }
    } else if (kind === "ice") {
      context.beginPath(); context.moveTo(11, 45); context.lineTo(23, 22); context.lineTo(31, 35); context.lineTo(39, 16); context.lineTo(54, 45); context.closePath(); context.stroke();
      context.beginPath(); context.moveTo(10, 49); context.lineTo(54, 49); context.strokeStyle = palette.blue; context.stroke();
    } else if (kind === "snow") {
      context.strokeStyle = palette.blue; context.beginPath(); context.moveTo(32, 12); context.lineTo(32, 52); context.moveTo(15, 22); context.lineTo(49, 42); context.moveTo(15, 42); context.lineTo(49, 22); context.stroke();
      for (const angle of [0, Math.PI / 3, Math.PI * 2 / 3]) { const dx = Math.cos(angle) * 8; const dy = Math.sin(angle) * 8; context.beginPath(); context.moveTo(32 + dx, 32 + dy); context.lineTo(32 + dx * 1.45 - dy * .35, 32 + dy * 1.45 + dx * .35); context.moveTo(32 - dx, 32 - dy); context.lineTo(32 - dx * 1.45 + dy * .35, 32 - dy * 1.45 - dx * .35); context.stroke(); }
    } else if (kind === "temperature") {
      context.strokeStyle = palette.danger; context.lineWidth = 5; context.beginPath(); context.moveTo(32, 16); context.lineTo(32, 42); context.stroke(); context.beginPath(); context.arc(32, 47, 8, 0, Math.PI * 2); context.fillStyle = palette.danger; context.fill(); context.stroke(); context.strokeStyle = palette.acid; context.lineWidth = 2; context.strokeRect(27, 11, 10, 34);
    } else if (kind === "manmade") {
      context.strokeStyle = palette.amber; context.beginPath(); context.moveTo(12, 49); context.lineTo(12, 29); context.lineTo(24, 36); context.lineTo(24, 23); context.lineTo(37, 31); context.lineTo(37, 16); context.lineTo(47, 16); context.lineTo(52, 49); context.closePath(); context.stroke();
      context.fillStyle = palette.danger; for (const x of [20, 31, 43]) context.fillRect(x, 40, 5, 7);
    } else if (kind === "water-color") {
      context.beginPath(); context.moveTo(32, 10); context.bezierCurveTo(21, 25, 16, 32, 16, 41); context.bezierCurveTo(16, 54, 48, 54, 48, 41); context.bezierCurveTo(48, 32, 43, 25, 32, 10); context.closePath(); context.strokeStyle = palette.blue; context.fillStyle = palette.canvas; context.fill(); context.stroke();
      context.beginPath(); context.moveTo(20, 41); context.quadraticCurveTo(27, 34, 34, 41); context.quadraticCurveTo(41, 48, 46, 40); context.strokeStyle = palette.acid; context.stroke();
    } else {
      context.beginPath(); context.moveTo(32, 13); context.lineTo(32, 51); context.moveTo(13, 32); context.lineTo(51, 32); context.moveTo(18, 18); context.lineTo(46, 46); context.moveTo(46, 18); context.lineTo(18, 46); context.stroke();
    }
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

const ICON_FRESHNESS_OPACITY: ExpressionSpecification = ["match", ["get", "freshness"], "live", 0.98, "cached", 0.62, "stale", 0.25, "degraded", 0.38, "acquiring", 0.4, 0.15];

function partitionMapData(data: HunterSeekerFeatureCollection) {
  const live: HunterSeekerFeatureCollection["features"] = [];
  const cameras: HunterSeekerFeatureCollection["features"] = [];
  const regions: HunterSeekerFeatureCollection["features"] = [];
  for (const feature of data.features) {
    if (feature.properties.kind === "alpr-camera-point") cameras.push(feature);
    else if (feature.properties.kind === "deflock-region-point") regions.push(feature);
    else live.push(feature);
  }
  return {
    live: { type: "FeatureCollection", features: live } as HunterSeekerFeatureCollection,
    cameras: { type: "FeatureCollection", features: cameras } as HunterSeekerFeatureCollection,
    regions: { type: "FeatureCollection", features: regions } as HunterSeekerFeatureCollection,
  };
}

export function HunterSeekerMap({ observations, freshnessByObservationId, selectedId, onSelect, onDeflockRegionSelect, onPublicWebcamRegionSelect, onContextMenu }: {
  observations: HunterSeekerObservation[];
  freshnessByObservationId: Record<string, "live" | "cached" | "stale" | "degraded" | "acquiring" | "offline">;
  selectedId: string | null;
  onSelect: (observationId: string) => void;
  onDeflockRegionSelect: (regionId: string, regionLabel: string) => void;
  onPublicWebcamRegionSelect: (regionId: string, regionLabel: string, sourceId: string) => void;
  onContextMenu: (target: { observationId: string | null; latitude: number; longitude: number; clientX: number; clientY: number }) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const mapData = useMemo(() => partitionMapData(buildHunterSeekerMapData(observations, freshnessByObservationId)), [observations, freshnessByObservationId]);
  const dataRef = useRef<HunterSeekerFeatureCollection>(mapData.live);
  const deflockDataRef = useRef<HunterSeekerFeatureCollection>(mapData.cameras);
  const deflockRegionDataRef = useRef<HunterSeekerFeatureCollection>(mapData.regions);
  const selectRef = useRef(onSelect);
  const selectDeflockRegionRef = useRef(onDeflockRegionSelect);
  const selectPublicWebcamRegionRef = useRef(onPublicWebcamRegionSelect);
  const contextMenuRef = useRef(onContextMenu);
  const selectedRef = useRef(selectedId);
  const [status, setStatus] = useState<MapStatus>("connecting");

  useEffect(() => { selectRef.current = onSelect; }, [onSelect]);
  useEffect(() => { selectDeflockRegionRef.current = onDeflockRegionSelect; }, [onDeflockRegionSelect]);
  useEffect(() => { selectPublicWebcamRegionRef.current = onPublicWebcamRegionSelect; }, [onPublicWebcamRegionSelect]);
  useEffect(() => { contextMenuRef.current = onContextMenu; }, [onContextMenu]);

  useEffect(() => {
    dataRef.current = mapData.live;
    deflockDataRef.current = mapData.cameras;
    deflockRegionDataRef.current = mapData.regions;
    const source = mapRef.current?.getSource(LIVE_SOURCE_ID) as GeoJSONSource | undefined;
    const deflockSource = mapRef.current?.getSource(DEFLOCK_SOURCE_ID) as GeoJSONSource | undefined;
    const deflockRegionSource = mapRef.current?.getSource(DEFLOCK_REGION_SOURCE_ID) as GeoJSONSource | undefined;
    if (source) source.setData(mapData.live);
    if (deflockSource) deflockSource.setData(mapData.cameras);
    if (deflockRegionSource) deflockRegionSource.setData(mapData.regions);
  }, [mapData]);

  useEffect(() => {
    selectedRef.current = selectedId;
    const map = mapRef.current;
    if (!map) return;
    const filter: FilterSpecification = ["==", ["get", "observationId"], selectedId ?? "__none__"];
    for (const layerId of ["hunter-selected-area", "hunter-selected-point", "hunter-selected-camera"]) {
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
      infrastructure: token(styles, "--vc-intel-infrastructure"),
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
    const missingStyleImages = new Set<string>();
    const recoverMissingStyleImage = (event: { id: string }) => {
      if (!event.id || map.hasImage(event.id) || missingStyleImages.has(event.id)) return;
      missingStyleImages.add(event.id); map.addImage(event.id, { width: 1, height: 1, data: new Uint8Array(4) });
    };
    const stabilizeBasemapFonts = () => {
      for (const layer of map.getStyle().layers ?? []) if (layer.type === "symbol" && layer.layout?.["text-field"] !== undefined) {
        try { map.setLayoutProperty(layer.id, "text-font", ["Noto Sans Regular"]); } catch { /* a remote layer may disappear during a style swap */ }
      }
    };
    mapRef.current = map;
    map.addControl(new NavigationControl({ showCompass: false, visualizePitch: false }), "top-right");
    map.addControl(new ScaleControl({ maxWidth: 100, unit: "metric" }), "bottom-left");

    const setupLayers = () => {
      if (layersReady) return;
      layersReady = true;
      stabilizeBasemapFonts();
      map.addSource(LIVE_SOURCE_ID, { type: "geojson", data: dataRef.current });
      map.addSource(DEFLOCK_SOURCE_ID, { type: "geojson", data: deflockDataRef.current, cluster: true, clusterMaxZoom: 8, clusterRadius: 34 });
      map.addSource(DEFLOCK_REGION_SOURCE_ID, { type: "geojson", data: deflockRegionDataRef.current });
      map.addImage("hunter-military-aircraft-icon", createMapIcon("military-aircraft", colors), { pixelRatio: 2 });
      map.addImage("hunter-civilian-aircraft-icon", createMapIcon("civilian-aircraft", colors), { pixelRatio: 2 });
      map.addImage("hunter-maritime-vessel-icon", createMapIcon("maritime-vessel", colors), { pixelRatio: 2 });
      map.addImage("hunter-space-station-icon", createMapIcon("space-station", colors), { pixelRatio: 2 });
      map.addImage("hunter-weather-satellite-icon", createMapIcon("weather-satellite", colors), { pixelRatio: 2 });
      map.addImage("hunter-navigation-satellite-icon", createMapIcon("navigation-satellite", colors), { pixelRatio: 2 });
      map.addImage("hunter-science-satellite-icon", createMapIcon("science-satellite", colors), { pixelRatio: 2 });
      map.addImage("hunter-recent-launch-icon", createMapIcon("recent-launch", colors), { pixelRatio: 2 });
      map.addImage("hunter-visual-satellite-icon", createMapIcon("visual-satellite", colors), { pixelRatio: 2 });
      map.addImage("hunter-alpr-camera-icon", createMapIcon("alpr-camera", colors), { pixelRatio: 2 });
      map.addImage("hunter-public-webcam-icon", createMapIcon("public-webcam", colors), { pixelRatio: 2 });
      map.addImage("hunter-seismic-icon", createMapIcon("seismic", colors), { pixelRatio: 2 });
      map.addImage("hunter-weather-icon", createMapIcon("weather", colors), { pixelRatio: 2 });
      map.addImage("hunter-storm-icon", createMapIcon("storm", colors), { pixelRatio: 2 });
      map.addImage("hunter-wildfire-icon", createMapIcon("wildfire", colors), { pixelRatio: 2 });
      map.addImage("hunter-volcano-icon", createMapIcon("volcano", colors), { pixelRatio: 2 });
      map.addImage("hunter-flood-icon", createMapIcon("flood", colors), { pixelRatio: 2 });
      map.addImage("hunter-landslide-icon", createMapIcon("landslide", colors), { pixelRatio: 2 });
      map.addImage("hunter-drought-icon", createMapIcon("drought", colors), { pixelRatio: 2 });
      map.addImage("hunter-dust-haze-icon", createMapIcon("dust-haze", colors), { pixelRatio: 2 });
      map.addImage("hunter-ice-icon", createMapIcon("ice", colors), { pixelRatio: 2 });
      map.addImage("hunter-snow-icon", createMapIcon("snow", colors), { pixelRatio: 2 });
      map.addImage("hunter-temperature-icon", createMapIcon("temperature", colors), { pixelRatio: 2 });
      map.addImage("hunter-eonet-earthquake-icon", createMapIcon("seismic", colors), { pixelRatio: 2 });
      map.addImage("hunter-manmade-icon", createMapIcon("manmade", colors), { pixelRatio: 2 });
      map.addImage("hunter-water-color-icon", createMapIcon("water-color", colors), { pixelRatio: 2 });
      map.addImage("hunter-climate-icon", createMapIcon("climate", colors), { pixelRatio: 2 });
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
        id: "hunter-natural-event-points",
        type: "symbol",
        source: LIVE_SOURCE_ID,
        filter: ["in", ["get", "kind"], ["literal", ["storm-point", "wildfire-point", "volcano-point", "flood-point", "landslide-point", "drought-point", "dust-haze-point", "ice-point", "snow-point", "temperature-point", "eonet-earthquake-point", "manmade-point", "water-color-point", "climate-point"]]],
        layout: {
          "icon-image": ["match", ["get", "kind"], "storm-point", "hunter-storm-icon", "wildfire-point", "hunter-wildfire-icon", "volcano-point", "hunter-volcano-icon", "flood-point", "hunter-flood-icon", "landslide-point", "hunter-landslide-icon", "drought-point", "hunter-drought-icon", "dust-haze-point", "hunter-dust-haze-icon", "ice-point", "hunter-ice-icon", "snow-point", "hunter-snow-icon", "temperature-point", "hunter-temperature-icon", "eonet-earthquake-point", "hunter-eonet-earthquake-icon", "manmade-point", "hunter-manmade-icon", "water-color-point", "hunter-water-color-icon", "hunter-climate-icon"],
          "icon-size": ["interpolate", ["linear"], ["zoom"], 0, 0.42, 6, 0.62, 12, 0.82],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: { "icon-opacity": ICON_FRESHNESS_OPACITY },
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
        filter: ["in", ["get", "kind"], ["literal", ["space-station-point", "weather-satellite-point", "navigation-satellite-point", "science-satellite-point", "recent-launch-point", "visual-satellite-point"]]],
        layout: {
          "icon-image": ["match", ["get", "kind"], "weather-satellite-point", "hunter-weather-satellite-icon", "navigation-satellite-point", "hunter-navigation-satellite-icon", "science-satellite-point", "hunter-science-satellite-icon", "recent-launch-point", "hunter-recent-launch-icon", "visual-satellite-point", "hunter-visual-satellite-icon", "hunter-space-station-icon"],
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
        id: "hunter-public-webcam-region-points",
        type: "symbol",
        source: LIVE_SOURCE_ID,
        filter: ["==", ["get", "kind"], "public-webcam-region-point"],
        layout: { "icon-image": "hunter-public-webcam-icon", "icon-size": ["interpolate", ["linear"], ["zoom"], 0, 0.34, 5, 0.52, 9, 0.68], "icon-allow-overlap": true, "text-field": ["get", "regionLabel"], "text-size": 10, "text-offset": [0, 2.2], "text-optional": true },
        paint: { "icon-opacity": ICON_FRESHNESS_OPACITY, "text-color": colors.cyan, "text-halo-color": colors.canvas, "text-halo-width": 1 },
      });
      map.addLayer({
        id: "hunter-public-webcam-points",
        type: "symbol",
        source: LIVE_SOURCE_ID,
        filter: ["==", ["get", "kind"], "public-webcam-point"],
        layout: { "icon-image": "hunter-public-webcam-icon", "icon-size": ["interpolate", ["linear"], ["zoom"], 0, 0.38, 6, 0.58, 12, 0.8], "icon-allow-overlap": false, "icon-ignore-placement": false },
        paint: { "icon-opacity": ICON_FRESHNESS_OPACITY },
      });
      map.addLayer({
        id: "hunter-deflock-region-points",
        type: "symbol",
        source: DEFLOCK_REGION_SOURCE_ID,
        filter: ["==", ["get", "kind"], "deflock-region-point"],
        layout: {
          "icon-image": "hunter-alpr-camera-icon",
          "icon-size": ["interpolate", ["linear"], ["zoom"], 0, 0.38, 5, 0.56, 9, 0.72],
          "icon-allow-overlap": true,
          "text-field": ["get", "regionLabel"],
          "text-size": 10,
          "text-offset": [0, 2.2],
          "text-optional": true,
        },
        paint: { "icon-opacity": ICON_FRESHNESS_OPACITY, "text-color": colors.acid, "text-halo-color": colors.canvas, "text-halo-width": 1 },
      });
      map.addLayer({
        id: "hunter-alpr-camera-clusters",
        type: "circle",
        source: DEFLOCK_SOURCE_ID,
        filter: ["has", "point_count"],
        paint: {
          "circle-color": colors.canvas,
          "circle-radius": ["step", ["get", "point_count"], 13, 100, 18, 1_000, 24],
          "circle-stroke-color": colors.infrastructure,
          "circle-stroke-width": 3,
          "circle-opacity": 0.88,
        },
      });
      map.addLayer({
        id: "hunter-alpr-camera-cluster-count",
        type: "symbol",
        source: DEFLOCK_SOURCE_ID,
        filter: ["has", "point_count"],
        layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 10, "text-allow-overlap": true },
        paint: { "text-color": colors.acid, "text-halo-color": colors.canvas, "text-halo-width": 1 },
      });
      map.addLayer({
        id: "hunter-alpr-camera-points",
        type: "symbol",
        source: DEFLOCK_SOURCE_ID,
        filter: ["!", ["has", "point_count"]],
        layout: {
          "icon-image": "hunter-alpr-camera-icon",
          "icon-size": ["interpolate", ["linear"], ["zoom"], 5, 0.42, 9, 0.58, 12, 0.78],
          "icon-allow-overlap": false,
          "icon-ignore-placement": false,
        },
        paint: { "icon-opacity": ICON_FRESHNESS_OPACITY },
      });
      map.addLayer({
        id: "hunter-selected-camera",
        type: "circle",
        source: DEFLOCK_SOURCE_ID,
        filter: ["==", ["get", "observationId"], selectedRef.current ?? "__none__"],
        paint: { "circle-color": colors.acid, "circle-radius": 10, "circle-opacity": 0.24, "circle-stroke-color": colors.acid, "circle-stroke-width": 2 },
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
    const selectDeflockRegion = (event: MapLayerMouseEvent) => {
      const properties = event.features?.[0]?.properties;
      if (typeof properties?.regionId === "string") selectDeflockRegionRef.current(properties.regionId, typeof properties.regionLabel === "string" ? properties.regionLabel : properties.regionId);
    };
    const selectPublicWebcamRegion = (event: MapLayerMouseEvent) => {
      const properties = event.features?.[0]?.properties;
      if (typeof properties?.regionId === "string" && typeof properties?.sourceId === "string") selectPublicWebcamRegionRef.current(properties.regionId, typeof properties.regionLabel === "string" ? properties.regionLabel : properties.regionId, properties.sourceId);
    };
    const expandCameraCluster = (event: MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      const clusterId = Number(feature?.properties?.cluster_id);
      if (!Number.isFinite(clusterId) || feature?.geometry.type !== "Point") return;
      const source = map.getSource(DEFLOCK_SOURCE_ID) as GeoJSONSource | undefined;
      const coordinates = feature.geometry.coordinates as [number, number];
      void source?.getClusterExpansionZoom(clusterId).then((zoom) => map.easeTo({ center: coordinates, zoom, duration: 450 }));
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
    map.on("styleimagemissing", recoverMissingStyleImage);
    map.once("load", setupLayers);
    map.on("click", INTERACTIVE_LAYERS, pickObservation);
    map.on("click", "hunter-deflock-region-points", selectDeflockRegion);
    map.on("click", "hunter-public-webcam-region-points", selectPublicWebcamRegion);
    map.on("click", "hunter-alpr-camera-clusters", expandCameraCluster);
    map.on("mouseenter", INTERACTIVE_LAYERS, showPointer);
    map.on("mouseleave", INTERACTIVE_LAYERS, clearPointer);
    map.on("mouseenter", "hunter-alpr-camera-clusters", showPointer);
    map.on("mouseleave", "hunter-alpr-camera-clusters", clearPointer);
    map.on("mouseenter", "hunter-deflock-region-points", showPointer);
    map.on("mouseleave", "hunter-deflock-region-points", clearPointer);
    map.on("mouseenter", "hunter-public-webcam-region-points", showPointer);
    map.on("mouseleave", "hunter-public-webcam-region-points", clearPointer);
    map.on("contextmenu", openContextMenu);
    map.on("error", (event) => { const message = String(event.error?.message ?? ""); if (/glyph|sprite|image/i.test(message)) return; setStatus((current) => current === "fallback" ? current : "degraded"); });

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
