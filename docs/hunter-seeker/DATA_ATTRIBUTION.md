# VC Hunter-Seeker data and map attribution

VC Hunter-Seeker is a clean-room, passive-OSINT implementation. It consumes only documented public APIs and public basemap services as an intended client.

## CelesTrak

- Layer: propagated space-station subpoints
- Provider: CelesTrak
- Endpoint: `https://celestrak.org/NORAD/elements/gp.php?GROUP=STATIONS&FORMAT=JSON`
- Documentation: [CelesTrak GP data formats](https://celestrak.org/NORAD/documentation/gp-data-formats.php)
- Usage rules: [CelesTrak usage policy](https://celestrak.org/usage-policy.php)
- Credit shown in the contact register and selected-contact panel: CelesTrak

VoidCat retrieves current OMM JSON general-perturbations elements at most once every two hours, then uses SGP4 locally to derive current display positions. The resulting coordinates are estimates and are labelled with their orbital-element age. Any non-200 response stops CelesTrak requests for the remainder of the app session.

## satellite.js

- Purpose: local SGP4/SDP4 propagation of CelesTrak OMM data
- Version: `7.0.1`, pinned
- License: MIT
- Project: [satellite.js](https://github.com/shashwatak/satellite-js)

## adsb.lol

- Layer: military-registered aircraft positions
- Provider: adsb.lol
- Endpoint: `https://api.adsb.lol/v2/mil`
- Documentation: [adsb.lol API](https://api.adsb.lol/docs)
- License: [Open Data Commons ODbL v1.0](https://opendatacommons.org/licenses/odbl/1-0/)
- Credit shown in the contact register and selected-contact panel: adsb.lol

The provider classifies the aircraft returned by this endpoint as military registered. VoidCat does not independently make or expand that classification. Records without provider-supplied recent coordinates are not plotted.

## OpenSky Network

This adapter is disabled by default. The provider's current Terms of Use require written permission for operational REST API use; the layer is available only for an operator who has independently obtained that permission and deliberately enables it.

- Layer: civilian-or-unclassified airborne aircraft positions
- Provider: OpenSky Network
- Endpoint: `https://opensky-network.org/api/states/all?extended=1`
- Documentation: [OpenSky REST API](https://openskynetwork.github.io/opensky-api/rest.html)
- Terms: [OpenSky Terms of Use](https://opensky-network.org/about/terms-of-use)
- Credit shown in the contact register and selected-contact panel: OpenSky Network

VoidCat anonymously consumes documented global state vectors and marks them civil-or-unclassified. It does not infer registration status from an OpenSky record. Contacts identified by the active adsb.lol military layer are removed from the blue layer by matching their ICAO transponder address. OpenSky's remaining-credit header drives a conservative network request guard; its refill time is shown as an estimate unless the provider supplies an exact retry-after value.

## U.S. Geological Survey

- Layer: earthquakes
- Provider: U.S. Geological Survey
- Endpoint: `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson`
- Documentation: [USGS GeoJSON Summary Format](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php)
- Credit shown in the selected-contact panel: U.S. Geological Survey

USGS-authored data and information are generally in the U.S. public domain. USGS requests acknowledgement as the source.

## NOAA / National Weather Service

- Layer: active weather watches, warnings, and advisories
- Provider: NOAA / National Weather Service
- Endpoint: `https://api.weather.gov/alerts/active`
- Documentation: [NWS Alerts Web Service](https://www.weather.gov/documentation/services-web-alerts)
- Credit shown in the selected-contact panel: NOAA / National Weather Service

The NWS API is open data, free to use, and explicitly supports alert redistribution and decision-support applications. VoidCat supplies the required identifying User-Agent and polls at half the maximum recommended frequency.

## aisstream.io

- Layer: live vessel positions
- Provider: aisstream.io
- Endpoint: `wss://stream.aisstream.io/v0/stream`
- Documentation: [aisstream.io WebSocket API](https://aisstream.io/documentation.html)
- Credit shown in the selected-contact panel: aisstream.io

VoidCat displays provider-broadcast AIS positions for the single region selected by the user. Vessel identity and motion fields are not independently verified. The source remains memory-only. Turning the layer off retains its latest snapshot through the selected display interval so it can be restored without reconnecting early; changing region, using the global disconnect action, or exiting the app clears the observations.

## DeFlock / OpenStreetMap ALPR camera registry

- Layer: known crowdsourced automatic license-plate-reader camera locations
- Project: [DeFlock](https://github.com/FoggedLens/deflock)
- Data query: DeFlock's public daily regional JSON index and operator-selected regional tile
- Exact record links: `https://www.openstreetmap.org/node/{id}`
- Data license and attribution: [OpenStreetMap copyright and ODbL terms](https://www.openstreetmap.org/copyright)
- Credit shown in the source matrix, contact register, and selected-contact panel: DeFlock / OpenStreetMap

DeFlock documents OpenStreetMap as its crowdsourced ALPR location source. VoidCat does not scrape the DeFlock website. It retrieves DeFlock's lightweight region index at most once per day and loads a regional camera tile only after the operator clicks its map hub. Every camera is labelled with its OSM element ID and provenance. Coverage is incomplete by nature; the absence of a mapped record does not establish the absence of a camera.

## YouTube Live public cameras

- Layer: operator-selected regional continuous public live-video broadcasts
- Provider: [YouTube Data API](https://developers.google.com/youtube/v3)
- Search documentation: [Search: list](https://developers.google.com/youtube/v3/docs/search/list)
- Video metadata: [Video resource](https://developers.google.com/youtube/v3/docs/videos)
- Player documentation: [YouTube embedded players](https://developers.google.com/youtube/player_parameters)
- Courtesy displayed inside the player: Powered by YouTube

VoidCat uses a user-provided Google Cloud API key stored only by Electron's protected credential process and transmits it in the `X-Goog-Api-Key` header rather than a URL. The map initially displays a local worldwide sector index; it contacts YouTube only after the operator clicks a sector hub. Each sector performs one bounded active-broadcast search within a 1,000 km radius, verifies up to 50 returned videos, and caches the result for 15 minutes. A result enters the layer only when its broadcast is currently live, has actually started, has not ended, is public and embeddable, and its metadata matches public-camera terms. Still-image refreshes, completed broadcasts, and non-embeddable videos are rejected. Exact uploader coordinates are used when available; otherwise the marker is explicitly identified as an approximate regional result. Selecting a marker opens YouTube's native continuous-video player, and closing it restores the map. Availability and content remain under the broadcaster's and YouTube's control.

## Windy Webcams

- Layer: operator-selected regional public webcams and provider players
- Provider: [Windy Webcams API](https://api.windy.com/webcams/)
- Documentation: [Webcams API v3](https://api.windy.com/webcams/docs)
- Terms: [Windy Webcams API terms](https://api.windy.com/webcams/terms)
- Courtesy displayed inside the player: Webcams provided by Windy.com

Windy remains an independent, separately switchable layer and uses its own protected API key and regional result cache. VoidCat contacts Windy only after the operator clicks an offset WINDY sector hub. Results are bounded to the provider's 1,000-record listing ceiling and cached for 15 minutes. The player mode is visibly labeled because a Windy result may be a continuous provider feed, periodically refreshed imagery, or a day/month/year timelapse. This layer is not presented as a guarantee of continuous video; use the separate YouTube Live Cameras layer when continuous active-broadcast verification is required.

## OpenFreeMap and OpenStreetMap

- Layer: interactive dark basemap
- Provider: OpenFreeMap
- Style: `https://tiles.openfreemap.org/styles/dark`
- Documentation: [OpenFreeMap Quick Start](https://openfreemap.org/quick_start/)
- Required attribution: OpenFreeMap © OpenMapTiles Data from OpenStreetMap

VoidCat disables MapLibre's default light attribution widget because it conflicts with the application theme. The map footer instead renders persistent, readable links using the provider wording: OpenFreeMap, © OpenMapTiles, and Data from OpenStreetMap. The credit remains visible whenever the map is visible. OpenFreeMap states that its public instance requires no registration, API key, or cookie and has no map-view or request limit.

## MapLibre GL JS

- Purpose: WebGL map renderer
- Version: `5.24.0`, pinned
- License: BSD-3-Clause
- Documentation: [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/)

MapLibre is loaded only when the Hunter-Seeker map view is rendered. It is removed with the view, and the Electron renderer uses a non-persistent in-memory session for map resources.

## OSINT4All directory

- Layer: external OSINT research-tool directory
- Source: [OSINT4All on Start.me](https://start.me/p/L1rEYQ/osint4all)
- Captured: 2026-07-28
- Scope: 387 displayed bookmark links across 14 source widgets

VoidCat preserves the displayed bookmark names, destinations, category grouping, and source-board attribution. Descriptions are written by VoidCat from the entry name, host, and category rather than copied from the source board. The directory is a reference snapshot, not a provider integration or endorsement. Links open externally and never run automatically.
