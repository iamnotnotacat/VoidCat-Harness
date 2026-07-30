/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import { createHash } from "node:crypto";

export type NewsSource = { id: string; name: string; url: string; homepage: string; description: string; minimumCadenceMs: number };
export type NewsItem = { id: string; sourceId: string; sourceName: string; title: string; url: string; summary: string; publishedAt: string | null; retrievedAt: string };
export const VOIDCAT_NEWS_SOURCES: NewsSource[] = [
  { id: "bbc-world", name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml", homepage: "https://www.bbc.com/news/world", description: "International headlines from the BBC World feed.", minimumCadenceMs: 5 * 60_000 },
  { id: "al-jazeera", name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml", homepage: "https://www.aljazeera.com/", description: "Global reporting from Al Jazeera's published RSS feed.", minimumCadenceMs: 5 * 60_000 },
  { id: "google-news", name: "Google News", url: "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en", homepage: "https://news.google.com/", description: "Aggregated US and world headlines; outbound clicks retain publisher attribution.", minimumCadenceMs: 5 * 60_000 },
  { id: "cisa-advisories", name: "CISA Advisories", url: "https://www.cisa.gov/cybersecurity-advisories/all.xml", homepage: "https://www.cisa.gov/news-events/cybersecurity-advisories", description: "Official United States cybersecurity advisories.", minimumCadenceMs: 10 * 60_000 },
  { id: "nasa-news", name: "NASA News", url: "https://www.nasa.gov/news-release/feed/", homepage: "https://www.nasa.gov/news/", description: "Official NASA news releases.", minimumCadenceMs: 10 * 60_000 },
  { id: "osint4all-inciweb", name: "InciWeb Incidents", url: "https://inciweb.wildfire.gov/incidents/rss.xml", homepage: "https://inciweb.wildfire.gov/", description: "Wildfire and all-hazard incident updates from InciWeb, added from the OSINT4ALL map-source directory.", minimumCadenceMs: 10 * 60_000 },
];

type CacheEntry = { fetchedAt: number; etag?: string; lastModified?: string; items: NewsItem[]; error?: string };
const cache = new Map<string, CacheEntry>();
const active = new Map<string, Promise<CacheEntry>>();
function decodeEntities(value: string) {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, token: string) => {
    if (!token.startsWith("#")) return named[token.toLowerCase()] ?? entity;
    const hexadecimal = token[1]?.toLowerCase() === "x"; const codePoint = Number.parseInt(token.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    return Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : " ";
  });
}
const decode = (value: string) => {
  let clean = value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1");
  for (let pass = 0; pass < 3; pass += 1) clean = decodeEntities(clean);
  return clean.replace(/<\/?(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, " ").replace(/<br\s*\/?\s*>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
};
function tag(block: string, names: string[]) { for (const name of names) { const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i")); if (match) return decode(match[1]); } return ""; }
function link(block: string) { const atom = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i)?.[1]; return atom || tag(block, ["link", "guid"]); }
function safeHttpUrl(value: string) { try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : ""; } catch { return ""; } }

export function parseNewsFeed(source: NewsSource, xml: string, retrievedAt = new Date().toISOString()) {
  const blocks = [...xml.matchAll(/<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi)].slice(0, 80);
  const items: NewsItem[] = [];
  for (const match of blocks) {
    const title = tag(match[1], ["title"]).slice(0, 400); const url = safeHttpUrl(link(match[1]));
    if (!title || !url) continue;
    const published = tag(match[1], ["pubDate", "published", "updated"]); const timestamp = Date.parse(published);
    items.push({ id: createHash("sha256").update(`${source.id}\0${url}`).digest("hex").slice(0, 24), sourceId: source.id, sourceName: source.name, title, url, summary: tag(match[1], ["description", "summary", "content"]).slice(0, 1_200), publishedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null, retrievedAt });
  }
  return items;
}

async function boundedText(response: Response, maximumBytes = 1_000_000) {
  if (!response.body) return ""; const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > maximumBytes) throw new Error("Feed exceeded the 1 MB response limit."); chunks.push(value); } }
  finally { reader.releaseLock(); }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

async function fetchSource(source: NewsSource, force: boolean, fetcher: typeof fetch): Promise<{ entry: CacheEntry; requested: boolean }> {
  const previous = cache.get(source.id); const now = Date.now();
  if (!force && previous && now - previous.fetchedAt < source.minimumCadenceMs) return { entry: previous, requested: false };
  if (force && previous && now - previous.fetchedAt < 30_000) return { entry: previous, requested: false };
  const existing = active.get(source.id); if (existing) return { entry: await existing, requested: false };
  const request = (async () => {
    try {
      const headers: Record<string, string> = { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml", "User-Agent": "VoidCat-Harness/0.1 local-news-reader" };
      if (previous?.etag) headers["If-None-Match"] = previous.etag; if (previous?.lastModified) headers["If-Modified-Since"] = previous.lastModified;
      const response = await fetcher(source.url, { headers, redirect: "follow", signal: AbortSignal.timeout(12_000) });
      if (response.status === 304 && previous) { const entry = { ...previous, fetchedAt: now, error: undefined }; cache.set(source.id, entry); return entry; }
      if (!response.ok) throw new Error(`Feed returned HTTP ${response.status}.`);
      const type = response.headers.get("content-type")?.toLowerCase() ?? ""; if (!/xml|rss|atom|text/.test(type)) throw new Error("Feed returned a non-text response.");
      const xml = await boundedText(response); const retrievedAt = new Date().toISOString(); const items = parseNewsFeed(source, xml, retrievedAt);
      if (!items.length) throw new Error("Feed contained no readable headline records.");
      const entry = { fetchedAt: now, etag: response.headers.get("etag") ?? undefined, lastModified: response.headers.get("last-modified") ?? undefined, items }; cache.set(source.id, entry); return entry;
    } catch (error) {
      const entry = { fetchedAt: previous?.fetchedAt ?? 0, etag: previous?.etag, lastModified: previous?.lastModified, items: previous?.items ?? [], error: error instanceof Error ? error.message.slice(0, 300) : "Feed request failed." }; cache.set(source.id, entry); return entry;
    } finally { active.delete(source.id); }
  })(); active.set(source.id, request); return { entry: await request, requested: true };
}

export async function refreshNews(sourceIds: string[], options: { force?: boolean; fetcher?: typeof fetch } = {}) {
  const selected = VOIDCAT_NEWS_SOURCES.filter((source) => sourceIds.includes(source.id)).slice(0, 8); const fetched: Array<{ entry: CacheEntry; requested: boolean }> = [];
  for (let offset = 0; offset < selected.length; offset += 2) fetched.push(...await Promise.all(selected.slice(offset, offset + 2).map((source) => fetchSource(source, options.force === true, options.fetcher ?? fetch))));
  const results = fetched.map(({ entry }) => entry);
  const status = selected.map((source, index) => ({ id: source.id, name: source.name, lastSuccessfulFetchAt: results[index]?.fetchedAt ? new Date(results[index].fetchedAt).toISOString() : null, nextAllowedAt: results[index]?.fetchedAt ? new Date(results[index].fetchedAt + source.minimumCadenceMs).toISOString() : null, cachedItems: results[index]?.items.length ?? 0, error: results[index]?.error ?? null }));
  const items = results.flatMap((entry) => entry.items).sort((a, b) => Date.parse(b.publishedAt ?? b.retrievedAt) - Date.parse(a.publishedAt ?? a.retrievedAt));
  return { generatedAt: new Date().toISOString(), externalRequestCount: fetched.filter(({ requested }) => requested).length, items: [...new Map(items.map((item) => [item.url, item])).values()].slice(0, 250), status };
}

export function newsCatalog() { return VOIDCAT_NEWS_SOURCES.map((source) => ({ id: source.id, name: source.name, homepage: source.homepage, description: source.description, minimumCadenceMs: source.minimumCadenceMs })); }
