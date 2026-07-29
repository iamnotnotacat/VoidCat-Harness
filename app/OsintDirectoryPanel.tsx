/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
"use client";

import { useMemo, useState } from "react";
import {
  OSINT4ALL_CAPTURED_AT,
  OSINT4ALL_CATEGORIES,
  OSINT4ALL_LINKS,
  OSINT4ALL_SOURCE_URL,
  describeOsintDirectoryEntry,
  osintDirectoryHost,
  searchOsintDirectory,
} from "./osint4all-links";

const ALL = "ALL SOURCES";

function categoryCode(category: string) {
  return category.split(/\s+/).map((word) => word[0]).join("").slice(0, 3);
}

export function OsintDirectoryPanel() {
  const [category, setCategory] = useState(ALL);
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const categoryCounts = useMemo(() => new Map(OSINT4ALL_CATEGORIES.map((value) => [value, OSINT4ALL_LINKS.filter((entry) => entry.category === value).length])), []);
  const visible = useMemo(() => (normalizedQuery ? searchOsintDirectory(normalizedQuery, 100) : OSINT4ALL_LINKS).filter((entry) => {
    if (category !== ALL && entry.category !== category) return false;
    return true;
  }), [category, normalizedQuery]);

  return <section className="osint-directory phase-panel" aria-labelledby="osint-directory-title">
    <header className="osint-directory-header">
      <div>
        <span>PASSIVE RESEARCH DIRECTORY {"//"} EXTERNAL CATALOG</span>
        <h2 id="osint-directory-title">OSINT4ALL TOOL MATRIX</h2>
        <p>Searchable VoidCat reference to every tool link captured from the OSINT4All Start.me board.</p>
      </div>
      <div className="osint-directory-status" aria-label="Catalog status">
        <strong>{OSINT4ALL_LINKS.length} LINKS</strong>
        <span>{OSINT4ALL_CATEGORIES.length} CATEGORIES</span>
        <a href={OSINT4ALL_SOURCE_URL} target="_blank" rel="noreferrer">OPEN SOURCE BOARD ↗</a>
      </div>
    </header>

    <div className="osint-directory-warning" role="note">
      <strong>EXTERNAL // NOT VETTED BY VOIDCAT</strong>
      <span>Links may change, disappear, collect data, require accounts, or have legal restrictions. Review the destination and use only with authorization. Opening a link never adds it to an investigation or sends it to a UNIT.</span>
    </div>

    <div className="osint-directory-controls">
      <label>
        <span>SEARCH ALL TOOLS</span>
        <input type="search" value={query} onInput={(event) => setQuery(event.currentTarget.value)} placeholder="Name, purpose, category, or domain" />
      </label>
      <div><span>VISIBLE</span><strong>{visible.length.toLocaleString()} / {OSINT4ALL_LINKS.length.toLocaleString()}</strong></div>
      <div><span>SNAPSHOT</span><strong>{OSINT4ALL_CAPTURED_AT}</strong></div>
    </div>

    <div className="osint-directory-layout">
      <aside className="osint-directory-categories" aria-label="OSINT directory categories">
        <button className={category === ALL ? "active" : ""} onClick={() => setCategory(ALL)} type="button"><span>ALL</span><strong>{OSINT4ALL_LINKS.length}</strong><small>COMPLETE MATRIX</small></button>
        {OSINT4ALL_CATEGORIES.map((value) => <button className={category === value ? "active" : ""} key={value} onClick={() => setCategory(value)} type="button"><span>{categoryCode(value)}</span><strong>{categoryCounts.get(value)}</strong><small>{value}</small></button>)}
      </aside>

      <main className="osint-directory-results" aria-live="polite">
        <header><div><span>ACTIVE LAYER</span><strong>{category}</strong></div><p>{normalizedQuery ? `FILTER // ${query.trim()}` : "NO TEXT FILTER"}</p></header>
        {visible.length ? <div className="osint-directory-grid">{visible.map((entry, index) => <article className="osint-directory-card" key={entry.id}>
          <div className="osint-directory-card-index"><span>{String(index + 1).padStart(3, "0")}</span><strong>{categoryCode(entry.category)}</strong></div>
          <div className="osint-directory-card-body">
            <span>{entry.category} {entry.url.startsWith("http:") ? "// INSECURE HTTP" : "// HTTPS"}</span>
            <h3>{entry.name}</h3>
            <p>{describeOsintDirectoryEntry(entry)}</p>
            <small>{osintDirectoryHost(entry)}</small>
          </div>
          <a className="osint-directory-open" href={entry.url} target="_blank" rel="noreferrer" aria-label={`Open ${entry.name} in the system browser`}>OPEN ↗</a>
        </article>)}</div> : <div className="osint-directory-empty"><strong>NO MATCHING TOOLS</strong><span>Clear the search or select another category.</span><button type="button" onClick={() => { setQuery(""); setCategory(ALL); }}>RESET MATRIX</button></div>}
      </main>
    </div>
  </section>;
}
