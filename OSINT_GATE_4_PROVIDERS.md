# OSINT Gate 4 — live provider wave

Gate 4 adds six passive providers behind one normalized provider boundary. Provider fixture tests never contact the internet. A live check occurs only after an operator deliberately stores configuration and presses **TEST LIVE**.

## Provider inventory

| Provider | Capability | Network boundary | Authentication | Cache |
| --- | --- | --- | --- | --- |
| DeFlock / OpenStreetMap | Known crowdsourced ALPR camera points in the visible Hunter-Seeker viewport | Hunter-Seeker adapter; fixed Overpass endpoint | None | 15 minutes, memory only |
| SearXNG | General passive web discovery | Electron loopback broker; configured HTTPS or loopback instance only | Protected endpoint configuration | 15-minute broker cache plus isolated normalized cache record |
| OpenSquat-style local similarity | Deterministic domain similarity candidates | Fully local | None | Not applicable |
| Shodan | Exact IP or domain lookup | Electron loopback broker; fixed official endpoints | Windows-protected API key | 1-hour broker cache plus isolated normalized cache record |
| Censys | Exact IP or domain lookup | Electron loopback broker; fixed official endpoints | Windows-protected personal access token | 1-hour broker cache plus isolated normalized cache record |
| Have I Been Pwned | Explicitly authorized exact email or verified-domain exposure check | Electron loopback broker; fixed official endpoints | Windows-protected API key | 5-minute redacted broker cache plus isolated normalized cache record |

Every provider publishes capability metadata, attribution, a request ceiling, cache policy, runtime health, last-request state, and normalized results. Provider outputs enter the shared OSINT contracts as evidence, entities, observations, relationships, warnings, coverage limitations, and candidate leads. Raw responses are not written to an investigation by this gate.

## DeFlock map layer

DeFlock documents OpenStreetMap as the location dataset behind its crowdsourced ALPR map. VoidCat therefore queries only OpenStreetMap nodes carrying the DeFlock ALPR tagging pattern. The layer is disabled by default and performs no request until it is enabled and the map is zoomed to level 6 or closer. Each request is restricted to the visible bounding box, a maximum viewport area, a 15-second query timeout, a 5 MB response limit, and provider/local rate guards.

Camera markers use a dedicated Evangelion-style infrastructure glyph. Selecting one displays the OSM element ID, manufacturer when tagged, facing direction, operator, freshness, confidence, coordinates, source attribution, and a link to the exact OpenStreetMap record. Coverage is explicitly described as crowdsourced: a missing marker is not evidence that an area has no ALPR camera.

## Credential and request boundary

Secrets are accepted by the renderer only long enough to invoke the Electron preload bridge. They are encrypted by Electron `safeStorage`, resolved only in the main process, and sent only in the provider-required header or, for Shodan, its required request parameter. The local backend never receives a secret. The UI, status payloads, invocation logs, displayed URLs, investigation results, and reports receive only a masked fingerprint or normalized provider data.

The broker binds to loopback on a random port and requires the per-launch desktop token. It is not an arbitrary proxy: each provider has fixed operations, target validation, response-size and timeout limits, redirect refusal, request throttling, and bounded volatile cache/log storage.

## HIBP additional controls

- The operator must select exposure-check mode and affirm authorization for the exact target on every query.
- The authorization statement must be present and is evaluated before any provider call.
- Only one exact email address or one previously verified domain is accepted.
- Results never cause automatic expansion from a discovered email address.
- Domain account identifiers and email addresses in returned evidence are masked before leaving Electron.
- Results produce no candidate leads and remain blocked from Hunter-Seeker until a separate future approval action exists.
- The credential test calls the official subscription-status endpoint and never places the key in a shown URL.

## Verification procedure

1. Run `npm test`. All adapter and broker fixture tests must pass without a live provider request.
2. Launch VoidCat and open **10 OSINT PROVIDERS**.
3. Confirm the six providers expose capability, cache, rate, and connection state.
4. For a configured provider, save the value, confirm only its fingerprint returns, and press **TEST LIVE** once.
5. For DeFlock, open Hunter-Seeker, enable the DeFlock source, zoom to a city, and confirm camera markers, source details, and exact OSM record links appear.
6. Disable and re-enable DeFlock inside its cadence; the most recent bounded snapshot should return without an extra request.
7. For HIBP, confirm the run button remains disabled without exact-target approval and an authorization statement; confirm returned email identifiers are masked and Hunter forwarding says blocked.
8. Remove a provider configuration and confirm its protected value and volatile cache are cleared.

Manual live checks are intentionally operator-triggered because protected credentials are never revealed to tests or development tooling.

## Guided provider setup

Each externally configured provider exposes a provider-specific connection guide in the OSINT Provider Matrix. The acquisition button opens only an official HTTPS destination in the operator's normal browser; VoidCat never embeds a provider login page or reads browser credentials.

- **Shodan:** opens the official account page where the account API key is available.
- **Censys:** opens Censys Platform and links to the official Personal Access Token instructions.
- **HIBP:** opens the official API-key/dashboard flow and retains the separate exact-target authorization gate.
- **SearXNG:** links to official installation guidance and the official instance directory because SearXNG uses an instance base URL rather than an issued API key.

The guide then directs the operator back to **SAVE PROTECTED VALUE** and **TEST LIVE**. The saved value remains inside Electron's Windows-protected credential process and is never returned to the renderer.

## 2026-07-28 deployment audit

- DeFlock completed a real bounded Austin viewport request and returned 167 normalized camera observations. Health was `healthy`, error rate was zero, and the source was restored to disabled afterward.
- OpenSquat-style local similarity completed through the deployed API, produced 22 deduplicated entities, and persisted only its normalized cache/accounting records in the isolated OSINT store.
- SearXNG, Shodan, Censys, and HIBP were correctly reported as unconfigured because no protected configuration was present. SearXNG, Shodan, and Censys were verified to fail closed before network access with HTTP 409. HIBP was not invoked because no credential and no explicitly authorized exposure target were supplied.
- The provider panel exposes all six capability/rate/cache states. After Gate 5 deployment, the isolated store reports schema v2, `quick_check=ok`, zero foreign-key violations, and zero orphaned rows.
