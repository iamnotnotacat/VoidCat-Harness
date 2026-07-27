# VC Hunter-Seeker data and map attribution

VC Hunter-Seeker is a clean-room, passive-OSINT implementation. It consumes only documented public APIs and public basemap services as an intended client.

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

## OpenFreeMap and OpenStreetMap

- Layer: interactive dark basemap
- Provider: OpenFreeMap
- Style: `https://tiles.openfreemap.org/styles/dark`
- Documentation: [OpenFreeMap Quick Start](https://openfreemap.org/quick_start/)
- Required attribution: OpenFreeMap © OpenMapTiles Data from OpenStreetMap

MapLibre renders the provider-supplied attribution control directly on the map. VoidCat does not hide, replace, or cover it. OpenFreeMap states that its public instance requires no registration, API key, or cookie and has no map-view or request limit.

## MapLibre GL JS

- Purpose: WebGL map renderer
- Version: `5.24.0`, pinned
- License: BSD-3-Clause
- Documentation: [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/)

MapLibre is loaded only when the Hunter-Seeker map view is rendered. It is removed with the view, and the Electron renderer uses a non-persistent in-memory session for map resources.
