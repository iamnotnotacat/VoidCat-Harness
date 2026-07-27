import type { IncomingMessage, ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";
import os from "node:os";
import Busboy from "busboy";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import type { Plugin } from "vite";
import {
  addMessage, createConversation, createDocument, deleteConversation, deleteDocument, deleteMemory, deleteProfile,
  getConversation, getMemoryCandidates, getMemoryRecord, getRagChunks, getSettings, getState, saveMemory, saveProfile, saveSettings,
  setMemoryEmbedding, updateConversation, updateDocument,
  type MemoryInput, type ProfileInput, type SettingsInput, type WebMode,
} from "./voidcat-database";

const execFileAsync = promisify(execFile);
const LMS_PATH = path.join(os.homedir(), ".lmstudio", "bin", "lms.exe");
const API_BASE = "http://127.0.0.1:1234";
const EMBEDDING_MODEL = "text-embedding-nomic-embed-text-v1.5";
const WEB_USER_AGENT = "VoidCat-Harness/0.4 (local research assistant)";

type LmsModel = {
  type: "llm" | "embedding";
  modelKey: string;
  displayName: string;
  publisher: string;
  path: string;
  sizeBytes: number;
  paramsString?: string;
  architecture?: string;
  quantization?: { name?: string; bits?: number };
  vision?: boolean;
  trainedForToolUse?: boolean;
  maxContextLength?: number;
};

async function runLms(args: string[], timeout = 120_000) {
  const result = await execFileAsync(LMS_PATH, args, {
    cwd: path.dirname(LMS_PATH), timeout, windowsHide: true, maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function lmsJson<T>(args: string[]): Promise<T> {
  const output = await runLms(args);
  return JSON.parse(output || "[]") as T;
}

function classify(model: LmsModel) {
  const value = `${model.modelKey} ${model.displayName}`.toLowerCase();
  if (model.type === "embedding") return "embedding";
  if (value.includes("coder") || value.includes("coding")) return "code";
  if (value.includes("reason") || value.includes("r1") || value.includes("think")) return "reasoning";
  return "chat";
}

async function scanModels() {
  const entries = await lmsJson<LmsModel[]>(["ls", "--json"]);
  return {
    models: entries.map((model) => ({
      id: model.modelKey,
      modelKey: model.modelKey,
      name: model.displayName,
      publisher: model.publisher,
      path: model.path,
      sizeBytes: model.sizeBytes,
      size: `${(model.sizeBytes / 1024 ** 3).toFixed(model.sizeBytes > 10 * 1024 ** 3 ? 1 : 2)} GB`,
      quantization: model.quantization?.name ?? "GGUF",
      kind: classify(model),
      vision: Boolean(model.vision),
      toolUse: Boolean(model.trainedForToolUse),
      parameters: model.paramsString ?? "—",
      architecture: model.architecture ?? "unknown",
      maxContextLength: model.maxContextLength ?? 8192,
      status: "ready",
    })),
    scannedAt: new Date().toISOString(),
    roots: [path.join(os.homedir(), ".lmstudio", "models")],
  };
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

function sendJson(response: ServerResponse, status: number, data: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(data));
}

async function runtimeStatus() {
  try {
    const loaded = await lmsJson<Array<Record<string, unknown>>>(["ps", "--json"]);
    return { online: loaded.length > 0, loaded };
  } catch {
    return { online: false, loaded: [] };
  }
}

async function ensureApiServer() {
  try {
    await fetch(`${API_BASE}/v1/models`, { signal: AbortSignal.timeout(1_000) });
  } catch {
    try { await runLms(["server", "start", "--port", "1234", "--bind", "127.0.0.1"], 30_000); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes("already")) throw error;
    }
  }
}

async function ensureEmbeddingModel() {
  await ensureApiServer();
  const status = await runtimeStatus();
  if (status.loaded.some((entry) => entry.identifier === "voidcat-embed")) return;
  await runLms(["load", EMBEDDING_MODEL, "--yes", "--identifier", "voidcat-embed", "--context-length", "2048"], 5 * 60_000);
}

async function embedTexts(texts: string[]) {
  await ensureEmbeddingModel();
  const embeddings: number[][] = [];
  for (let index = 0; index < texts.length; index += 16) {
    const batch = texts.slice(index, index + 16);
    const response = await fetch(`${API_BASE}/v1/embeddings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "voidcat-embed", input: batch }), signal: AbortSignal.timeout(5 * 60_000) });
    if (!response.ok) throw new Error(`Embedding failed: ${await response.text()}`);
    const data = await response.json() as { data?: Array<{ index: number; embedding: number[] }> };
    const ordered = (data.data ?? []).sort((a, b) => a.index - b.index).map((item) => item.embedding);
    if (ordered.length !== batch.length) throw new Error("The embedding runtime returned an incomplete batch.");
    embeddings.push(...ordered);
  }
  return embeddings;
}

function chunkText(input: string) {
  const normalized = input.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const paragraphs = normalized.split(/\n\n+/).filter(Boolean);
  const chunks: string[] = []; let current = "";
  for (const paragraph of paragraphs) {
    if (current.length + paragraph.length + 2 <= 1400) { current += `${current ? "\n\n" : ""}${paragraph}`; continue; }
    if (current) chunks.push(current);
    if (paragraph.length <= 1400) current = paragraph;
    else {
      for (let offset = 0; offset < paragraph.length; offset += 1200) chunks.push(paragraph.slice(offset, offset + 1400));
      current = "";
    }
  }
  if (current) chunks.push(current);
  return chunks.filter((chunk) => chunk.trim().length >= 20);
}

async function extractText(filename: string, buffer: Buffer) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".txt" || extension === ".md") return buffer.toString("utf8");
  if (extension === ".docx") return (await mammoth.extractRawText({ buffer })).value;
  if (extension === ".pdf") {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try { return (await parser.getText()).text; } finally { await parser.destroy(); }
  }
  throw new Error("Unsupported document format. Use PDF, DOCX, TXT, or Markdown.");
}

function readUpload(request: IncomingMessage) {
  return new Promise<{ filename: string; mimeType: string; buffer: Buffer }>((resolve, reject) => {
    let settled = false;
    try {
      const parser = Busboy({ headers: request.headers, limits: { files: 1, fields: 2 } });
      parser.on("file", (_field, stream, info) => {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => { if (!settled) { settled = true; resolve({ filename: path.basename(info.filename), mimeType: info.mimeType, buffer: Buffer.concat(chunks) }); } });
      });
      parser.on("error", reject); parser.on("finish", () => { if (!settled) reject(new Error("No document was attached.")); });
      request.pipe(parser);
    } catch (error) { reject(error); }
  });
}

async function ingestDocument(request: IncomingMessage) {
  const upload = await readUpload(request);
  const extension = path.extname(upload.filename).toLowerCase();
  if (![".pdf", ".docx", ".txt", ".md"].includes(extension)) throw new Error("Unsupported document format. Use PDF, DOCX, TXT, or Markdown.");
  const text = await extractText(upload.filename, upload.buffer);
  const chunks = chunkText(text);
  if (!chunks.length) throw new Error("No readable text was found in this document.");
  const embeddings = await embedTexts(chunks);
  const documentId = randomUUID();
  const libraryDirectory = path.resolve(process.cwd(), ".voidcat", "library", "files");
  await fs.mkdir(libraryDirectory, { recursive: true });
  const storedPath = path.join(libraryDirectory, `${documentId}${extension}`);
  await fs.writeFile(storedPath, upload.buffer);
  return createDocument({ id: documentId, name: upload.filename, extension, storedPath, sizeBytes: upload.buffer.length }, chunks.map((content, index) => ({ content, embedding: embeddings[index] })));
}

function cosine(left: number[], right: number[]) {
  let dot = 0; let leftNorm = 0; let rightNorm = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) { dot += left[index] * right[index]; leftNorm += left[index] ** 2; rightNorm += right[index] ** 2; }
  return leftNorm && rightNorm ? dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)) : 0;
}

async function searchDocuments(query: string) {
  const chunks = getRagChunks();
  if (!chunks.length) return [];
  const [queryEmbedding] = await embedTexts([query]);
  return chunks.map((chunk) => ({ id: chunk.id, documentId: chunk.documentId, documentName: chunk.documentName, chunkIndex: chunk.chunkIndex, content: chunk.content, score: cosine(queryEmbedding, JSON.parse(chunk.embedding) as number[]) }))
    .sort((a, b) => b.score - a.score).slice(0, 6).filter((result) => result.score > 0.2);
}

async function saveIndexedMemory(input: MemoryInput) {
  if (!input.content?.trim()) return saveMemory(input);
  const existing = input.id ? getMemoryRecord(input.id) : undefined;
  if (existing?.content === input.content.trim() && existing.embedding) return saveMemory(input);
  const [embedding] = await embedTexts([input.content.trim()]);
  return saveMemory({ ...input, embedding });
}

async function searchMemories(query: string) {
  const candidates = getMemoryCandidates();
  if (!candidates.length) return [];
  const missing = candidates.filter((memory) => !memory.embedding);
  const embeddings = await embedTexts([query, ...missing.map((memory) => memory.content)]);
  missing.forEach((memory, index) => {
    memory.embedding = JSON.stringify(embeddings[index + 1]);
    setMemoryEmbedding(memory.id, embeddings[index + 1]);
  });
  const queryEmbedding = embeddings[0];
  return candidates.map((memory) => {
    const relevance = cosine(queryEmbedding, JSON.parse(memory.embedding || "[]") as number[]);
    const score = relevance * 0.78 + (memory.importance / 5) * 0.22;
    return { id: memory.id, content: memory.content, category: memory.category, importance: memory.importance, relevance, score };
  }).filter((memory) => memory.relevance >= 0.18).sort((left, right) => right.score - left.score).slice(0, 6);
}

function splitDomains(input: string) {
  return input.split(/[\s,]+/).map((domain) => domain.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0]).filter(Boolean);
}

function domainMatches(hostname: string, domain: string) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function isPrivateAddress(address: string) {
  if (isIP(address) === 4) {
    const parts = address.split(".").map(Number);
    return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] >= 224
      || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19));
  }
  const normalized = address.toLowerCase();
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd")
    || /^fe[89ab]/.test(normalized) || normalized.startsWith("::ffff:127.") || normalized.startsWith("::ffff:10.")
    || normalized.startsWith("::ffff:192.168.");
}

async function validatePublicUrl(value: string, applyDomainRules = true) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Only HTTP and HTTPS pages are allowed.");
  if (url.username || url.password) throw new Error("Authenticated page URLs are not allowed.");
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const settings = getSettings();
  const blocked = splitDomains(settings.blockedDomains);
  const allowed = splitDomains(settings.allowedDomains);
  if (applyDomainRules && blocked.some((domain) => domainMatches(hostname, domain))) throw new Error(`Blocked domain: ${hostname}`);
  if (applyDomainRules && allowed.length && !allowed.some((domain) => domainMatches(hostname, domain))) throw new Error(`Domain is not on the allowlist: ${hostname}`);
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error("Private, local, and reserved network addresses are blocked.");
  return url;
}

async function guardedFetchText(value: string, options: RequestInit = {}, applyDomainRules = true) {
  const settings = getSettings();
  let current = await validatePublicUrl(value, applyDomainRules);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetch(current, {
      ...options,
      redirect: "manual",
      headers: { "User-Agent": WEB_USER_AGENT, "Accept": "text/html,application/xhtml+xml,text/plain,application/json;q=0.8", ...(options.headers || {}) },
      signal: AbortSignal.timeout(15_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirects === 3) throw new Error("Too many webpage redirects.");
      current = await validatePublicUrl(new URL(location, current).toString(), applyDomainRules);
      continue;
    }
    if (!response.ok) throw new Error(`Page returned HTTP ${response.status}.`);
    const contentType = (response.headers.get("content-type") || "text/plain").toLowerCase();
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml") && !contentType.includes("text/plain") && !contentType.includes("application/json")) throw new Error("Downloads and binary page types are blocked.");
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > settings.maxWebBytes) throw new Error("Page exceeds the configured download limit.");
    if (!response.body) return { text: "", url: current.toString(), contentType };
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      size += chunk.byteLength;
      if (size > settings.maxWebBytes) { await reader.cancel(); throw new Error("Page exceeded the configured download limit."); }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    return { text: buffer.toString("utf8"), url: current.toString(), contentType };
  }
  throw new Error("Page redirect validation failed.");
}

function decodeHtml(input: string) {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const value = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function stripMarkup(input: string) {
  return decodeHtml(input.replace(/<(script|style|noscript|svg|canvas|iframe|form|nav|footer|header)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ").replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/h\d>/gi, "\n")
    .replace(/<[^>]+>/g, " ")).replace(/[^\S\r\n]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

const injectionPatterns = [
  /ignore (all |any )?(previous|prior|above) (instructions?|prompts?)/i,
  /(?:system|developer) (?:message|prompt|instructions?)/i,
  /follow (?:these|the following|my) instructions?/i,
  /reveal|exfiltrate|send (?:the )?(?:secret|api key|system prompt)/i,
  /(?:call|use|invoke) (?:a |the )?(?:tool|function)/i,
  /you are (?:now|an ai|chatgpt)/i,
];

function cleanWebPage(html: string, fallbackTitle: string) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = stripMarkup(titleMatch?.[1] || fallbackTitle).slice(0, 180) || fallbackTitle;
  const rawText = stripMarkup(html);
  let injectionRisk = false;
  const text = rawText.split(/\n+/).filter((line) => {
    const suspicious = injectionPatterns.some((pattern) => pattern.test(line));
    if (suspicious) injectionRisk = true;
    return !suspicious;
  }).join("\n").slice(0, 18_000);
  return { title, text, injectionRisk };
}

function unwrapDuckDuckGoUrl(href: string) {
  try {
    const url = new URL(decodeHtml(href), "https://html.duckduckgo.com");
    return url.searchParams.get("uddg") || url.toString();
  } catch { return ""; }
}

type SearchHit = { title: string; url: string; snippet: string };

async function searchDuckDuckGo(query: string): Promise<SearchHit[]> {
  const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const { text } = await guardedFetchText(endpoint, {}, false);
  const hits: SearchHit[] = [];
  const resultPattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>)?/gi;
  for (const match of text.matchAll(resultPattern)) {
    const url = unwrapDuckDuckGoUrl(match[1]);
    if (url) hits.push({ url, title: stripMarkup(match[2]), snippet: stripMarkup(match[3] || "") });
    if (hits.length >= 8) break;
  }
  return hits;
}

async function searchBrave(query: string, apiKey: string): Promise<SearchHit[]> {
  if (!apiKey) throw new Error("A Brave Search API key is required for this provider.");
  const { text } = await guardedFetchText(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`, { headers: { "X-Subscription-Token": apiKey, "Accept": "application/json" } }, false);
  const data = JSON.parse(text) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
  return (data.web?.results || []).filter((item) => item.url).map((item) => ({ title: item.title || item.url!, url: item.url!, snippet: stripMarkup(item.description || "") }));
}

async function searchTavily(query: string, apiKey: string): Promise<SearchHit[]> {
  if (!apiKey) throw new Error("A Tavily API key is required for this provider.");
  const { text } = await guardedFetchText("https://api.tavily.com/search", { method: "POST", headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json", "Accept": "application/json" }, body: JSON.stringify({ query, max_results: 8, search_depth: "basic" }) }, false);
  const data = JSON.parse(text) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (data.results || []).filter((item) => item.url).map((item) => ({ title: item.title || item.url!, url: item.url!, snippet: stripMarkup(item.content || "") }));
}

function evidenceExcerpt(text: string, query: string) {
  const terms = query.toLowerCase().split(/\W+/).filter((term) => term.length > 3);
  const paragraphs = text.split(/\n+/).map((line) => line.trim()).filter((line) => line.length > 40);
  const best = paragraphs.sort((left, right) => terms.filter((term) => right.toLowerCase().includes(term)).length - terms.filter((term) => left.toLowerCase().includes(term)).length)[0] || text;
  return best.slice(0, 700).trim();
}

async function searchWeb(query: string) {
  const settings = getSettings();
  const hits = settings.webProvider === "brave" ? await searchBrave(query, settings.webApiKey)
    : settings.webProvider === "tavily" ? await searchTavily(query, settings.webApiKey) : await searchDuckDuckGo(query);
  const sources = [];
  for (const hit of hits) {
    if (sources.length >= settings.maxWebPages) break;
    try {
      const { text, url } = await guardedFetchText(hit.url);
      const clean = cleanWebPage(text, hit.title);
      if (clean.text.length < 80) continue;
      sources.push({ id: randomUUID(), type: "web", title: clean.title, url, snippet: hit.snippet, evidence: evidenceExcerpt(clean.text, query), content: clean.text, injectionRisk: clean.injectionRisk });
    } catch { /* rejected or unavailable results are skipped */ }
  }
  return { provider: settings.webProvider, results: sources };
}

async function loadModel(modelKey: string, contextLength: number) {
  await ensureApiServer();
  const status = await runtimeStatus();
  const owned = status.loaded.find((entry) => entry.identifier === "voidcat-core");
  if (owned) await runLms(["unload", "voidcat-core"], 120_000);
  await runLms([
    "load", modelKey, "--yes", "--identifier", "voidcat-core",
    "--context-length", String(Math.max(2048, Math.min(contextLength, 32768))),
  ], 10 * 60_000);
  return runtimeStatus();
}

async function proxyChat(request: IncomingMessage, response: ServerResponse) {
  const body = await readBody(request);
  await ensureApiServer();
  const upstream = await fetch(`${API_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, model: "voidcat-core", stream: true }),
    signal: AbortSignal.timeout(30 * 60_000),
  });
  response.statusCode = upstream.status;
  response.setHeader("Content-Type", upstream.headers.get("content-type") ?? "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  if (!upstream.body) { response.end(); return; }
  const reader = upstream.body.getReader();
  request.on("close", () => void reader.cancel());
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    response.write(Buffer.from(value));
  }
  response.end();
}

export function voidcatLocal(): Plugin {
  return {
    name: "voidcat-local-core",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url?.split("?")[0];
        if (!url?.startsWith("/api/")) { next(); return; }
        void (async () => {
          try {
            if (url === "/api/models" && request.method === "GET") sendJson(response, 200, await scanModels());
            else if (url === "/api/runtime/status" && request.method === "GET") sendJson(response, 200, await runtimeStatus());
            else if (url === "/api/state" && request.method === "GET") sendJson(response, 200, getState());
            else if (url === "/api/conversations" && request.method === "POST") sendJson(response, 201, createConversation(await readBody(request) as { title?: string; profileId?: string; modelKey?: string; webMode?: WebMode }));
            else if (url?.startsWith("/api/conversations/")) {
              const parts = url.split("/").filter(Boolean);
              const conversationId = parts[2];
              if (!conversationId) throw new Error("Conversation id is required.");
              if (parts[3] === "messages" && request.method === "POST") {
                const body = await readBody(request);
                if (typeof body.role !== "string" || typeof body.content !== "string") throw new Error("Message role and content are required.");
                sendJson(response, 201, addMessage(conversationId, body.role, body.content, Array.isArray(body.sources) ? body.sources : []));
              } else if (request.method === "GET") sendJson(response, 200, getConversation(conversationId));
              else if (request.method === "PATCH") sendJson(response, 200, updateConversation(conversationId, await readBody(request) as { title?: string; profileId?: string; modelKey?: string; webMode?: WebMode }));
              else if (request.method === "DELETE") sendJson(response, 200, deleteConversation(conversationId));
              else sendJson(response, 405, { error: "Unsupported conversation operation." });
            }
            else if (url === "/api/profiles" && request.method === "POST") sendJson(response, 201, saveProfile(await readBody(request) as ProfileInput));
            else if (url?.startsWith("/api/profiles/") && request.method === "PATCH") sendJson(response, 200, saveProfile({ ...(await readBody(request) as ProfileInput), id: url.split("/")[3] }));
            else if (url?.startsWith("/api/profiles/") && request.method === "DELETE") sendJson(response, 200, deleteProfile(url.split("/")[3]));
            else if (url === "/api/memories" && request.method === "POST") sendJson(response, 201, await saveIndexedMemory(await readBody(request) as MemoryInput));
            else if (url === "/api/memories/search" && request.method === "POST") {
              const body = await readBody(request);
              if (typeof body.query !== "string" || !body.query.trim()) throw new Error("A memory query is required.");
              sendJson(response, 200, { results: await searchMemories(body.query) });
            }
            else if (url === "/api/memories/forget" && request.method === "POST") {
              const body = await readBody(request);
              if (typeof body.query !== "string" || !body.query.trim()) throw new Error("A memory description is required.");
              const normalized = body.query.trim().toLowerCase();
              const exact = getMemoryCandidates().find((memory) => memory.content.toLowerCase() === normalized || memory.content.toLowerCase().includes(normalized));
              if (exact) { deleteMemory(exact.id); sendJson(response, 200, { deleted: exact.id, content: exact.content }); }
              else {
                const match = (await searchMemories(body.query))[0];
                if (!match || match.relevance < 0.42) sendJson(response, 404, { error: "No close approved memory was found." });
                else { deleteMemory(match.id); sendJson(response, 200, { deleted: match.id, content: match.content }); }
              }
            }
            else if (url?.startsWith("/api/memories/") && request.method === "PATCH") sendJson(response, 200, await saveIndexedMemory({ ...(await readBody(request) as MemoryInput), id: url.split("/")[3] }));
            else if (url?.startsWith("/api/memories/") && request.method === "DELETE") sendJson(response, 200, deleteMemory(url.split("/")[3]));
            else if (url === "/api/settings" && request.method === "PATCH") sendJson(response, 200, saveSettings(await readBody(request) as SettingsInput));
            else if (url === "/api/web/search" && request.method === "POST") {
              const body = await readBody(request);
              if (typeof body.query !== "string" || !body.query.trim()) throw new Error("A web search query is required.");
              sendJson(response, 200, await searchWeb(body.query.slice(0, 500)));
            }
            else if (url === "/api/documents" && request.method === "POST") sendJson(response, 201, await ingestDocument(request));
            else if (url?.startsWith("/api/documents/") && request.method === "PATCH") {
              const body = await readBody(request); sendJson(response, 200, updateDocument(url.split("/")[3], body.enabled !== false));
            }
            else if (url?.startsWith("/api/documents/") && request.method === "DELETE") {
              const result = deleteDocument(url.split("/")[3]);
              if (result.storedPath) await fs.rm(result.storedPath, { force: true });
              sendJson(response, 200, { deleted: result.deleted });
            }
            else if (url === "/api/rag/search" && request.method === "POST") {
              const body = await readBody(request);
              if (typeof body.query !== "string" || !body.query.trim()) throw new Error("A search query is required.");
              sendJson(response, 200, { results: await searchDocuments(body.query) });
            }
            else if (url === "/api/runtime/load" && request.method === "POST") {
              const body = await readBody(request);
              if (typeof body.modelKey !== "string") throw new Error("A unit key is required.");
              sendJson(response, 200, await loadModel(body.modelKey, Number(body.contextLength) || 8192));
            } else if (url === "/api/runtime/unload" && request.method === "POST") {
              try { await runLms(["unload", "voidcat-core"], 120_000); } catch { /* already unloaded */ }
              sendJson(response, 200, await runtimeStatus());
            } else if (url === "/api/chat" && request.method === "POST") await proxyChat(request, response);
            else sendJson(response, 404, { error: "Unknown local endpoint." });
          } catch (error) {
            if (!response.headersSent) sendJson(response, 500, { error: error instanceof Error ? error.message : "Local core failure" });
            else response.end();
          }
        })();
      });
    },
  };
}
