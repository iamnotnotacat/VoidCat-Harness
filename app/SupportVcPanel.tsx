"use client";

import { useEffect, useRef, useState } from "react";
import { SUPPORT_VC_LINKS } from "./support-vc-links";

export function SupportVcPanel() {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const resetTimer = useRef<number | null>(null);

  useEffect(() => () => { if (resetTimer.current !== null) window.clearTimeout(resetTimer.current); }, []);

  async function copyHandle(handle: string) {
    try {
      await navigator.clipboard.writeText(handle);
      setCopyStatus("copied");
    } catch { setCopyStatus("failed"); }
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopyStatus("idle"), 2_000);
  }

  return <section className="support-vc phase-panel" aria-labelledby="support-vc-title">
    <header className="support-vc-header">
      <div><p className="kicker">SUPPORT CHANNEL {"//"} VOLUNTARY</p><h2 id="support-vc-title">SUPPORT_VC</h2></div>
      <p>Support is entirely voluntary. If you find VoidCat useful, these links help keep the project running and independent.</p>
    </header>
    <div className="support-vc-grid">
      {SUPPORT_VC_LINKS.map((item) => <article className={item.primary ? "support-vc-card primary" : "support-vc-card"} key={item.id}>
        <div className="support-vc-card-code" aria-hidden="true">{item.primary ? "PRIMARY // 01" : item.id === "library" ? "PROJECT // 02" : "NETWORK // 03"}</div>
        <h3>{item.title}</h3>
        {item.handle && <div className="support-vc-handle"><code>{item.handle}</code><button type="button" onClick={() => void copyHandle(item.handle!)} aria-label={`Copy Cash App handle ${item.handle}`}>COPY HANDLE</button><span className={`copy-status ${copyStatus}`} role="status" aria-live="polite">{copyStatus === "copied" ? "Copied!" : copyStatus === "failed" ? "Copy failed" : ""}</span></div>}
        <a href={item.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${item.title} in a new window`}><span>{item.url}</span><b aria-hidden="true">↗</b></a>
        <p>{item.description}</p>
      </article>)}
    </div>
    <footer>NO TRACKING {"//"} NO ANALYTICS {"//"} EXTERNAL LINKS OPEN ONLY WHEN SELECTED</footer>
  </section>;
}
