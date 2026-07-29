/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent } from "undici";

export type WebProviderId = "duckduckgo" | "brave" | "tavily";

export type WebProviderDefinition = {
  id: WebProviderId;
  label: string;
  requiresApiKey: boolean;
  privacyNote: string;
};

export type WebSearchHit = {
  id: string;
  provider: WebProviderId;
  title: string;
  url: string;
  snippet: string;
};

export type WebDomainRules = {
  allowedDomains?: string | string[];
  blockedDomains?: string | string[];
};

export type WebSafetyLimits = WebDomainRules & {
  maxPages?: number;
  maxBytesPerPage?: number;
  maxTotalBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
  maxCleanCharacters?: number;
  maxEvidenceCharacters?: number;
};

export type WebSearchOptions = {
  provider: WebProviderId;
  apiKey?: string;
  maxResults?: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImplementation?: typeof fetch;
};

export type WebPageSource = {
  id: string;
  type: "web";
  searchHitId: string;
  title: string;
  url: string;
  snippet: string;
  evidence: string;
  content: string;
  injectionRisk: boolean;
  injectionSignals: string[];
  bytesRead: number;
};

export type RejectedWebPage = {
  searchHitId: string;
  title: string;
  url: string;
  reason: string;
};

export type SelectedWebpageResult = {
  sources: WebPageSource[];
  rejected: RejectedWebPage[];
  bytesRead: number;
};

export type CleanWebContent = {
  title: string;
  text: string;
  injectionRisk: boolean;
  injectionSignals: string[];
};

type AddressResolver = typeof lookup;
type ResolvedAddress = { address: string; family: number };
type ResolvedWebTarget = { url: URL; hostname: string; addresses: ResolvedAddress[] };

type GuardedFetchOptions = {
  fetchImplementation: typeof fetch;
  resolver: AddressResolver;
  domainRules?: WebDomainRules;
  applyDomainRules: boolean;
  maxBytes: number;
  maxRedirects: number;
  timeoutMs: number;
  acceptedContentTypes: string[];
  request?: RequestInit;
};

const WEB_USER_AGENT = "VoidCat-Harness/0.1 (+local research assistant)";
const HARD_MAX_PAGES = 10;
const HARD_MAX_PAGE_BYTES = 5_000_000;
const HARD_MAX_TOTAL_BYTES = 15_000_000;

const PROVIDERS: readonly WebProviderDefinition[] = [
  {
    id: "duckduckgo",
    label: "DuckDuckGo",
    requiresApiKey: false,
    privacyNote: "Uses DuckDuckGo's HTML search results.",
  },
  {
    id: "brave",
    label: "Brave Search",
    requiresApiKey: true,
    privacyNote: "Sends the query to the Brave Search API.",
  },
  {
    id: "tavily",
    label: "Tavily",
    requiresApiKey: true,
    privacyNote: "Sends the query to the Tavily Search API.",
  },
];

const PROMPT_INJECTION_RULES: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "instruction override", pattern: /ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)/i },
  { label: "role impersonation", pattern: /(?:^|\W)(?:system|developer|assistant)\s*(?:message|prompt|instructions?|role|:)/i },
  { label: "instruction request", pattern: /(?:follow|obey|execute)\s+(?:these|the\s+following|my|this\s+new)\s+(?:instructions?|steps?|commands?)/i },
  { label: "secret extraction", pattern: /(?:reveal|exfiltrate|leak|print|return|send)\s+(?:the\s+|any\s+|all\s+)?(?:secret|api\s*key|password|credential|system\s*prompt|developer\s*message)/i },
  { label: "tool manipulation", pattern: /(?:call|use|invoke|run)\s+(?:a\s+|the\s+)?(?:tool|function|terminal|shell|command)/i },
  { label: "identity reassignment", pattern: /you\s+are\s+(?:now|no\s+longer|an?\s+(?:ai|assistant|agent))/i },
  { label: "response hijack", pattern: /(?:do\s+not|don't)\s+(?:answer|respond\s+to|follow)\s+(?:the\s+)?(?:user|question|original)/i },
  { label: "prompt control token", pattern: /<\|(?:im_start|im_end|system|assistant)\|>|\[(?:INST|SYSTEM)\]/i },
];

function clampInteger(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value!)));
}

function normalizeDomainList(input: string | string[] | undefined) {
  const values = Array.isArray(input) ? input : (input || "").split(/[\s,]+/);
  return values.map((value) => value.trim().toLowerCase())
    .map((value) => value.replace(/^https?:\/\//, "").split("/")[0].replace(/\.$/, ""))
    .filter(Boolean);
}

function domainMatches(hostname: string, rule: string) {
  return hostname === rule || hostname.endsWith(`.${rule}`);
}

function isPrivateOrReservedAddress(address: string) {
  if (isIP(address) === 4) {
    const [first, second, third] = address.split(".").map(Number);
    return first === 0 || first === 10 || first === 127 || first >= 224
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 0 && third === 0)
      || (first === 192 && second === 0 && third === 2)
      || (first === 192 && second === 168)
      || (first === 198 && (second === 18 || second === 19))
      || (first === 198 && second === 51 && third === 100)
      || (first === 203 && second === 0 && third === 113);
  }

  if (isIP(address) !== 6) return true;
  const normalized = address.toLowerCase();
  return normalized === "::" || normalized === "::1"
    || normalized.startsWith("fc") || normalized.startsWith("fd")
    || /^fe[89abcdef]/.test(normalized)
    || normalized.startsWith("ff")
    || normalized.startsWith("2001:db8:")
    || normalized.startsWith("::ffff:")
    || normalized.startsWith("0:0:0:0:0:ffff:");
}

function safeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The webpage could not be fetched safely.";
}

function normalizeVisibleText(input: string) {
  return input.normalize("NFKC").replace(/[\u200B-\u200D\u2060\uFEFF]/g, "");
}

function decodeHtml(input: string) {
  const named: Record<string, string> = {
    amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"',
    copy: "©", hellip: "…", laquo: "«", mdash: "—", ndash: "–", raquo: "»",
  };
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const numeric = entity[1]?.toLowerCase() === "x"
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(numeric) && numeric <= 0x10ffff ? String.fromCodePoint(numeric) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function stripMarkup(input: string) {
  const withoutUnsafeRegions = input
    .replace(/<(script|style|noscript|svg|canvas|iframe|form|nav|footer|aside|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6]|section|article|blockquote|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return normalizeVisibleText(decodeHtml(withoutUnsafeRegions))
    .replace(/[^\S\r\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractLargestRegion(html: string, tagName: "article" | "main" | "body") {
  const matches = [...html.matchAll(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi"))];
  return matches.map((match) => match[1]).sort((left, right) => right.length - left.length)[0] || "";
}

function extractTitle(html: string, fallbackTitle: string) {
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    || html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
    || fallbackTitle;
  return stripMarkup(title).slice(0, 180) || fallbackTitle.slice(0, 180) || "Untitled webpage";
}

function filterPromptInjection(text: string) {
  const signals = new Set<string>();
  const safeBlocks = text.split(/\n+/).filter((block) => {
    const normalized = normalizeVisibleText(block).replace(/\s+/g, " ").trim();
    const matches = PROMPT_INJECTION_RULES.filter((rule) => rule.pattern.test(normalized));
    matches.forEach((rule) => signals.add(rule.label));
    return matches.length === 0;
  });
  return { text: safeBlocks.join("\n").trim(), signals: [...signals] };
}

function unwrapDuckDuckGoUrl(href: string) {
  try {
    const url = new URL(decodeHtml(href), "https://html.duckduckgo.com");
    return url.searchParams.get("uddg") || url.toString();
  } catch {
    return "";
  }
}

async function readResponseBody(response: Response, maxBytes: number) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("Page exceeds the configured download limit.");
  }
  if (!response.body) return { text: "", bytesRead: 0 };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > maxBytes) {
      await reader.cancel();
      throw new Error("Page exceeded the configured download limit.");
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"), bytesRead };
}

function createPinnedWebAgent(targets: Map<string, ResolvedAddress[]>) {
  const pinnedLookup: LookupFunction = (hostname, options, callback) => {
    const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    const records = targets.get(normalized) || [];
    const requestedFamily = typeof options.family === "number" ? options.family : 0;
    const selected = records.find((record) => !requestedFamily || record.family === requestedFamily) || records[0];
    if (!selected) {
      const error = Object.assign(new Error("The validated webpage address is no longer available."), { code: "ENOTFOUND" });
      callback(error, "", 0);
      return;
    }
    if (options.all) callback(null, records);
    else callback(null, selected.address, selected.family);
  };
  return new Agent({ connect: { lookup: pinnedLookup } });
}

async function guardedFetchText(value: string, options: GuardedFetchOptions) {
  let current = await resolvePublicWebTarget(value, options.domainRules, options.applyDomainRules, options.resolver);
  const pinnedTargets = new Map<string, ResolvedAddress[]>([[current.hostname, current.addresses]]);
  const dispatcher = options.fetchImplementation === fetch ? createPinnedWebAgent(pinnedTargets) : null;
  try {
    for (let redirectCount = 0; redirectCount <= options.maxRedirects; redirectCount += 1) {
      pinnedTargets.set(current.hostname, current.addresses);
      const requestOptions: RequestInit & { dispatcher?: Agent } = {
        ...options.request,
        redirect: "manual",
        headers: {
          "Accept": options.acceptedContentTypes.join(","),
          "User-Agent": WEB_USER_AGENT,
          ...(options.request?.headers || {}),
        },
        signal: AbortSignal.timeout(options.timeoutMs),
        ...(dispatcher ? { dispatcher } : {}),
      };
      const response = await options.fetchImplementation(current.url, requestOptions);

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirectCount === options.maxRedirects) throw new Error("Too many webpage redirects.");
        current = await resolvePublicWebTarget(new URL(location, current.url).toString(), options.domainRules, options.applyDomainRules, options.resolver);
        continue;
      }
      if (!response.ok) throw new Error(`Page returned HTTP ${response.status}.`);

      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      if (!options.acceptedContentTypes.some((accepted) => contentType.includes(accepted))) {
        await response.body?.cancel();
        throw new Error("Downloads, binary responses, and unsupported page types are blocked.");
      }
      const body = await readResponseBody(response, options.maxBytes);
      return { ...body, url: current.url.toString(), contentType };
    }
    throw new Error("Page redirect validation failed.");
  } finally {
    if (dispatcher) await dispatcher.close();
  }
}

function makeSearchHit(provider: WebProviderId, title: string, url: string, snippet: string): WebSearchHit {
  return {
    id: randomUUID(),
    provider,
    title: stripMarkup(title).slice(0, 240) || url,
    url,
    snippet: stripMarkup(snippet).slice(0, 1_000),
  };
}

async function searchDuckDuckGo(query: string, options: Required<Pick<WebSearchOptions, "maxResults" | "timeoutMs" | "maxResponseBytes" | "fetchImplementation">>) {
  const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const { text } = await guardedFetchText(endpoint, {
    fetchImplementation: options.fetchImplementation,
    resolver: lookup,
    applyDomainRules: false,
    maxBytes: options.maxResponseBytes,
    maxRedirects: 2,
    timeoutMs: options.timeoutMs,
    acceptedContentTypes: ["text/html", "application/xhtml+xml"],
  });
  const hits: WebSearchHit[] = [];
  const resultPattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>)?/gi;
  for (const match of text.matchAll(resultPattern)) {
    const url = unwrapDuckDuckGoUrl(match[1]);
    if (url) hits.push(makeSearchHit("duckduckgo", match[2], url, match[3] || ""));
    if (hits.length >= options.maxResults) break;
  }
  return hits;
}

async function searchBrave(query: string, apiKey: string, options: Required<Pick<WebSearchOptions, "maxResults" | "timeoutMs" | "maxResponseBytes" | "fetchImplementation">>) {
  if (!apiKey.trim()) throw new Error("A Brave Search API key is required for this provider.");
  const endpoint = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${options.maxResults}`;
  const { text } = await guardedFetchText(endpoint, {
    fetchImplementation: options.fetchImplementation,
    resolver: lookup,
    applyDomainRules: false,
    maxBytes: options.maxResponseBytes,
    // Never forward a provider credential through an HTTP redirect.
    maxRedirects: 0,
    timeoutMs: options.timeoutMs,
    acceptedContentTypes: ["application/json"],
    request: { headers: { "Accept": "application/json", "X-Subscription-Token": apiKey } },
  });
  const data = JSON.parse(text) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
  return (data.web?.results || []).filter((item) => item.url)
    .slice(0, options.maxResults)
    .map((item) => makeSearchHit("brave", item.title || item.url!, item.url!, item.description || ""));
}

async function searchTavily(query: string, apiKey: string, options: Required<Pick<WebSearchOptions, "maxResults" | "timeoutMs" | "maxResponseBytes" | "fetchImplementation">>) {
  if (!apiKey.trim()) throw new Error("A Tavily API key is required for this provider.");
  const { text } = await guardedFetchText("https://api.tavily.com/search", {
    fetchImplementation: options.fetchImplementation,
    resolver: lookup,
    applyDomainRules: false,
    maxBytes: options.maxResponseBytes,
    // Never forward a provider credential through an HTTP redirect.
    maxRedirects: 0,
    timeoutMs: options.timeoutMs,
    acceptedContentTypes: ["application/json"],
    request: {
      method: "POST",
      headers: { "Accept": "application/json", "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, max_results: options.maxResults, search_depth: "basic" }),
    },
  });
  const data = JSON.parse(text) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (data.results || []).filter((item) => item.url)
    .slice(0, options.maxResults)
    .map((item) => makeSearchHit("tavily", item.title || item.url!, item.url!, item.content || ""));
}

export function listWebProviders(): WebProviderDefinition[] {
  return PROVIDERS.map((provider) => ({ ...provider }));
}

export function cleanWebContent(html: string, fallbackTitle = "Untitled webpage", maxCharacters = 24_000): CleanWebContent {
  const maximum = clampInteger(maxCharacters, 24_000, 1_000, 50_000);
  const preferredRegion = extractLargestRegion(html, "article")
    || extractLargestRegion(html, "main")
    || extractLargestRegion(html, "body")
    || html;
  const filtered = filterPromptInjection(stripMarkup(preferredRegion));
  const filteredTitle = filterPromptInjection(extractTitle(html, fallbackTitle));
  const injectionSignals = [...new Set([...filteredTitle.signals, ...filtered.signals])];
  return {
    title: filteredTitle.text.slice(0, 180) || "Filtered webpage title",
    text: filtered.text.slice(0, maximum),
    injectionRisk: injectionSignals.length > 0,
    injectionSignals,
  };
}

export function selectQuotedEvidence(text: string, query: string, maxCharacters = 700) {
  const maximum = clampInteger(maxCharacters, 700, 160, 1_500);
  const terms = [...new Set(normalizeVisibleText(query).toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 3))];
  const candidates = text.split(/\n+/).map((paragraph) => paragraph.trim()).filter((paragraph) => paragraph.length >= 40);
  const scored = candidates.map((paragraph, position) => ({
    paragraph,
    position,
    score: terms.reduce((total, term) => total + (paragraph.toLowerCase().includes(term) ? 1 : 0), 0),
  })).sort((left, right) => right.score - left.score || left.position - right.position);
  const selected = scored[0]?.paragraph || text.trim();
  if (selected.length <= maximum) return selected;
  return `${selected.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
}

async function resolvePublicWebTarget(
  value: string,
  domainRules: WebDomainRules = {},
  applyDomainRules = true,
  resolver: AddressResolver = lookup,
): Promise<ResolvedWebTarget> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The webpage URL is invalid.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP and HTTPS pages are allowed.");
  if (url.username || url.password) throw new Error("Authenticated page URLs are not allowed.");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Local network destinations are blocked.");
  }

  const blockedDomains = normalizeDomainList(domainRules.blockedDomains);
  const allowedDomains = normalizeDomainList(domainRules.allowedDomains);
  if (applyDomainRules && blockedDomains.some((domain) => domainMatches(hostname, domain))) {
    throw new Error(`Blocked domain: ${hostname}`);
  }
  if (applyDomainRules && allowedDomains.length > 0 && !allowedDomains.some((domain) => domainMatches(hostname, domain))) {
    throw new Error(`Domain is not on the allowlist: ${hostname}`);
  }

  const addresses = (isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolver(hostname, { all: true, verbatim: true })) as ResolvedAddress[];
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateOrReservedAddress(address))) {
    throw new Error("Private, local, and reserved network addresses are blocked.");
  }
  return { url, hostname, addresses };
}

export async function validatePublicWebUrl(
  value: string,
  domainRules: WebDomainRules = {},
  applyDomainRules = true,
  resolver: AddressResolver = lookup,
) {
  return (await resolvePublicWebTarget(value, domainRules, applyDomainRules, resolver)).url;
}

export async function discoverWebSearchResults(query: string, input: WebSearchOptions): Promise<WebSearchHit[]> {
  const trimmedQuery = normalizeVisibleText(query).replace(/\s+/g, " ").trim().slice(0, 500);
  if (!trimmedQuery) throw new Error("A web search query is required.");
  if (!PROVIDERS.some((provider) => provider.id === input.provider)) throw new Error("The selected search provider is not supported.");
  const options = {
    maxResults: clampInteger(input.maxResults, 8, 1, 20),
    timeoutMs: clampInteger(input.timeoutMs, 15_000, 1_000, 30_000),
    maxResponseBytes: clampInteger(input.maxResponseBytes, 1_000_000, 50_000, 3_000_000),
    fetchImplementation: input.fetchImplementation || fetch,
  };
  if (input.provider === "brave") return searchBrave(trimmedQuery, input.apiKey || "", options);
  if (input.provider === "tavily") return searchTavily(trimmedQuery, input.apiKey || "", options);
  return searchDuckDuckGo(trimmedQuery, options);
}

export async function fetchSelectedWebpages(
  selectedHits: WebSearchHit[],
  query: string,
  input: WebSafetyLimits & { fetchImplementation?: typeof fetch; resolver?: AddressResolver } = {},
): Promise<SelectedWebpageResult> {
  const maxPages = clampInteger(input.maxPages, 3, 1, HARD_MAX_PAGES);
  if (selectedHits.length > maxPages) throw new Error(`Select no more than ${maxPages} webpages.`);

  const maxBytesPerPage = clampInteger(input.maxBytesPerPage, 1_000_000, 50_000, HARD_MAX_PAGE_BYTES);
  const maxTotalBytes = clampInteger(input.maxTotalBytes, Math.min(maxPages * maxBytesPerPage, HARD_MAX_TOTAL_BYTES), 50_000, HARD_MAX_TOTAL_BYTES);
  const maxRedirects = clampInteger(input.maxRedirects, 3, 0, 5);
  const timeoutMs = clampInteger(input.timeoutMs, 15_000, 1_000, 30_000);
  const maxCleanCharacters = clampInteger(input.maxCleanCharacters, 24_000, 1_000, 50_000);
  const maxEvidenceCharacters = clampInteger(input.maxEvidenceCharacters, 700, 160, 1_500);
  const fetchImplementation = input.fetchImplementation || fetch;
  const resolver = input.resolver || lookup;
  const sources: WebPageSource[] = [];
  const rejected: RejectedWebPage[] = [];
  let bytesRead = 0;
  const seenUrls = new Set<string>();

  for (const hit of selectedHits) {
    if (seenUrls.has(hit.url)) continue;
    seenUrls.add(hit.url);
    const remainingBytes = maxTotalBytes - bytesRead;
    if (remainingBytes <= 0) {
      rejected.push({ searchHitId: hit.id, title: hit.title, url: hit.url, reason: "The total webpage download limit was reached." });
      continue;
    }
    try {
      const page = await guardedFetchText(hit.url, {
        fetchImplementation,
        resolver,
        domainRules: input,
        applyDomainRules: true,
        maxBytes: Math.min(maxBytesPerPage, remainingBytes),
        maxRedirects,
        timeoutMs,
        acceptedContentTypes: ["text/html", "application/xhtml+xml", "text/plain"],
      });
      bytesRead += page.bytesRead;
      const clean = page.contentType.includes("text/html") || page.contentType.includes("application/xhtml+xml")
        ? cleanWebContent(page.text, hit.title, maxCleanCharacters)
        : cleanWebContent(`<article>${page.text}</article>`, hit.title, maxCleanCharacters);
      if (clean.text.length < 80) throw new Error("The selected page did not contain enough readable text.");
      sources.push({
        id: randomUUID(),
        type: "web",
        searchHitId: hit.id,
        title: clean.title,
        url: page.url,
        snippet: hit.snippet,
        evidence: selectQuotedEvidence(clean.text, query, maxEvidenceCharacters),
        content: clean.text,
        injectionRisk: clean.injectionRisk,
        injectionSignals: clean.injectionSignals,
        bytesRead: page.bytesRead,
      });
    } catch (error) {
      rejected.push({ searchHitId: hit.id, title: hit.title, url: hit.url, reason: safeErrorMessage(error) });
    }
  }
  return { sources, rejected, bytesRead };
}
