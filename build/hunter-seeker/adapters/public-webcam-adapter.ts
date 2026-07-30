/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import type { NormalizedObservation, SourceAdapter, SourceDescriptor } from "../source-adapter.ts";

export const PUBLIC_WEBCAM_SOURCE_ID = "youtube.live-webcams";
export const PUBLIC_WEBCAM_REGION_DEGREES = 20;
export const PUBLIC_WEBCAM_INDEX_REFRESH_MS = 24 * 60 * 60_000;

export type PublicWebcamRegion = {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  south: number;
  west: number;
  north: number;
  east: number;
};

function coordinateLabel(latitude: number, longitude: number) {
  const lat = `${Math.abs(latitude).toFixed(0)}°${latitude < 0 ? "S" : "N"}`;
  const lon = `${Math.abs(longitude).toFixed(0)}°${longitude < 0 ? "W" : "E"}`;
  return `YOUTUBE LIVE SECTOR ${lat} ${lon}`;
}

export function publicWebcamRegions(): PublicWebcamRegion[] {
  const regions: PublicWebcamRegion[] = [];
  for (let south = -90; south < 90; south += PUBLIC_WEBCAM_REGION_DEGREES) {
    for (let west = -180; west < 180; west += PUBLIC_WEBCAM_REGION_DEGREES) {
      const north = Math.min(90, south + PUBLIC_WEBCAM_REGION_DEGREES);
      const east = Math.min(180, west + PUBLIC_WEBCAM_REGION_DEGREES);
      const latitude = (south + north) / 2;
      const longitude = (west + east) / 2;
      regions.push({ id: `${south}/${west}`, label: coordinateLabel(latitude, longitude), latitude, longitude, south, west, north, east });
    }
  }
  return regions;
}

export const PUBLIC_WEBCAM_DESCRIPTOR: SourceDescriptor = {
  id: PUBLIC_WEBCAM_SOURCE_ID,
  displayName: "YouTube Live Cameras — Regional",
  category: "imagery",
  authTier: "tier-2",
  credentialType: "api-key",
  pollCadenceMs: PUBLIC_WEBCAM_INDEX_REFRESH_MS,
  rateLimit: { requestsPerWindow: 12, windowMs: 60 * 60_000, hardHourlyBudget: 12 },
  providerDocsUrl: "https://developers.google.com/youtube/v3/docs/search/list",
  signupUrl: "https://console.cloud.google.com/apis/credentials",
  cache: { ttlMs: PUBLIC_WEBCAM_INDEX_REFRESH_MS, maxObservations: 162, replaceOnWrite: true },
  healthPolicy: { expectedMinimumObservations: 1, consecutiveBelowExpectedLimit: 3 },
  retentionPolicy: { mode: "live-only" },
  estimatedBytesPerDay: 0,
};

export class PublicWebcamAdapter implements SourceAdapter<{ regions: PublicWebcamRegion[] }> {
  readonly descriptor = PUBLIC_WEBCAM_DESCRIPTOR;

  async fetch() {
    return { regions: publicWebcamRegions() };
  }

  normalize(payload: { regions: PublicWebcamRegion[] }, context: { fetchedAt: string; receivedAt: string }): NormalizedObservation[] {
    return payload.regions.map((region) => ({
      observationId: `${PUBLIC_WEBCAM_SOURCE_ID}:region:${region.id}`,
      entityId: `public-webcam-region:${region.id}`,
      entityType: "imagery.public-webcam-region",
      position: { latitude: region.latitude, longitude: region.longitude },
      timestamp: context.fetchedAt,
      provenance: { sourceFeedId: PUBLIC_WEBCAM_SOURCE_ID, fetchedAt: context.fetchedAt, receivedAt: context.receivedAt, stalenessMs: 0 },
      confidence: 1,
      basis: "derived",
      retentionClass: "bulk",
      attributes: {
        title: region.label,
        regionId: region.id,
        regionLabel: region.label,
        regionBounds: { south: region.south, west: region.west, north: region.north, east: region.east },
        sourceName: "YouTube Live regional index",
        coverageLimitation: "A hub is a bounded 1,000 km search radius, not a camera. Select it to request public, embeddable broadcasts that are actively live and match camera terms. Still-frame and completed broadcasts are excluded.",
      },
    }));
  }

  health() {
    return { status: "healthy" as const, message: "Worldwide live-video sectors are ready; select a hub to load verified active broadcasts in the native video player." };
  }
}
