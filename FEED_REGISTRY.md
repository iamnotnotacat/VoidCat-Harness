# VC Hunter-Seeker feed registry

Provider behavior is verified from official documentation before an adapter is implemented. Registry request budgets are VoidCat safety ceilings unless a provider explicitly publishes a stricter limit.

All observation sources default to an enabled two-minute pull cadence for each app session. The Hunter-Seeker source matrix can disable each source independently or select a pull cadence from 30 seconds through 12 hours. Disabling a source cancels its scheduler and request, then clears that source's volatile observations. A user-selected cadence never bypasses a provider request floor, hourly request budget, or retry backoff.

## USGS Earthquakes — Past Day

| Field | Value |
|---|---|
| Registry ID | `usgs.earthquakes` |
| Category | Seismic |
| Authentication | Tier 1 — none |
| Endpoint | `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson` |
| Provider update cadence | Every minute |
| Default VoidCat pull cadence | 2 minutes; user-selectable from 30 seconds to 12 hours |
| VoidCat request ceiling | 1 request per 55 seconds; 60 per hour |
| Cache | Live-only, five-minute TTL, maximum 20,000 observations |
| Estimated transfer ceiling | 500 MB/day before conditional-request savings |
| Attribution | Credit: U.S. Geological Survey |
| Verified | 2026-07-27 |

Official references:

- [USGS GeoJSON Summary Format](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php)
- [USGS production feed lifecycle policy](https://earthquake.usgs.gov/earthquakes/feed/policy.php)
- [USGS Earthquake Catalog API](https://earthquake.usgs.gov/fdsnws/event/1/)
- [USGS copyright and credit guidance](https://www.usgs.gov/faqs/are-usgs-reportspublications-copyrighted)

USGS identifies GeoJSON as its programmatic application format and recommends the real-time summary feeds for automated earthquake displays. The adapter uses the versioned production v1.0 feed and conditional `ETag`/`Last-Modified` requests when the server supplies them.

GeoJSON point coordinates are interpreted as longitude, latitude, and positive depth in kilometers. VoidCat exposes that depth in `attributes.depthKm` and converts it to negative `position.altitudeMeters`. The event's origin time remains the observation timestamp; the USGS `updated` time is retained as upstream provenance for freshness calculations.

The source's `reviewed` and `automatic` statuses are surfaced verbatim. VoidCat assigns a transparent display-confidence heuristic of 0.95 to reviewed events, 0.75 to automatic events, and 0.65 when review status is absent or unknown. This is a VoidCat presentation heuristic, not a USGS probability or scientific uncertainty estimate.

USGS-authored data and information are generally in the U.S. public domain; USGS requests acknowledgement as the source. No provider request quota was found on the official feed documentation, so the request ceilings above are conservative local controls rather than claimed USGS limits.

## NOAA/NWS Active Alerts

| Field | Value |
|---|---|
| Registry ID | `noaa.nws-alerts` |
| Category | Weather |
| Authentication | Tier 1 — no credential; identifying User-Agent required |
| Endpoint | `https://api.weather.gov/alerts/active` |
| Provider request guidance | No more often than every 30 seconds |
| Default VoidCat pull cadence | 2 minutes; user-selectable from 30 seconds to 12 hours |
| VoidCat request ceiling | 1 request per 30 seconds; 120 per hour |
| Cache | Live-only, ten-minute TTL, maximum 10,000 observations |
| Maximum response | 12 MB |
| Attribution | Credit: NOAA / National Weather Service |
| Verified | 2026-07-27 |

Official references:

- [NWS Alerts Web Service](https://www.weather.gov/documentation/services-web-alerts)
- [NWS API Web Service](https://www.weather.gov/documentation/services-web-api)
- [NWS Alerts Geolocation Guide](https://www.weather.gov/media/documentation/docs/NWS_Geolocation.pdf)

NWS explicitly provides its alert API for redistribution and decision-support tools. The service is open data and free to use, requires an identifying `User-Agent`, and asks consumers not to poll active alerts more often than every 30 seconds. VoidCat defaults to two minutes, preserves that provider floor when the slider is at its minimum, and uses conditional `ETag`/`Last-Modified` requests when available.

The adapter plots only alerts for which NWS supplies Polygon or MultiPolygon geometry. It computes a display centroid for the normalized position while preserving the provider geometry for the weather layer. Alerts without provider geometry remain unplotted; VoidCat does not infer or guess a location from prose or zone names.

CAP certainty is mapped to a transparent display-confidence heuristic: observed 0.95, likely 0.85, possible 0.65, unlikely 0.40, and unknown 0.50. This is a VoidCat presentation mapping, not a numerical probability issued by NWS. Alert severity, urgency, certainty, timestamps, instructions, and provenance remain visible as provider fields.

## OpenFreeMap dark basemap

| Field | Value |
|---|---|
| Role | Interactive basemap; not an observation feed |
| Authentication | None |
| Style | `https://tiles.openfreemap.org/styles/dark` |
| Network allowlist | `https://tiles.openfreemap.org` only |
| Local tile cache | Maximum 96 in-memory tiles |
| Persistent cache | Disabled by Electron in-memory session partition |
| Attribution | Rendered by MapLibre from provider style metadata |
| Verified | 2026-07-27 |

Official references:

- [OpenFreeMap Quick Start](https://openfreemap.org/quick_start/)
- [OpenFreeMap service and attribution](https://openfreemap.org/)
- [MapLibre GL JS documentation](https://maplibre.org/maplibre-gl-js/docs/)
- [Electron in-memory sessions](https://www.electronjs.org/docs/latest/api/session)

OpenFreeMap describes its public instance as free, without API keys, registration, cookies, map-view limits, or request limits. MapLibre automatically renders the required OpenFreeMap, OpenMapTiles, and OpenStreetMap attribution supplied by the style.

The renderer exists only while the Hunter-Seeker panel is mounted. It uses a low-power WebGL context, disables pitch and rotation, caps the tile cache, disables expired-tile refreshes, cancels obsolete zoom requests, and falls back to a local token-colored background if the remote style cannot load within eight seconds.
