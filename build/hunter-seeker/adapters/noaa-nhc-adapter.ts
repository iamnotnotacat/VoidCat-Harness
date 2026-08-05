/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import { SourceAdapterHttpError, type AdapterFetchContext, type AdapterNormalizeContext, type AdapterReportedHealth, type NormalizedObservation, type SourceAdapter, type SourceDescriptor } from "../source-adapter.ts";

export const NOAA_NHC_SOURCE_ID = "noaa.nhc";
const ENDPOINT = "https://www.nhc.noaa.gov/CurrentStorms.json";
const MAX_BYTES = 1_000_000;
type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type JsonRecord = Record<string, unknown>;
type NhcPayload = { activeStorms?: unknown[] };

function record(value: unknown): JsonRecord { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}; }
function text(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function number(value: unknown) { if (typeof value === "number" && Number.isFinite(value)) return value; if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value); return undefined; }
function timestamp(value: unknown, fallback: string) { const candidate = text(value); return candidate && Number.isFinite(Date.parse(candidate)) ? new Date(candidate).toISOString() : fallback; }

async function boundedJson(response: Response): Promise<NhcPayload> {
  const declared = Number(response.headers.get("content-length")); if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error("NOAA NHC response exceeded the 1 MB limit.");
  const body = await response.text(); if (new TextEncoder().encode(body).byteLength > MAX_BYTES) throw new Error("NOAA NHC response exceeded the 1 MB limit.");
  try { return JSON.parse(body) as NhcPayload; } catch { throw new Error("NOAA NHC returned malformed JSON."); }
}

function intensitySeverity(knots: number | undefined) { return knots === undefined ? null : Math.max(0.15, Math.min(1, knots / 140)); }

export class NoaaNhcAdapter implements SourceAdapter<NhcPayload> {
  readonly descriptor: SourceDescriptor = {
    id: NOAA_NHC_SOURCE_ID, displayName: "NOAA/NHC Active Tropical Systems", category: "weather", authTier: "tier-1", credentialType: "none",
    pollCadenceMs: 15 * 60_000, rateLimit: { requestsPerWindow: 1, windowMs: 5 * 60_000, hardHourlyBudget: 4 },
    providerDocsUrl: "https://www.nhc.noaa.gov/gis/", cache: { ttlMs: 30 * 60_000, maxObservations: 100, replaceOnWrite: true },
    healthPolicy: { expectedMinimumObservations: 0, consecutiveBelowExpectedLimit: 3 }, retentionPolicy: { mode: "live-only" }, estimatedBytesPerDay: 100_000,
  };
  private readonly fetchImplementation: FetchImplementation;
  private healthState: AdapterReportedHealth = { status: "degraded", message: "Awaiting the first NHC refresh." };
  constructor(options: { fetchImplementation?: FetchImplementation } = {}) { this.fetchImplementation = options.fetchImplementation ?? fetch; }

  async fetch(context: AdapterFetchContext) {
    try {
      const response = await this.fetchImplementation(ENDPOINT, { method: "GET", headers: { Accept: "application/json", "User-Agent": "VoidCat-Harness/1.0 passive-weather" }, credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]) });
      if (!response.ok) throw new SourceAdapterHttpError(`NOAA NHC returned HTTP ${response.status}.`, response.status);
      const payload = await boundedJson(response); if (!Array.isArray(payload.activeStorms)) throw new Error("NOAA NHC did not return an activeStorms list.");
      this.healthState = { status: "healthy", message: "NHC active tropical systems are current." }; return payload;
    } catch (error) { this.healthState = { status: error instanceof SourceAdapterHttpError && error.statusCode >= 500 ? "down" : "degraded", message: error instanceof Error ? error.message : "NOAA NHC request failed." }; throw error; }
  }

  normalize(payload: NhcPayload, context: AdapterNormalizeContext): NormalizedObservation[] {
    const observations = (payload.activeStorms ?? []).slice(0, 100).flatMap((entry): NormalizedObservation[] => {
      const storm = record(entry); const id = text(storm.id ?? storm.binNumber); const latitude = number(storm.latitudeNumeric ?? storm.latitude); const longitude = number(storm.longitudeNumeric ?? storm.longitude);
      if (!id || latitude === undefined || longitude === undefined || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return [];
      const observedAt = timestamp(storm.lastUpdate ?? storm.lastUpdateString ?? storm.advisoryDate, context.fetchedAt);
      const windKnots = number(storm.intensity ?? storm.intensityKph); const severityScore = intensitySeverity(windKnots);
      const sourceUrl = text(storm.publicAdvisory?.toString()) ?? text(storm.track?.toString()) ?? `https://www.nhc.noaa.gov/refresh/graphics_at${encodeURIComponent(id)}+shtml/`;
      return [{ observationId: `${NOAA_NHC_SOURCE_ID}:${id}:${observedAt}`, entityId: `tropical-system:${id}`, entityType: "natural-event.storm", position: { latitude, longitude }, timestamp: observedAt,
        provenance: { sourceFeedId: NOAA_NHC_SOURCE_ID, fetchedAt: context.fetchedAt, receivedAt: context.receivedAt, upstreamTimestamp: observedAt, stalenessMs: Math.max(0, Date.parse(context.receivedAt) - Date.parse(observedAt)) },
        confidence: 0.96, basis: "measured", retentionClass: "bulk",
        attributes: { sourceEventId: id, eventType: "tropical_system_advisory", publishedAt: observedAt, title: [text(storm.classification), text(storm.name)].filter(Boolean).join(" ") || id, stormId: id, classification: text(storm.classification), windKnots, pressureMillibars: number(storm.pressure), movementDirection: text(storm.movementDir), movementSpeedKnots: number(storm.movementSpeed), severity: severityScore !== null && severityScore >= 0.8 ? "extreme" : severityScore !== null && severityScore >= 0.55 ? "severe" : "moderate", severityScore, sourceUrl, license: "NOAA/NWS public data", sourceName: "NOAA National Hurricane Center", coverageLimitation: "Tropical advisories are official forecast and analysis products; projected impacts remain uncertain and change between advisories." }, rawPayload: storm }];
    });
    this.healthState = { status: "healthy", message: observations.length ? `${observations.length} active NHC tropical system${observations.length === 1 ? "" : "s"}.` : "NHC reports no active tropical systems." }; return observations;
  }
  health() { return this.healthState; }
}
