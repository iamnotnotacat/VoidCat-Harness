"use client";

import { useEffect, useMemo, useState } from "react";
import { OSINT4ALL_LINKS, OSINT4ALL_SOURCE_URL, describeOsintDirectoryEntry } from "./osint4all-links";
import { useNotifications } from "./NotificationCenter";

type Source = { id: string; name: string; homepage: string; description: string; minimumCadenceMs: number };
type Item = { id: string; sourceId: string; sourceName: string; title: string; url: string; summary: string; publishedAt: string | null; retrievedAt: string };
type Status = { id: string; name: string; lastSuccessfulFetchAt: string | null; nextAllowedAt: string | null; cachedItems: number; error: string | null };
const awarenessPattern = /news|liveuamap|wildfire|earthquake|crisis|conflict|war map|incident|disaster|alert/i;
const awarenessLinks = OSINT4ALL_LINKS.filter((entry) => awarenessPattern.test(`${entry.name} ${entry.url}`));

export function NewsPanel() {
  const { notify } = useNotifications(); const [sources, setSources] = useState<Source[]>([]); const [enabled, setEnabled] = useState<string[]>([]); const [items, setItems] = useState<Item[]>([]); const [status, setStatus] = useState<Status[]>([]); const [loading, setLoading] = useState(false); const [query, setQuery] = useState("");
  useEffect(() => { void fetch("/api/news/sources").then((response) => response.json()).then((data: { sources?: Source[] }) => { const next = data.sources ?? []; setSources(next); setEnabled(next.map(({ id }) => id)); }).catch(() => { /* local service retry remains available */ }); }, []);
  const visible = useMemo(() => items.filter((item) => `${item.title} ${item.summary} ${item.sourceName}`.toLowerCase().includes(query.toLowerCase())), [items, query]);
  async function refresh(force = false) {
    if (!enabled.length || loading) return; setLoading(true);
    try {
      const response = await fetch("/api/news/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceIds: enabled, force }) }); const data = await response.json() as { items?: Item[]; status?: Status[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? "News feeds could not be refreshed."); setItems(data.items ?? []); setStatus(data.status ?? []);
      const failures = (data.status ?? []).filter(({ error }) => error).length; notify({ tone: failures ? "warning" : "success", title: "News pull complete", message: `${(data.items ?? []).length} cached headlines available; ${failures} feed${failures === 1 ? "" : "s"} reported a problem.` });
    } catch (error) { notify({ tone: "error", title: "News pull failed", message: error instanceof Error ? error.message : "Feeds could not be refreshed." }); }
    finally { setLoading(false); }
  }
  function toggle(id: string) { setEnabled((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]); }
  return <section className="phase-panel news-panel">
    <div className="phase-heading"><div><p className="kicker">RSS INTELLIGENCE {"//"} EXPLICIT PULL ONLY</p><h2>NEWS WATCH</h2></div><div className="news-heading-actions"><label>FILTER<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Headline or source" /></label><button className="primary-action" onClick={() => void refresh(true)} disabled={loading || !enabled.length}>{loading ? "PULLING..." : "PULL SELECTED FEEDS"}</button></div></div>
    <div className="news-layout">
      <section className="news-source-band"><header><span>RSS SOURCES</span><b>{enabled.length} / {sources.length} ARMED</b></header><div>{sources.map((source) => { const health = status.find(({ id }) => id === source.id); return <label key={source.id} className={enabled.includes(source.id) ? "enabled" : ""}><input type="checkbox" checked={enabled.includes(source.id)} onChange={() => toggle(source.id)} /><span><strong>{source.name}</strong><small>{source.description}</small><em>{health?.error ? health.error : health?.lastSuccessfulFetchAt ? `LAST ${new Date(health.lastSuccessfulFetchAt).toLocaleTimeString()} // ${health.cachedItems} ITEMS` : `MINIMUM ${Math.round(source.minimumCadenceMs / 60_000)} MIN`}</em></span></label>;})}</div><p>No feed is contacted until you press Pull. Responses are capped at 1 MB, requests run two at a time, conditional caching is used, and repeated manual pulls are held for 30 seconds.</p></section>
      <section className="news-awareness"><header><span>OSINT4ALL LIVE SOURCES</span><a href={OSINT4ALL_SOURCE_URL} target="_blank" rel="noopener noreferrer">SOURCE BOARD ↗</a></header><p>These current-event and live-awareness tools were identified in the captured OSINT4ALL directory. They open directly and are not scraped in the background.</p><div>{awarenessLinks.map((entry) => <a key={entry.id} href={entry.url} target="_blank" rel="noopener noreferrer"><strong>{entry.name}</strong><small>{describeOsintDirectoryEntry(entry)}</small></a>)}</div></section>
      <main className="news-feed-grid">{visible.length ? visible.map((item) => <article key={item.id}><header><span>{item.sourceName}</span><time>{new Date(item.publishedAt ?? item.retrievedAt).toLocaleString()}</time></header><a href={item.url} target="_blank" rel="noopener noreferrer">{item.title}</a>{item.summary && <p>{item.summary}</p>}</article>) : <div className="panel-empty"><span>NO CACHED HEADLINES</span><strong>EXTERNAL TRAFFIC IS IDLE</strong><p>Select sources and pull them when you want news data to leave and return to this computer.</p></div>}</main>
    </div>
  </section>;
}
