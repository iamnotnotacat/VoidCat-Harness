const TIER_ONE_FEEDS = [
  ["SEISMIC", "USGS earthquakes"],
  ["WEATHER", "NOAA / NWS alerts"],
  ["AVIATION", "adsb.lol military aircraft"],
  ["ORBITAL", "CelesTrak space stations"],
] as const;

const STORAGE_BUDGETS = [
  ["OBSERVATIONS", "5 GB", "REGISTERED // HISTORY OPT-IN AVAILABLE"],
  ["CHAT MEMORY", "500 MB", "REGISTERED // MANUAL SCOPE PROTECTED"],
  ["IMAGERY CACHE", "2 GB", "REGISTERED // CACHE WRITES NOT ACTIVE"],
] as const;

export function HunterSeekerSetupGuide({ step, maritimeCredentialSaved, maritimeCredentialFingerprint, activePublicSources, skippedPublicSources, onStep, onClose, onSkip, onComplete, onConfigureMaritime, onRetestMaritime, onRemoveMaritime }: {
  step: number;
  maritimeCredentialSaved: boolean | null;
  maritimeCredentialFingerprint: string | null;
  activePublicSources: number;
  skippedPublicSources: number;
  onStep: (step: number) => Promise<void>;
  onClose: () => void;
  onSkip: () => Promise<void>;
  onComplete: () => Promise<void>;
  onConfigureMaritime: () => void;
  onRetestMaritime: () => Promise<void>;
  onRemoveMaritime: () => Promise<void>;
}) {
  const currentStep = Math.max(0, Math.min(4, step));
  const titles = ["LIVE BEFORE SETUP", "OPTIONAL MARITIME LINK", "FEED CONTROLS", "STORAGE BOUNDARY", "SETUP SUMMARY"];
  const advance = () => currentStep === 4 ? onComplete() : onStep(currentStep + 1);

  return <div className="hunter-setup-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="hunter-setup-dialog" role="dialog" aria-modal="true" aria-labelledby="hunter-setup-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span>VC HUNTER-SEEKER {"//"} SETUP GUIDE</span><strong id="hunter-setup-title">{titles[currentStep]}</strong></div><button aria-label="Close setup guide" onClick={onClose}>×</button></header>
      <nav aria-label="Setup progress">{titles.map((title, index) => <button className={index === currentStep ? "active" : index < currentStep ? "complete" : ""} key={title} onClick={() => void onStep(index)}><span>{String(index + 1).padStart(2, "0")}</span><b>{index < currentStep ? "DONE" : index === currentStep ? "ACTIVE" : "WAIT"}</b></button>)}</nav>

      <div className="hunter-setup-content">
        {currentStep === 0 && <><p className="hunter-setup-lead">Hunter-Seeker already has useful public, credential-free sources. The live board remains passive and bounded. Historical recording is a separate opt-in control.</p><div className="hunter-setup-feed-grid">{TIER_ONE_FEEDS.map(([category, name]) => <article key={category}><span>{category}</span><strong>{name}</strong><small>ZERO SETUP // LIVE</small></article>)}</div></>}

        {currentStep === 1 && <><p className="hunter-setup-lead">A free aisstream.io account unlocks live vessel positions for one selected region. The API key is encrypted by Windows and never returns to this screen.</p><article className="hunter-setup-access"><b>AIS</b><div><span>FREE ACCOUNT REQUIRED</span><strong>AISSTREAM.IO MARITIME</strong><small>{maritimeCredentialSaved === null ? "CHECKING PROTECTED STORAGE" : maritimeCredentialSaved ? `CREDENTIAL ${maritimeCredentialFingerprint ?? "STORED"}` : "NO CREDENTIAL"}</small></div><a href="https://aisstream.io/authenticate" target="_blank" rel="noreferrer">OPEN OFFICIAL SIGN-IN ↗</a></article><div className="hunter-setup-inline-actions"><button className="primary-action" onClick={onConfigureMaritime}>{maritimeCredentialSaved ? "REPLACE KEY / REGION" : "ADD API KEY"}</button>{maritimeCredentialSaved && <button className="local-only-action" onClick={() => void onRetestMaritime()}>RETEST SAVED KEY</button>}{maritimeCredentialSaved && <button className="danger-action" onClick={() => void onRemoveMaritime()}>REMOVE SAVED KEY</button>}</div></>}

        {currentStep === 2 && <><p className="hunter-setup-lead">The live source matrix is the settings surface for enabled state and pull cadence. Every layer is independent, and changing one cannot stop the others.</p><div className="hunter-setup-rule-grid"><article><span>ENABLE / DISABLE</span><strong>INDEPENDENT PER SOURCE</strong><small>Re-enabling inside the selected cadence restores the last valid snapshot.</small></article><article><span>PULL CADENCE</span><strong>30 SEC — 12 HR</strong><small>Provider floors, credit budgets, and retry limits always remain enforced.</small></article><article><span>OPENSKY NOTICE</span><strong>LICENSE REVIEW REQUIRED</strong><small>Operational REST API use requires provider permission. The layer starts disabled until the operator deliberately enables it.</small></article></div></>}

        {currentStep === 3 && <><p className="hunter-setup-lead">The shared manager measures each storage class, projects capacity, and blocks historical writes at the safe watermark. Recording starts off and must be enabled from the History console. Generic clear remains approval-locked.</p><div className="hunter-setup-budget-list">{STORAGE_BUDGETS.map(([name, limit, state]) => <article key={name}><span>{name}</span><strong>{limit}</strong><small>{state}</small></article>)}</div></>}

        {currentStep === 4 && <><p className="hunter-setup-lead">The live board is ready. Setup can be reopened at any time from SETTINGS / SETUP on the Situation Board.</p><div className="hunter-setup-summary"><article><span>PUBLIC SOURCES</span><strong>{activePublicSources} ACTIVE / {skippedPublicSources} SKIPPED</strong></article><article><span>MARITIME</span><strong>{maritimeCredentialSaved ? "READY" : "SKIPPED"}</strong></article><article><span>HISTORY</span><strong>OPT-IN AVAILABLE</strong></article></div></>}
      </div>

      <footer><button className="cancel-action" disabled={currentStep === 0} onClick={() => void onStep(currentStep - 1)}>BACK</button><button className="local-only-action" onClick={() => currentStep === 4 ? void advance() : void onSkip()}>{currentStep === 4 ? "FINISH" : "SKIP FOR NOW"}</button>{currentStep < 4 && <button className="primary-action" onClick={() => void advance()}>CONTINUE</button>}</footer>
    </section>
  </div>;
}
