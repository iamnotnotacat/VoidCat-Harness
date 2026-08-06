/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0.
 * See LICENSE and NOTICE for attribution requirements.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  HUNTER_BUILT_IN_PRESETS,
  HUNTER_SOURCE_CATEGORIES,
  HUNTER_SOURCE_DEFINITIONS,
  filterHunterSources,
  sourceCategoryCheckState,
  type HunterSavedView,
  type HunterSeekerSourceDefinition,
  type HunterSourceCategory,
  type HunterWorkspaceSettings,
} from "../build/hunter-seeker/source-workspace";

export type HunterExplorerSourceState = {
  status: "live" | "cached" | "stale" | "degraded" | "acquiring" | "offline" | "disabled" | "scope-required" | "setup-required" | "adapter-required";
  statusText: string;
  observationCount: number;
  lastSuccessAt?: string;
  nextScheduledAt?: string;
  credentialState?: "not-required" | "checking" | "missing" | "saved" | "invalid";
  busy?: boolean;
  error?: string;
};

type Props = {
  definitions: readonly HunterSeekerSourceDefinition[];
  workspace: HunterWorkspaceSettings;
  sourceState: Record<string, HunterExplorerSourceState>;
  activeAlertsCount?: number;
  lastCompleteRefresh?: string;
  onWorkspaceChange: (next: HunterWorkspaceSettings) => void;
  onToggleSources: (definitions: readonly HunterSeekerSourceDefinition[], enabled: boolean) => void;
  onRefreshSources: (definitions: readonly HunterSeekerSourceDefinition[]) => void;
  onOpenSettings: (definition: HunterSeekerSourceDefinition) => void;
  onQuerySource: (definition: HunterSeekerSourceDefinition) => void;
  onApplyPreset: (preset: HunterSavedView) => void;
  onSavePreset: (name: string) => void;
  onDeletePreset: (id: string) => void;
  onRenamePreset: (id: string, name: string) => void;
  onDuplicatePreset: (preset: HunterSavedView) => void;
  onRestoreDefaults: () => void;
  onImportPreset: (preset: HunterSavedView) => void;
  onImportError: (message: string) => void;
};

function TriStateCheckbox({ state, label, disabled, onChange }: { state: "checked" | "unchecked" | "indeterminate"; label: string; disabled?: boolean; onChange: (checked: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = state === "indeterminate"; }, [state]);
  return <input ref={ref} aria-label={label} checked={state === "checked"} disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} type="checkbox" />;
}

function relativeTimestamp(value?: string) {
  if (!value) return "NEVER";
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed) || elapsed < 0) return "NOW";
  if (elapsed < 60_000) return "NOW";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}M AGO`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}H AGO`;
  return `${Math.floor(elapsed / 86_400_000)}D AGO`;
}

function exportPreset(preset: HunterSavedView) {
  const blob = new Blob([JSON.stringify(preset, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${preset.id}.voidcat-view.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function HunterSourceExplorer({ definitions, workspace, sourceState, activeAlertsCount = 0, lastCompleteRefresh, onWorkspaceChange, onToggleSources, onRefreshSources, onOpenSettings, onQuerySource, onApplyPreset, onSavePreset, onDeletePreset, onRenamePreset, onDuplicatePreset, onRestoreDefaults, onImportPreset, onImportError }: Props) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [presetName, setPresetName] = useState("");
  const [showPresetEditor, setShowPresetEditor] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const allPresets = useMemo(() => [...HUNTER_BUILT_IN_PRESETS, ...workspace.customPresets], [workspace.customPresets]);
  const filtered = useMemo(() => filterHunterSources(definitions, query).filter((definition) => {
    const state = sourceState[definition.id]; const enabled = workspace.sourcePreferences[definition.id]?.enabled ?? false;
    if (statusFilter === "all") return true;
    if (statusFilter === "enabled") return enabled;
    if (statusFilter === "disabled") return !enabled;
    if (statusFilter === "errors") return ["degraded", "offline", "adapter-required"].includes(state?.status ?? "offline");
    if (statusFilter === "missing-credentials") return state?.credentialState === "missing" || state?.credentialState === "invalid";
    return state?.status === statusFilter;
  }), [definitions, query, sourceState, statusFilter, workspace.sourcePreferences]);
  const statusCounts = useMemo(() => definitions.reduce((counts, definition) => { const status = sourceState[definition.id]?.status ?? "offline"; counts[status] = (counts[status] ?? 0) + 1; return counts; }, {} as Record<string, number>), [definitions, sourceState]);
  const missingCredentialCount = useMemo(() => definitions.filter((definition) => ["missing", "invalid"].includes(sourceState[definition.id]?.credentialState ?? "not-required")).length, [definitions, sourceState]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "/" && !event.ctrlKey && !event.metaKey && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) { event.preventDefault(); searchRef.current?.focus(); }
      if (event.altKey && event.key.toLowerCase() === "e") onWorkspaceChange({ ...workspace, explorerCollapsed: !workspace.explorerCollapsed });
      if (event.altKey && event.key.toLowerCase() === "d") {
        event.preventDefault();
        onWorkspaceChange({ ...workspace, activePresetId: null, sourcePreferences: Object.fromEntries(definitions.map((definition) => [definition.id, { ...(workspace.sourcePreferences[definition.id] ?? definition.defaultSettings), layerVisible: false }])) });
      }
      if (event.altKey && event.key.toLowerCase() === "r") {
        event.preventDefault();
        onRefreshSources(definitions.filter((definition) => workspace.sourcePreferences[definition.id]?.enabled));
      }
      if (event.altKey && event.key.toLowerCase() === "s") {
        const selected = definitions.find((definition) => workspace.sourcePreferences[definition.id]?.enabled) ?? definitions[0];
        if (selected) { event.preventDefault(); onOpenSettings(selected); }
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [definitions, onOpenSettings, onRefreshSources, onWorkspaceChange, workspace]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!resizeStart.current) return;
      const width = Math.max(240, Math.min(480, resizeStart.current.width + event.clientX - resizeStart.current.x));
      onWorkspaceChange({ ...workspace, explorerWidth: width });
    };
    const up = () => { resizeStart.current = null; document.body.classList.remove("hunter-resizing"); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [onWorkspaceChange, workspace]);

  if (workspace.explorerCollapsed) return <aside className="hunter-source-explorer collapsed" aria-label="Collapsed source explorer"><button aria-label="Open source explorer" title="Open Source Explorer (Alt+E)" onClick={() => onWorkspaceChange({ ...workspace, explorerCollapsed: false })}>SOURCES <span>{definitions.filter((definition) => workspace.sourcePreferences[definition.id]?.enabled).length}</span></button></aside>;

  const updateCategory = (category: HunterSourceCategory, value: boolean) => onWorkspaceChange({ ...workspace, categoryExpanded: { ...workspace.categoryExpanded, [category]: value } });
  const enabledFiltered = filtered.filter((definition) => workspace.sourcePreferences[definition.id]?.enabled);
  const enabledTotal = definitions.filter((definition) => workspace.sourcePreferences[definition.id]?.enabled).length;
  return <aside className="hunter-source-explorer" aria-label="Source Explorer" style={{ "--hunter-explorer-width": `${workspace.explorerWidth}px` } as React.CSSProperties}>
    <header className="hunter-explorer-title"><div><span>{HUNTER_SOURCE_DEFINITIONS.length} INTEGRATED CATALOG // {Math.max(0, definitions.length - HUNTER_SOURCE_DEFINITIONS.length)} ORIGINAL EXTENSIONS</span><strong>LIVE SOURCE MATRIX</strong></div><button aria-label="Collapse source explorer" title="Collapse Source Explorer (Alt+E)" onClick={() => onWorkspaceChange({ ...workspace, explorerCollapsed: true })}>◀</button></header>
    <section className="hunter-explorer-tools" aria-label="Source search and filters">
      <label><span>SEARCH</span><input ref={searchRef} value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Name, provider, category…  /" type="search" /></label>
      <label><span>STATUS</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.currentTarget.value)}><option value="all">ALL</option><option value="enabled">ENABLED</option><option value="disabled">DISABLED</option><option value="errors">ERRORS</option><option value="missing-credentials">MISSING CREDENTIALS</option><option value="scope-required">QUERY SCOPE REQUIRED</option><option value="live">LIVE</option><option value="cached">CACHED</option><option value="stale">STALE</option></select></label>
      <div className="hunter-explorer-quick"><button disabled={!filtered.length} onClick={() => onToggleSources(filtered, true)}>ENABLE MATCHES</button><button disabled={!enabledFiltered.length} onClick={() => onToggleSources(enabledFiltered, false)}>DISABLE MATCHES</button><button disabled={!enabledFiltered.length} onClick={() => onRefreshSources(enabledFiltered)}>REFRESH ACTIVE</button></div>
      <div className="hunter-explorer-status-summary" aria-label="Source status summary"><span>{enabledTotal} ENABLED</span><span>{statusCounts.acquiring ?? 0} LOADING</span><span>{statusCounts.live ?? 0} HEALTHY</span><span>{statusCounts.stale ?? 0} STALE</span><span>{(statusCounts.degraded ?? 0) + (statusCounts.offline ?? 0)} FAILING</span><span>{missingCredentialCount} CREDENTIALS</span><span>{activeAlertsCount} ALERTS</span><span>REFRESH {relativeTimestamp(lastCompleteRefresh)}</span></div>
    </section>
    <section className="hunter-preset-strip" aria-label="Source presets">
      <label><span>VIEW PRESET</span><select value={workspace.activePresetId ?? ""} onChange={(event) => { const preset = allPresets.find((item) => item.id === event.currentTarget.value); if (preset) onApplyPreset(preset); }}><option value="">CUSTOM / CURRENT</option>{allPresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name.toUpperCase()}</option>)}</select></label>
      <button aria-expanded={showPresetEditor} onClick={() => setShowPresetEditor((value) => !value)}>SAVE VIEW</button>
      {showPresetEditor && <div className="hunter-preset-editor"><input aria-label="Saved view name" maxLength={80} onChange={(event) => setPresetName(event.currentTarget.value)} placeholder="VIEW NAME" value={presetName} /><button disabled={!presetName.trim()} onClick={() => { onSavePreset(presetName.trim()); setPresetName(""); setShowPresetEditor(false); }}>SAVE</button><button onClick={() => importRef.current?.click()}>IMPORT</button><button onClick={onRestoreDefaults}>RESTORE DEFAULTS</button><input ref={importRef} className="sr-only" accept="application/json,.json" type="file" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (!file) return; void file.text().then((text) => { const parsed = JSON.parse(text) as HunterSavedView; if (!parsed || typeof parsed.id !== "string" || typeof parsed.name !== "string" || !Array.isArray(parsed.sourceIds) || !Array.isArray(parsed.visibleSourceIds)) throw new Error("The selected file is not a VoidCat source-view preset."); onImportPreset(parsed); }).catch((error: unknown) => onImportError(error instanceof Error ? error.message : "The saved view could not be imported.")); event.currentTarget.value = ""; }} />{workspace.customPresets.map((preset) => <div key={preset.id}><span>{preset.name}</span><button onClick={() => { const name = window.prompt("Rename saved view", preset.name)?.trim(); if (name) onRenamePreset(preset.id, name); }}>RENAME</button><button onClick={() => onDuplicatePreset(preset)}>DUPLICATE</button><button onClick={() => exportPreset(preset)}>EXPORT</button><button onClick={() => onDeletePreset(preset.id)}>DELETE</button></div>)}</div>}
    </section>
    <div className="hunter-explorer-list" role="tree" aria-label={`${filtered.length} matching intelligence sources`}>
      {HUNTER_SOURCE_CATEGORIES.map((category) => {
        const items = filtered.filter((definition) => definition.category === category.id);
        if (!items.length) return null;
        const state = sourceCategoryCheckState(items, workspace);
        const expanded = workspace.categoryExpanded[category.id] ?? false;
        const liveCount = items.filter((definition) => sourceState[definition.id]?.status === "live").length;
        const enabledItems = items.filter((definition) => workspace.sourcePreferences[definition.id]?.enabled);
        const aggregateStatus = enabledItems.some((definition) => ["degraded", "offline"].includes(sourceState[definition.id]?.status ?? "offline")) ? "ATTENTION" : enabledItems.some((definition) => sourceState[definition.id]?.status === "stale") ? "STALE" : enabledItems.some((definition) => sourceState[definition.id]?.status === "acquiring") ? "LOADING" : liveCount ? "HEALTHY" : "IDLE";
        return <section className="hunter-source-category" key={category.id}>
          <header>
            <TriStateCheckbox state={state} label={`${state === "checked" ? "Disable" : "Enable"} all ${category.name} sources`} disabled={!items.length} onChange={(checked) => onToggleSources(items, checked)} />
            <button aria-expanded={expanded} onClick={() => updateCategory(category.id, !expanded)}><i>{category.icon}</i><strong>{category.name}</strong><span>{items.filter((definition) => workspace.sourcePreferences[definition.id]?.enabled).length}/{items.length} ON · {liveCount} LIVE · {aggregateStatus}</span><b>{expanded ? "−" : "+"}</b></button>
          </header>
          {expanded && <div role="group">{items.sort((a, b) => (workspace.sourcePreferences[a.id]?.order ?? 0) - (workspace.sourcePreferences[b.id]?.order ?? 0)).map((definition) => {
            const preference = workspace.sourcePreferences[definition.id] ?? definition.defaultSettings;
            const state = sourceState[definition.id] ?? { status: "offline", statusText: "NOT LOADED", observationCount: 0 };
            const hasMapLayer = definition.capabilities.geometryTypes.some((geometry) => geometry !== "catalog");
            return <article className={`hunter-explorer-source status-${state.status}`} key={definition.id} role="treeitem" aria-selected={preference.enabled}>
              <div className="hunter-source-row">
                <input aria-label={`${preference.enabled ? "Disable" : "Enable"} ${definition.name} retrieval`} checked={preference.enabled} disabled={state.busy} onChange={(event) => onToggleSources([definition], event.currentTarget.checked)} type="checkbox" />
                <i>{definition.icon}</i><button className="hunter-source-identity" onClick={() => hasMapLayer ? onWorkspaceChange({ ...workspace, sourcePreferences: { ...workspace.sourcePreferences, [definition.id]: { ...preference, layerVisible: !preference.layerVisible } }, activePresetId: null }) : onQuerySource(definition)}><strong>{definition.name}</strong><small>{definition.provider} · {definition.capabilities.live ? "LIVE" : definition.capabilities.historical ? "HISTORICAL" : "CATALOG"}</small></button>
                {hasMapLayer && <button className={`hunter-layer-eye ${preference.layerVisible ? "active" : ""}`} aria-label={`${preference.layerVisible ? "Hide" : "Show"} ${definition.name} on map without changing retrieval`} aria-pressed={preference.layerVisible} onClick={() => onWorkspaceChange({ ...workspace, sourcePreferences: { ...workspace.sourcePreferences, [definition.id]: { ...preference, layerVisible: !preference.layerVisible } }, activePresetId: null })}>◉</button>}
                <button aria-label={`Open settings for ${definition.name}`} title={`Source settings: ${definition.name}`} onClick={() => onOpenSettings(definition)}>⚙</button>
              </div>
              <div className="hunter-source-telemetry"><span className={`source-state-dot status-${state.status}`} /> <b>{state.statusText}</b><span>{state.observationCount.toLocaleString()} ITEMS</span><span>LAST {relativeTimestamp(state.lastSuccessAt)}</span>{state.credentialState === "missing" || state.credentialState === "invalid" ? <em>CREDENTIAL {state.credentialState.toUpperCase()}</em> : null}</div>
              {state.error && <p>{state.error}</p>}
            </article>;
          })}</div>}
        </section>;
      })}
      {!filtered.length && <div className="hunter-explorer-empty"><strong>NO SOURCES MATCH</strong><span>Clear the search or change the status filter.</span></div>}
    </div>
    <footer><span>{definitions.filter((definition) => workspace.sourcePreferences[definition.id]?.enabled).length} RETRIEVING</span><span>{definitions.filter((definition) => workspace.sourcePreferences[definition.id]?.enabled && workspace.sourcePreferences[definition.id]?.layerVisible).length} LAYERS VISIBLE</span></footer>
    <div className="hunter-explorer-resize" role="separator" aria-label="Resize Source Explorer" aria-orientation="vertical" onPointerDown={(event) => { resizeStart.current = { x: event.clientX, width: workspace.explorerWidth }; document.body.classList.add("hunter-resizing"); }} />
  </aside>;
}
