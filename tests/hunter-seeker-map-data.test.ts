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

test("map data emits distinct aviation, maritime, orbital, and seismic points plus provider weather geometry", () => {
  const data = buildHunterSeekerMapData([
    observation("adsb.lol.military", { aircraftType: "V22", trackDegrees: 145.5 }),
    observation("test.civilian-aircraft", { aircraftType: "A320", trackDegrees: 90 }),
    observation("aisstream.maritime", { mmsi: "367123456", trackDegrees: 84.2 }),
    observation("celestrak.space-stations", { noradCatalogId: "25544", propagationModel: "SGP4" }),
    observation("usgs.earthquakes", { magnitude: 4.2 }),
    observation("noaa.nws-alerts", {
      severity: "severe",
      geometry: { type: "Polygon", coordinates: [[[-91, 34], [-89, 34], [-89, 36], [-91, 36], [-91, 34]]] },
    }),
  ]);
  assert.equal(data.features.length, 7);
  assert.deepEqual(data.features.map((feature) => feature.properties.kind), ["military-aircraft-point", "civilian-aircraft-point", "maritime-vessel-point", "space-station-point", "seismic-point", "weather-area", "weather-point"]);
  assert.equal(data.features[5].geometry.type, "Polygon");
  assert.equal(data.features[5].properties.severity, "severe");
  assert.equal(data.features[4].properties.magnitude, 4.2);
  assert.equal(data.features[0].properties.headingDegrees, 145.5);
  assert.equal(data.features[1].properties.headingDegrees, 90);
  assert.equal(data.features[2].properties.headingDegrees, 84.2);
  assert.equal("attributes" in data.features[0].properties, false);
});
