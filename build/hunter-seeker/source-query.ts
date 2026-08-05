/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import { createHash } from "node:crypto";
import type { NormalizedObservation } from "./source-adapter.ts";
import { validateNormalizedObservation } from "./source-adapter.ts";
import { getHunterSeekerCatalogSource, type HunterSeekerCatalogSource } from "./source-catalog.ts";

export type HunterBoundingBox = { west: number; south: number; east: number; north: number };
export type HunterQueryPoint = { latitude: number; longitude: number; radiusKm?: number };
export type HunterSourceQueryInput = {
  sourceId: string;
  bbox?: HunterBoundingBox;
  point?: HunterQueryPoint;
  query?: string;
  resource?: string;
  startAt?: string;
  endAt?: string;
  limit?: number;
};

export type HunterSourceReference = {
  id: string;
  title: string;
  url: string;
  description?: string;
  publishedAt?: string;
  license: string;
  properties?: Record<string, unknown>;
};

export type HunterMapOverlay = {
  id: string;
  sourceId?: string;
  title: string;
  type: "raster";
  tiles: string[];
  tileSize: 256 | 512;
  opacity: number;
  attribution: string;
  minimumZoom?: number;
  maximumZoom?: number;
};

export type HunterSourceQueryPayload = {
  observations: NormalizedObservation[];
  references?: HunterSourceReference[];
  overlays?: HunterMapOverlay[];
  coverageLimitation?: string;
};

export type HunterSourceQueryContext = {
  signal: AbortSignal;
  requestedAt: string;
  fetchJson: <T = unknown>(url: string, options?: RequestInit & { maximumBytes?: number }) => Promise<T>;
  fetchText: (url: string, options?: RequestInit & { maximumBytes?: number }) => Promise<string>;
  fetchBytes: (url: string, options?: RequestInit & { maximumBytes?: number }) => Promise<Uint8Array>;
  queryCredentialBroker: (input: HunterSourceQueryInput, signal: AbortSignal) => Promise<unknown>;
};

export interface HunterSourceQueryProvider {
  readonly sourceId: string;
  readonly capability: "live" | "viewport" | "historical" | "catalog" | "resource";
  readonly requires: readonly ("bbox" | "point" | "query" | "resource" | "time-window")[];
  readonly minimumIntervalMs: number;
  readonly cacheTtlMs: number;
  readonly credentialBroker: boolean;
  query(input: HunterSourceQueryInput, context: HunterSourceQueryContext): Promise<HunterSourceQueryPayload>;
}

export type HunterSourceQueryResult = HunterSourceQueryPayload & {
  source: HunterSeekerCatalogSource;
  queriedAt: string;
  cache: { status: "live" | "cached"; ageMs: number; expiresAt: string };
};

type CacheEntry = { storedAt: number; expiresAt: number; payload: HunterSourceQueryPayload };

const MAX_QUERY_RESPONSE_BYTES = 8_000_000;
const MAX_QUERY_CACHE_ENTRIES = 100;

function queryHash(input: HunterSourceQueryInput) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 24);
}

function validateHttpUrl(value: string) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") throw new Error("Hunter-Seeker source requests require HTTPS.");
  if (parsed.username || parsed.password) throw new Error("Credential-bearing source URLs are blocked.");
  return parsed;
}

export function validateHunterSourceQueryInput(input: HunterSourceQueryInput) {
  if (!getHunterSeekerCatalogSource(input.sourceId)) throw new Error("A registered Hunter-Seeker catalog source is required.");
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500)) throw new Error("Source query limit must be between 1 and 500.");
  if (input.query !== undefined && (typeof input.query !== "string" || input.query.trim().length < 2 || input.query.length > 240)) throw new Error("Source query text must contain 2 to 240 characters.");
  if (input.resource !== undefined && (typeof input.resource !== "string" || input.resource.trim().length < 1 || input.resource.length > 240)) throw new Error("Source resource must contain 1 to 240 characters.");
  if (input.bbox) {
    const { west, south, east, north } = input.bbox;
    if (![west, south, east, north].every(Number.isFinite) || west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) throw new Error("Source bounding box must be valid WGS84 coordinates.");
  }
  if (input.point) {
    if (!Number.isFinite(input.point.latitude) || input.point.latitude < -90 || input.point.latitude > 90 || !Number.isFinite(input.point.longitude) || input.point.longitude < -180 || input.point.longitude > 180) throw new Error("Source point must be valid WGS84 coordinates.");
    if (input.point.radiusKm !== undefined && (!Number.isFinite(input.point.radiusKm) || input.point.radiusKm <= 0 || input.point.radiusKm > 500)) throw new Error("Source radius must be greater than zero and no more than 500 km.");
  }
  for (const value of [input.startAt, input.endAt]) if (value !== undefined && !Number.isFinite(Date.parse(value))) throw new Error("Source time-window values must be valid timestamps.");
  if (input.startAt && input.endAt && Date.parse(input.startAt) > Date.parse(input.endAt)) throw new Error("Source time window cannot end before it starts.");
  return { ...input, limit: input.limit ?? 100 };
}

export class HunterSourceQueryRegistry {
  private readonly providers = new Map<string, HunterSourceQueryProvider>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly nextAllowedAt = new Map<string, number>();
  private readonly now: () => number;
  private readonly fetchImplementation: typeof fetch;
  private readonly brokerQuery: (input: HunterSourceQueryInput, signal: AbortSignal) => Promise<unknown>;

  constructor(options: { providers?: HunterSourceQueryProvider[]; now?: () => number; fetchImplementation?: typeof fetch; brokerQuery?: (input: HunterSourceQueryInput, signal: AbortSignal) => Promise<unknown> } = {}) {
    this.now = options.now ?? Date.now;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.brokerQuery = options.brokerQuery ?? (async () => { throw new Error("The protected Hunter-Seeker credential broker is unavailable."); });
    for (const provider of options.providers ?? []) this.register(provider);
  }

  register(provider: HunterSourceQueryProvider) {
    const catalog = getHunterSeekerCatalogSource(provider.sourceId);
    if (!catalog) throw new Error(`Query provider ${provider.sourceId} is not present in the source catalog.`);
    if (this.providers.has(provider.sourceId)) throw new Error(`Query provider ${provider.sourceId} is already registered.`);
    if (!Number.isFinite(provider.minimumIntervalMs) || provider.minimumIntervalMs < 0 || !Number.isFinite(provider.cacheTtlMs) || provider.cacheTtlMs < 1_000) throw new Error(`Query provider ${provider.sourceId} has unsafe request controls.`);
    this.providers.set(provider.sourceId, provider);
  }

  list() {
    return [...this.providers.values()].map((provider) => ({ sourceId: provider.sourceId, capability: provider.capability, requires: provider.requires, credentialBroker: provider.credentialBroker }));
  }

  has(sourceId: string) { return this.providers.has(sourceId); }

  async query(untrustedInput: HunterSourceQueryInput, options: { signal?: AbortSignal; bypassCache?: boolean } = {}): Promise<HunterSourceQueryResult> {
    const input = validateHunterSourceQueryInput(untrustedInput);
    const provider = this.providers.get(input.sourceId);
    if (!provider) throw new Error(`${input.sourceId} does not have an installed query provider.`);
    for (const requirement of provider.requires) {
      if (requirement === "time-window" ? (!input.startAt || !input.endAt) : !input[requirement]) throw new Error(`${input.sourceId} requires a bounded ${requirement.replace("-", " ")} input.`);
    }
    const cacheKey = `${input.sourceId}:${queryHash(input)}`;
    const currentTime = this.now();
    const cached = this.cache.get(cacheKey);
    if (!options.bypassCache && cached && cached.expiresAt > currentTime) return this.result(input.sourceId, cached.payload, cached.storedAt, cached.expiresAt, "cached");
    const allowedAt = this.nextAllowedAt.get(input.sourceId) ?? 0;
    if (allowedAt > currentTime) throw new Error(`${input.sourceId} request guard is active until ${new Date(allowedAt).toISOString()}.`);
    this.nextAllowedAt.set(input.sourceId, currentTime + provider.minimumIntervalMs);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Hunter-Seeker source query timed out.")), 25_000);
    const cancel = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", cancel, { once: true });
    const fetchBytes = async (rawUrl: string, request: RequestInit & { maximumBytes?: number } = {}) => {
      const url = validateHttpUrl(rawUrl);
      const { maximumBytes: requestedMaximumBytes, ...fetchOptions } = request;
      const response = await this.fetchImplementation(url, { ...fetchOptions, redirect: "error", signal: controller.signal, headers: { Accept: "application/json, application/geo+json, text/csv, text/plain", "User-Agent": "VoidCat-Harness/1.0 (+https://www.iamnotnotacat.com)", ...(request.headers ?? {}) } });
      if (!response.ok) throw new Error(`${input.sourceId} returned HTTP ${response.status}.`);
      const maximumBytes = Math.min(MAX_QUERY_RESPONSE_BYTES, Math.max(1_024, requestedMaximumBytes ?? 2_000_000));
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maximumBytes) throw new Error(`${input.sourceId} response exceeded its ${maximumBytes.toLocaleString()} byte limit.`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maximumBytes) throw new Error(`${input.sourceId} response exceeded its ${maximumBytes.toLocaleString()} byte limit.`);
      return bytes;
    };
    const fetchText = async (url: string, request?: RequestInit & { maximumBytes?: number }) => new TextDecoder().decode(await fetchBytes(url, request));
    try {
      const payload = await provider.query(input, {
        signal: controller.signal,
        requestedAt: new Date(currentTime).toISOString(),
        fetchBytes,
        queryCredentialBroker: this.brokerQuery,
        fetchText,
        fetchJson: async <T>(url: string, request?: RequestInit & { maximumBytes?: number }) => {
          const text = await fetchText(url, request);
          try { return JSON.parse(text) as T; } catch { throw new Error(`${input.sourceId} returned malformed JSON.`); }
        },
      });
      const observations = payload.observations.slice(0, input.limit);
      for (const observation of observations) validateNormalizedObservation(observation, input.sourceId);
      const boundedPayload = { ...payload, observations, references: payload.references?.slice(0, input.limit) };
      const expiresAt = currentTime + provider.cacheTtlMs;
      this.cache.set(cacheKey, { storedAt: currentTime, expiresAt, payload: structuredClone(boundedPayload) });
      while (this.cache.size > MAX_QUERY_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
      return this.result(input.sourceId, boundedPayload, currentTime, expiresAt, "live");
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", cancel);
    }
  }

  private result(sourceId: string, payload: HunterSourceQueryPayload, storedAt: number, expiresAt: number, status: "live" | "cached"): HunterSourceQueryResult {
    return { source: getHunterSeekerCatalogSource(sourceId)!, ...structuredClone(payload), queriedAt: new Date(storedAt).toISOString(), cache: { status, ageMs: Math.max(0, this.now() - storedAt), expiresAt: new Date(expiresAt).toISOString() } };
  }
}
