/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0.
 * See LICENSE and NOTICE for attribution requirements. Original Code: VoidCat Harness.
 * Initial Developer: iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved.
 */
/* Source configuration remains metadata-driven; secrets are delegated to Electron's protected broker. */
import { useEffect, useMemo, useRef, useState } from "react";
import type { HunterSeekerSourceDefinition, HunterSettingField, HunterSettingSection, HunterSourcePreference } from "../build/hunter-seeker/source-workspace";
import type { HunterExplorerSourceState } from "./HunterSourceExplorer";

const SECTIONS: readonly { id: HunterSettingSection; label: string }[] = [
  { id: "connection", label: "Connection" }, { id: "refresh", label: "Refresh" }, { id: "display", label: "Map + Display" }, { id: "filters", label: "Filters" }, { id: "alerts", label: "Alerts + Analysis" }, { id: "policy", label: "Privacy + Policy" }, { id: "advanced", label: "Advanced" },
];

type Props = {
  definition: HunterSeekerSourceDefinition;
  preference: HunterSourcePreference;
  state: HunterExplorerSourceState;
  refreshIntervalMs?: number;
  requestBudgetPercent?: number;
  onClose: () => void;
  onApply: (preference: HunterSourcePreference, operational: { pollCadenceMs?: number; requestBudgetPercent?: number }) => void;
  onSave: (preference: HunterSourcePreference, operational: { pollCadenceMs?: number; requestBudgetPercent?: number }) => void;
  onReset: () => void;
  onConfigureCredential: () => void;
  onQuery?: () => void;
  onTest: () => void;
  onRemoveCredential?: () => void;
};

function preferenceValue(preference: HunterSourcePreference, field: HunterSettingField): string | number | boolean {
  if (field.id in preference && field.id !== "filters") return preference[field.id as keyof HunterSourcePreference] as string | number | boolean;
  return preference.filters[field.id] ?? (field.type === "boolean" ? false : field.type === "number" || field.type === "range" ? field.minimum ?? 0 : "");
}

function updatePreference(preference: HunterSourcePreference, field: HunterSettingField, value: string | number | boolean): HunterSourcePreference {
  if (field.id in preference && field.id !== "filters") return { ...preference, [field.id]: value };
  return { ...preference, filters: { ...preference.filters, [field.id]: value } };
}

export function HunterSourceSettingsDialog({ definition, preference, state, refreshIntervalMs, requestBudgetPercent, onClose, onApply, onSave, onReset, onConfigureCredential, onQuery, onTest, onRemoveCredential }: Props) {
  const [draft, setDraft] = useState(preference);
  const [cadence, setCadence] = useState(refreshIntervalMs ?? preference.refreshIntervalSeconds * 1000);
  const [budget, setBudget] = useState(requestBudgetPercent ?? preference.requestBudgetPercent);
  const [section, setSection] = useState<HunterSettingSection>(definition.capabilities.supportsCredentials ? "connection" : "refresh");
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const fields = useMemo(() => definition.settingsSchema.filter((field) => field.section === section), [definition, section]);
  useEffect(() => { closeRef.current?.focus(); }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { onClose(); return; }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href]')];
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [onClose]);

  const renderField = (field: HunterSettingField) => {
    if (field.type === "secret") return <div className="hunter-settings-credential" key={field.id}><div><strong>PROTECTED CREDENTIAL</strong><span>{state.credentialState === "saved" ? "SAVED // VALUE NEVER RETURNED TO UI" : state.credentialState === "checking" ? "CHECKING PROTECTED STORE" : "NOT CONFIGURED"}</span></div><div><button onClick={onConfigureCredential}>{state.credentialState === "saved" ? "REPLACE" : "CONFIGURE"}</button><button onClick={onTest}>TEST CONNECTION</button>{state.credentialState === "saved" && onRemoveCredential && <button className="danger" onClick={onRemoveCredential}>REMOVE</button>}</div></div>;
    if (field.type === "readonly") return <div className="hunter-setting-readonly" key={field.id}><span>{field.label}</span><strong>{definition.attribution.license}</strong><a href={definition.attribution.termsUrl} target="_blank" rel="noopener noreferrer">PROVIDER TERMS -&gt;</a></div>;
    if (field.id === "automaticRefresh") return <label className="hunter-setting-field toggle" key={field.id}><input checked={draft.automaticRefresh} onChange={(event) => setDraft({ ...draft, automaticRefresh: event.currentTarget.checked })} type="checkbox" /><span><strong>{field.label}</strong><small>{field.description}</small></span></label>;
    if (field.id === "refreshIntervalSeconds") return <label className="hunter-setting-field" key={field.id}><span><strong>{field.label}</strong><small>Provider minimum {definition.refreshConstraints?.minimumIntervalSeconds ?? 30}s. Faster requests are blocked.</small></span><input min={definition.refreshConstraints?.minimumIntervalSeconds ?? field.minimum} max={field.maximum} step={field.step} type="number" value={Math.round(cadence / 1000)} onChange={(event) => setCadence(Math.max(definition.refreshConstraints?.minimumIntervalSeconds ?? 30, Number(event.currentTarget.value)) * 1000)} /></label>;
    const value = preferenceValue(draft, field);
    if (field.type === "boolean") return <label className="hunter-setting-field toggle" key={field.id}><input checked={Boolean(value)} onChange={(event) => setDraft((current) => updatePreference(current, field, event.currentTarget.checked))} type="checkbox" /><span><strong>{field.label}</strong><small>{field.description}</small></span></label>;
    if (field.type === "select") return <label className="hunter-setting-field" key={field.id}><span><strong>{field.label}</strong><small>{field.description}</small></span><select value={String(value)} onChange={(event) => setDraft((current) => updatePreference(current, field, event.currentTarget.value))}>{field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
    if (field.type === "range") return <label className="hunter-setting-field range" key={field.id}><span><strong>{field.label}</strong><b>{typeof value === "number" ? value.toFixed(field.step && field.step < 1 ? 2 : 0) : value}</b><small>{field.description}</small></span><input min={field.minimum} max={field.maximum} step={field.step} type="range" value={Number(value)} onChange={(event) => setDraft((current) => updatePreference(current, field, Number(event.currentTarget.value)))} /></label>;
    return <label className="hunter-setting-field" key={field.id}><span><strong>{field.label}</strong><small>{field.description}</small></span><input min={field.minimum} max={field.maximum} step={field.step} type={field.type === "number" ? "number" : "text"} value={String(value)} onChange={(event) => setDraft((current) => updatePreference(current, field, field.type === "number" ? Number(event.currentTarget.value) : event.currentTarget.value))} /></label>;
  };

  return <div className="hunter-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="hunter-source-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="hunter-source-settings-title">
      <header><div><span>{definition.category.replaceAll("-", " ").toUpperCase()} // {definition.provider.toUpperCase()}</span><strong id="hunter-source-settings-title">{definition.name}</strong><small>{definition.description}</small></div><button ref={closeRef} aria-label="Close source settings" onClick={onClose}>X</button></header>
      <div className="hunter-settings-status"><span className={`source-state-dot status-${state.status}`} /><strong>{state.statusText}</strong><span>{state.observationCount.toLocaleString()} OBSERVATIONS</span><span>{definition.capabilities.geometryTypes.join(" + ").toUpperCase()}</span>{onQuery && <button className="hunter-settings-query" onClick={onQuery}>SET QUERY SCOPE</button>}</div>
      <div className="hunter-settings-body">
        <nav aria-label="Source settings sections">{SECTIONS.filter((item) => definition.settingsSchema.some((field) => field.section === item.id)).map((item) => <button className={section === item.id ? "active" : ""} key={item.id} onClick={() => setSection(item.id)}>{item.label}</button>)}</nav>
        <div className="hunter-settings-fields">{fields.map(renderField)}
          {section === "refresh" && <label className="hunter-setting-field range"><span><strong>LOCAL REQUEST BUDGET</strong><b>{budget}%</b><small>Reduces local traffic but can never exceed provider ceilings.</small></span><input min={10} max={100} step={10} type="range" value={budget} onChange={(event) => setBudget(Number(event.currentTarget.value))} /></label>}
          {section === "policy" && <><div className="hunter-policy-note"><strong>ATTRIBUTION + DATA POLICY</strong><p>Provider: {definition.provider}. Required attribution: {definition.attribution.requiredText}. Terms last reviewed: {definition.attribution.lastReviewedAt}. Redistribution and automated-analysis restrictions follow the linked provider terms.</p><a href={definition.attribution.termsUrl} target="_blank" rel="noopener noreferrer">OPEN PROVIDER TERMS -&gt;</a></div><div className="hunter-policy-note"><strong>EXTERNAL DATA BOUNDARY</strong><p>Only bounded provider requests leave this computer. Credentials remain in Electron's protected main process and are excluded from saved views and exported settings.</p></div></>}
          {section === "advanced" && <div className="hunter-policy-note warning"><strong>OPERATOR CAUTION</strong><p>Debug output is redacted and bounded. Changing caches or record limits cannot bypass shared traffic and storage safety budgets.</p></div>}
        </div>
      </div>
      <footer><button onClick={onReset}>RESET TO SOURCE DEFAULTS</button><div><button onClick={onClose}>CANCEL</button><button onClick={() => onApply({ ...draft, refreshIntervalSeconds: Math.round(cadence / 1000), requestBudgetPercent: budget, minimumZoom: Math.min(draft.minimumZoom, draft.maximumZoom), maximumZoom: Math.max(draft.minimumZoom, draft.maximumZoom) }, { pollCadenceMs: cadence, requestBudgetPercent: budget })}>APPLY</button><button className="primary-action" onClick={() => onSave({ ...draft, refreshIntervalSeconds: Math.round(cadence / 1000), requestBudgetPercent: budget, minimumZoom: Math.min(draft.minimumZoom, draft.maximumZoom), maximumZoom: Math.max(draft.minimumZoom, draft.maximumZoom) }, { pollCadenceMs: cadence, requestBudgetPercent: budget })}>SAVE</button></div></footer>
    </section>
  </div>;
}
