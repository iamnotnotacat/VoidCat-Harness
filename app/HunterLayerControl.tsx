/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0.
 * See LICENSE and NOTICE for attribution requirements. Original Code: VoidCat Harness.
 * Initial Developer: iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved.
 */
import { useMemo, useState } from "react";
import type { HunterSeekerSourceDefinition, HunterWorkspaceSettings } from "../build/hunter-seeker/source-workspace";
import type { HunterExplorerSourceState } from "./HunterSourceExplorer";

type Props = {
  definitions: readonly HunterSeekerSourceDefinition[];
  workspace: HunterWorkspaceSettings;
  sourceState: Record<string, HunterExplorerSourceState>;
  onWorkspaceChange: (next: HunterWorkspaceSettings) => void;
  onRefresh: (definition: HunterSeekerSourceDefinition) => void;
  onOpenSettings: (definition: HunterSeekerSourceDefinition) => void;
  onZoom: (definition: HunterSeekerSourceDefinition) => void;
};

export function HunterLayerControl({ definitions, workspace, sourceState, onWorkspaceChange, onRefresh, onOpenSettings, onZoom }: Props) {
  const [search, setSearch] = useState("");
  const layers = useMemo(() => definitions.filter((definition) => definition.capabilities.geometryTypes.some((type) => type !== "catalog") && workspace.sourcePreferences[definition.id]?.enabled).sort((a, b) => (workspace.sourcePreferences[a.id]?.order ?? 0) - (workspace.sourcePreferences[b.id]?.order ?? 0)), [definitions, workspace.sourcePreferences]);
  const shown = layers.filter((definition) => !search || `${definition.name} ${definition.category}`.toLowerCase().includes(search.toLowerCase()));
  const update = (definition: HunterSeekerSourceDefinition, changes: Partial<(typeof workspace.sourcePreferences)[string]>) => onWorkspaceChange({ ...workspace, activePresetId: null, sourcePreferences: { ...workspace.sourcePreferences, [definition.id]: { ...(workspace.sourcePreferences[definition.id] ?? definition.defaultSettings), ...changes } } });
  const move = (definition: HunterSeekerSourceDefinition, delta: number) => {
    const index = layers.findIndex((item) => item.id === definition.id);
    const other = layers[index + delta];
    if (!other) return;
    const currentPreference = workspace.sourcePreferences[definition.id] ?? definition.defaultSettings;
    const otherPreference = workspace.sourcePreferences[other.id] ?? other.defaultSettings;
    onWorkspaceChange({ ...workspace, activePresetId: null, sourcePreferences: { ...workspace.sourcePreferences, [definition.id]: { ...currentPreference, order: otherPreference.order }, [other.id]: { ...otherPreference, order: currentPreference.order } } });
  };
  if (workspace.layerControlCollapsed) return <button className="hunter-layer-control-launch" aria-label="Open map layer manager" onClick={() => onWorkspaceChange({ ...workspace, layerControlCollapsed: false })}>LAYERS {layers.filter((definition) => workspace.sourcePreferences[definition.id]?.layerVisible).length}</button>;
  return <section className="hunter-layer-control" aria-label="Map layer manager">
    <header><div><span>MAP DISPLAY</span><strong>LAYER MANAGER</strong></div><button aria-label="Collapse layer manager" onClick={() => onWorkspaceChange({ ...workspace, layerControlCollapsed: true })}>−</button></header>
    <label className="hunter-layer-search"><span className="sr-only">Search active map layers</span><input value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder="FILTER ACTIVE LAYERS" type="search" /></label>
    <div className="hunter-layer-list">{shown.map((definition, index) => {
      const preference = workspace.sourcePreferences[definition.id] ?? definition.defaultSettings;
      const state = sourceState[definition.id];
      return <article key={definition.id} className={!preference.layerVisible ? "hidden" : ""}>
        <div><button className={`hunter-layer-eye ${preference.layerVisible ? "active" : ""}`} aria-label={`${preference.layerVisible ? "Hide" : "Show"} ${definition.name}`} aria-pressed={preference.layerVisible} onClick={() => update(definition, { layerVisible: !preference.layerVisible })}>◉</button><i>{definition.icon}</i><button className="identity" onClick={() => onZoom(definition)}><strong>{definition.name}</strong><small><span className={`source-state-dot status-${state?.status ?? "offline"}`} /> {state?.observationCount ?? 0} ITEMS · {preference.renderMode.toUpperCase()}</small></button><button aria-label={`Settings for ${definition.name}`} onClick={() => onOpenSettings(definition)}>⚙</button></div>
        <label><span>OPACITY {Math.round(preference.opacity * 100)}%</span><input min={.1} max={1} step={.05} type="range" value={preference.opacity} onChange={(event) => update(definition, { opacity: Number(event.currentTarget.value) })} /></label>
        <nav aria-label={`Layer actions for ${definition.name}`}><button disabled={index === 0} aria-label={`Move ${definition.name} forward`} onClick={() => move(definition, -1)}>↑</button><button disabled={index === layers.length - 1} aria-label={`Move ${definition.name} backward`} onClick={() => move(definition, 1)}>↓</button><button onClick={() => onRefresh(definition)}>REFRESH</button><button onClick={() => onZoom(definition)}>ZOOM</button></nav>
      </article>;
    })}{!shown.length && <p>NO ACTIVE MAP LAYERS</p>}</div>
  </section>;
}

export function HunterDynamicLegend({ definitions, workspace, onWorkspaceChange }: Pick<Props, "definitions" | "workspace" | "onWorkspaceChange">) {
  const visible = definitions.filter((definition) => workspace.sourcePreferences[definition.id]?.enabled && workspace.sourcePreferences[definition.id]?.layerVisible && definition.capabilities.geometryTypes.some((type) => type !== "catalog"));
  if (!visible.length) return null;
  if (workspace.legendCollapsed) return <button className="hunter-legend-launch" onClick={() => onWorkspaceChange({ ...workspace, legendCollapsed: false })}>LEGEND {visible.length}</button>;
  return <section className="hunter-dynamic-legend" aria-label="Visible map source legend"><header><strong>VISIBLE INTELLIGENCE</strong><button aria-label="Collapse map legend" onClick={() => onWorkspaceChange({ ...workspace, legendCollapsed: true })}>−</button></header><div>{visible.map((definition) => <span key={definition.id} title={`${definition.capabilities.geometryTypes.join(", ")} // ${definition.attribution.requiredText}`}><i>{definition.icon}</i><b>{definition.name}</b><small>{definition.capabilities.geometryTypes.filter((type) => type !== "catalog").join(" + ").toUpperCase()}</small></span>)}</div><footer><span><i className="live" />LIVE</span><span><i className="cached" />CACHED</span><span><i className="stale" />STALE</span><span><i className="degraded" />DEGRADED</span><small>Icon identifies source/category; marker color communicates freshness. Severity labels and confidence values remain source-specific.</small></footer></section>;
}
