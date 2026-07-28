# VC Hunter-Seeker feed registry

Provider behavior is verified from official documentation before an adapter is implemented. Registry request budgets are VoidCat safety ceilings unless a provider explicitly publishes a stricter limit.

All observation sources default to an enabled two-minute pull cadence for each app session. The Hunter-Seeker source matrix can disable each source independently or select a pull cadence from 30 seconds through 12 hours. Disabling a source cancels its scheduler and active request, hides the layer, and retains its latest valid volatile snapshot through the remaining selected pull interval. Re-enabling within that interval restores the snapshot immediately without making a premature provider request. Global disconnect and app shutdown clear volatile observations. A user-selected cadence and the manual refresh action never bypass a provider request floor, hard hourly request budget, provider retry instruction, or failure backoff.

## CelesTrak Space Stations

| Field | Value |
|---|---|
| Registry ID | `celestrak.space-stations` |
| Category | Space |
| Authentication | Tier 1 — none |
| Endpoint | `https://celestrak.org/NORAD/elements/gp.php?GROUP=STATIONS&FORMAT=JSON` |
| Provider data update cadence | Once every 2 hours |
| Default VoidCat display refresh | 2 minutes; positions are re-propagated locally from cached elements |
| CelesTrak network request floor | 2 hours, enforced inside the adapter |
| Cache | Live-only, three-hour orbital-element TTL, maximum 500 station records |
| Maximum response | 2 MB |
| Position model | SGP4 propagation from OMM JSON general perturbations elements |
| Estimated transfer ceiling | 24 MB/day before the internal provider gate; actual scheduled network use is far lower |
| Attribution | Credit: CelesTrak |
| Verified | 2026-07-27 |

Official references:

- [CelesTrak GP query and OMM format documentation](https://celestrak.org/NORAD/documentation/gp-data-formats.php)
- [CelesTrak usage policy](https://celestrak.org/usage-policy.php)
- [CelesTrak Space Stations group](https://celestrak.org/NORAD/elements/table.php?GROUP=STATIONS&FORMAT=JSON)

VoidCat uses CelesTrak's current OMM JSON query rather than the legacy TLE format. This avoids the five-digit catalog-number limit and preserves full ISO orbital-element epochs. The downloaded element set remains volatile and is discarded when Hunter-Seeker disconnects or the app exits.

The source matrix still defaults to a two-minute refresh, but those passes only re-propagate current station subpoints locally with SGP4. The adapter downloads CelesTrak GP data no more than once per two hours, as required by the provider's usage policy. Any non-HTTP-200 provider response stops further network requests for the remainder of the app session and degrades only this layer.

Station positions are predictions derived from orbital elements, not direct measurements. Each contact is marked `estimated`, exposes the element-set epoch and age, and uses a transparent presentation-confidence heuristic based only on that age: 0.92 at up to one day, 0.80 at up to three days, 0.65 at up to seven days, and 0.45 after seven days. These values are VoidCat display metadata, not CelesTrak accuracy guarantees.

## adsb.lol Military Aircraft

| Field | Value |
|---|---|
| Registry ID | `adsb.lol.military` |
| Category | Aviation |
| Authentication | Tier 1 — none at present |
| Endpoint | `https://api.adsb.lol/v2/mil` |
| Provider update cadence | Live aggregated receiver data |
| Default VoidCat pull cadence | 2 minutes; user-selectable from 30 seconds to 12 hours |
| VoidCat request ceiling | 1 request per 60 seconds; 60 per hour |
| Cache | Live-only, five-minute TTL, maximum 2,000 positioned aircraft |
| Response safety ceiling | 4 MB and 5,000 aircraft records |
| Estimated transfer ceiling | 500 MB/day before conditional-request savings |
| License | Open Data Commons Open Database License v1.0 |
| Attribution | Credit: adsb.lol |
| Verified | 2026-07-27 |

Official references:

- [adsb.lol API and terms](https://api.adsb.lol/docs)
- [adsb.lol OpenAPI schema](https://api.adsb.lol/api/openapi.json)
- [Open Data Commons ODbL v1.0](https://opendatacommons.org/licenses/odbl/1-0/)

The documented `/v2/mil` endpoint returns aircraft marked as military-registered by the provider. VoidCat does not infer military status and does not enumerate receivers or aircraft infrastructure. It passively consumes the provider's public aggregate endpoint as an intended API client.

Only contacts with provider-supplied coordinates are plotted. A provider `lastPosition` fallback is accepted only when it is no more than 15 minutes old and is explicitly labelled as a last position. Contacts without a recent position remain unplotted. The source timestamp is reconstructed from the response's `now` epoch and each record's documented `seen_pos` age so staleness remains visible.

VoidCat assigns a transparent display-confidence heuristic of 0.90 to direct ADS-B coordinates, 0.75 to MLAT coordinates, 0.65 to TIS-B coordinates, 0.60 to other current broadcast positions, and 0.55 to a recent `lastPosition` fallback. These values are presentation metadata, not provider-issued accuracy probabilities.

adsb.lol currently states that the API is free and that a feeder-issued API key may be required in the future. It also asks production users to make contact because the service is not presented as a stability-guaranteed commercial API. VoidCat therefore keeps this source live-only, applies a conservative one-minute request floor, and fails this layer independently if the public access model changes.

## OpenSky Civil Airspace

**Default state and permission:** disabled. OpenSky's current Terms of Use state that operational REST API use in a live product or automated system requires written provider permission. Anonymous technical access is not treated as permission for automatic product use. A licensed operator may deliberately enable the registered layer.

| Field | Value |
|---|---|
| Registry ID | `opensky.civil-airspace` |
| Category | Aviation |
| Authentication | Tier 1 — anonymous, no credential |
| Endpoint | `https://opensky-network.org/api/states/all?extended=1` |
| Anonymous allowance | 400 credits per day |
| Global snapshot cost | 4 credits |
| Local board cadence | 2 minutes by default; user-selectable from 30 seconds to 12 hours |
| Provider network cadence | Credit-aware; approximately 16 minutes with 396 credits and a fresh 24-hour horizon |
| Safety reserve | 40 credits (10% of the documented anonymous allowance) |
| Maximum response | 12 MB and 20,000 state vectors; no more than 3,000 positioned contacts displayed |
| Cache | Live-only; cleared on disconnect and app exit |
| Attribution | Credit: OpenSky Network |
| Verified | 2026-07-27 |

Official reference:

- [OpenSky REST API documentation](https://openskynetwork.github.io/opensky-api/rest.html)
- [OpenSky Terms of Use](https://opensky-network.org/about/terms-of-use)

VoidCat reads OpenSky's `X-Rate-Limit-Remaining` response header after a successful load. It subtracts a 40-credit reserve, divides the usable balance by the documented four-credit cost of a global state request, and spreads the resulting request count across the remaining conservative credit horizon. The source panel shows the remaining credits, effective network cadence, estimated refill countdown, and next permitted network pull. Local two-minute source passes reuse the guarded snapshot and do not spend credits.

OpenSky documents a daily anonymous allowance but does not publish the precise reset boundary for successful anonymous responses. VoidCat therefore labels the refill time as an estimate and uses a rolling 24-hour horizon beginning with the first successful load of the app session. If OpenSky returns `X-Rate-Limit-Retry-After-Seconds` on HTTP 429, that exact provider value replaces the estimate and blocks requests until the stated time.

Only fresh, airborne, positioned aircraft state vectors are plotted. Grounded contacts, surface/obstacle categories, contacts older than 25 minutes, and contacts without coordinates are excluded. OpenSky observations are labelled civil-or-unclassified rather than being treated as authoritative civilian registration data. When the active adsb.lol military layer reports the same ICAO transponder address, VoidCat suppresses the duplicate blue OpenSky contact so one aircraft cannot appear in both military red and civilian blue.

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

## aisstream.io Maritime

| Field | Value |
|---|---|
| Registry ID | `aisstream.maritime` |
| Category | Maritime |
| Authentication | Tier 2 — user-supplied API key |
| Endpoint | `wss://stream.aisstream.io/v0/stream` |
| Coverage | One user-selected bounded region |
| Default map pull cadence | 2 minutes; user-selectable from 30 seconds to 12 hours |
| Local safety limits | 2,000 vessels, 30-minute TTL, 1,200 messages/minute, 512 KB/message |
| Retention | Volatile memory only; cleared on disconnect and shutdown |
| Attribution | Credit: aisstream.io |
| Verified | 2026-07-27 |

Official references:

- [aisstream.io WebSocket documentation](https://aisstream.io/documentation.html)
- [aisstream.io API keys](https://aisstream.io/customer.html)

The API key is encrypted through the operating system and is consumed only in Electron's main process. The renderer receives normalized vessel observations and never receives the credential. Changing the region clears the previous region's contacts before opening the new bounded subscription. Because AIS is a push stream, the user-facing pull-rate slider controls when accumulated positions are published to the map; it does not repeatedly reconnect the provider socket.

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
