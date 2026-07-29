/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildHunterSeekerMapData, type HunterSeekerObservation } from "../app/hunter-seeker-map-data.ts";

function observation(sourceFeedId: string, attributes: Record<string, unknown>): HunterSeekerObservation {
  return {
    observationId: `${sourceFeedId}:one`,
    entityId: `${sourceFeedId}:one`,
    entityType: sourceFeedId === "noaa.nws-alerts" ? "weather-alert" : sourceFeedId.includes("aircraft") ? "civilian-aircraft" : sourceFeedId.includes("aisstream") ? "maritime-vessel" : "earthquake",
    position: { latitude: 35, longitude: -90 },
    timestamp: "2026-07-27T12:00:00.000Z",
    provenance: { sourceFeedId, fetchedAt: "2026-07-27T12:01:00.000Z", receivedAt: "2026-07-27T12:01:00.000Z", stalenessMs: 60_000 },
    confidence: 0.9,
    basis: "measured",
    retentionClass: "bulk",
    attributes,
  };
}

test("map data emits distinct aviation, maritime, orbital, camera, and seismic points plus provider weather geometry", () => {
  const region = observation("deflock.osm-alpr", { regionId: "20/-100", regionLabel: "DEFLOCK SECTOR 30°N 90°W" });
  region.observationId = "deflock.osm-alpr:region:20/-100";
  region.entityId = "deflock-region:20/-100";
  region.entityType = "infrastructure.deflock-region";
  const observations = [
    observation("adsb.lol.military", { aircraftType: "V22", trackDegrees: 145.5 }),
    observation("test.civilian-aircraft", { aircraftType: "A320", trackDegrees: 90 }),
    observation("aisstream.maritime", { mmsi: "367123456", trackDegrees: 84.2 }),
    observation("celestrak.space-stations", { noradCatalogId: "25544", propagationModel: "SGP4" }),
    observation("deflock.osm-alpr", { manufacturer: "Flock Safety", cameraType: "automatic-license-plate-reader" }),
    region,
    observation("usgs.earthquakes", { magnitude: 4.2 }),
    observation("noaa.nws-alerts", {
      severity: "severe",
      geometry: { type: "Polygon", coordinates: [[[-91, 34], [-89, 34], [-89, 36], [-91, 36], [-91, 34]]] },
    }),
  ];
  const data = buildHunterSeekerMapData(observations, { "adsb.lol.military:one": "live", "aisstream.maritime:one": "cached" });
  assert.equal(data.features.length, 9);
  assert.deepEqual(data.features.map((feature) => feature.properties.kind), ["military-aircraft-point", "civilian-aircraft-point", "maritime-vessel-point", "space-station-point", "alpr-camera-point", "deflock-region-point", "seismic-point", "weather-area", "weather-point"]);
  assert.equal(data.features[7].geometry.type, "Polygon");
  assert.equal(data.features[7].properties.severity, "severe");
  assert.equal(data.features[6].properties.magnitude, 4.2);
  assert.equal(data.features[5].properties.regionId, "20/-100");
  assert.equal(data.features[0].properties.headingDegrees, 145.5);
  assert.equal(data.features[1].properties.headingDegrees, 90);
  assert.equal(data.features[2].properties.headingDegrees, 84.2);
  assert.equal(data.features[0].properties.freshness, "live");
  assert.equal(data.features[2].properties.freshness, "cached");
  assert.equal(data.features[7].properties.freshness, "degraded");
  assert.equal("attributes" in data.features[0].properties, false);
});
