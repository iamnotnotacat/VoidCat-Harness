import assert from "node:assert/strict";
import test from "node:test";
import { buildHunterSeekerMapData, type HunterSeekerObservation } from "../app/hunter-seeker-map-data.ts";

function observation(sourceFeedId: string, attributes: Record<string, unknown>): HunterSeekerObservation {
  return {
    observationId: `${sourceFeedId}:one`,
    entityId: `${sourceFeedId}:one`,
    entityType: sourceFeedId === "noaa.nws-alerts" ? "weather-alert" : "earthquake",
    position: { latitude: 35, longitude: -90 },
    timestamp: "2026-07-27T12:00:00.000Z",
    provenance: { sourceFeedId, fetchedAt: "2026-07-27T12:01:00.000Z", receivedAt: "2026-07-27T12:01:00.000Z", stalenessMs: 60_000 },
    confidence: 0.9,
    basis: "measured",
    retentionClass: "bulk",
    attributes,
  };
}

test("map data emits one seismic point and provider weather area plus centroid", () => {
  const data = buildHunterSeekerMapData([
    observation("usgs.earthquakes", { magnitude: 4.2 }),
    observation("noaa.nws-alerts", {
      severity: "severe",
      geometry: { type: "Polygon", coordinates: [[[-91, 34], [-89, 34], [-89, 36], [-91, 36], [-91, 34]]] },
    }),
  ]);
  assert.equal(data.features.length, 3);
  assert.deepEqual(data.features.map((feature) => feature.properties.kind), ["seismic-point", "weather-area", "weather-point"]);
  assert.equal(data.features[1].geometry.type, "Polygon");
  assert.equal(data.features[1].properties.severity, "severe");
  assert.equal(data.features[0].properties.magnitude, 4.2);
  assert.equal("attributes" in data.features[0].properties, false);
});
