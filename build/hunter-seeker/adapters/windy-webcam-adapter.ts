/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import type { NormalizedObservation, SourceAdapter, SourceDescriptor } from "../source-adapter.ts";
import { publicWebcamRegions, type PublicWebcamRegion } from "./public-webcam-adapter.ts";

export const WINDY_WEBCAM_SOURCE_ID = "windy.public-webcams";

export const WINDY_WEBCAM_DESCRIPTOR: SourceDescriptor = {
  id: WINDY_WEBCAM_SOURCE_ID,
  displayName: "Windy Public Webcams — Regional",
  category: "imagery",
  authTier: "tier-2",
  credentialType: "api-key",
  pollCadenceMs: 24 * 60 * 60_000,
  rateLimit: { requestsPerWindow: 20, windowMs: 10 * 60_000, hardHourlyBudget: 60 },
  providerDocsUrl: "https://api.windy.com/webcams/docs",
  signupUrl: "https://api.windy.com/keys",
  cache: { ttlMs: 15 * 60_000, maxObservations: 162, replaceOnWrite: true },
  healthPolicy: { expectedMinimumObservations: 1, consecutiveBelowExpectedLimit: 3 },
  retentionPolicy: { mode: "live-only" },
  estimatedBytesPerDay: 0,
};

export class WindyWebcamAdapter implements SourceAdapter<{ regions: PublicWebcamRegion[] }> {
  readonly descriptor = WINDY_WEBCAM_DESCRIPTOR;
  async fetch() { return { regions: publicWebcamRegions() }; }
  normalize(payload: { regions: PublicWebcamRegion[] }, context: { fetchedAt: string; receivedAt: string }): NormalizedObservation[] {
    return payload.regions.map((region) => ({
      observationId: `${WINDY_WEBCAM_SOURCE_ID}:region:${region.id}`,
      entityId: `windy-webcam-region:${region.id}`,
      entityType: "imagery.public-webcam-region",
      position: { latitude: region.latitude, longitude: Math.min(179.5, region.longitude + 2.2) },
      timestamp: context.fetchedAt,
      provenance: { sourceFeedId: WINDY_WEBCAM_SOURCE_ID, fetchedAt: context.fetchedAt, receivedAt: context.receivedAt, stalenessMs: 0 },
      confidence: 1,
      basis: "derived",
      retentionClass: "bulk",
      attributes: { title: `WINDY ${region.label}`, regionId: region.id, regionLabel: `WINDY ${region.label}`, sourceName: "Windy Webcams regional index", coverageLimitation: "Select this offset Windy hub to load the provider's public webcam and timelapse catalog for the sector." },
    }));
  }
  health() { return { status: "healthy" as const, message: "Windy webcam sectors are ready; select a Windy hub to load its independent public-camera catalog." }; }
}
