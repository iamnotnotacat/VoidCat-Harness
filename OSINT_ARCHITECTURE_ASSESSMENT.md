# OSINT Investigation Architecture Assessment

## Executive decision

OSINT Investigation will be a sibling intelligence subsystem that consumes Hunter-Seeker evidence; it will not be added to Hunter-Seeker's source registry and will not modify live-source normalization. Hunter-Seeker answers “what is being observed now?” OSINT Investigation answers “what passive evidence relates to this selected entity or event?”

The subsystem will use deterministic orchestration around providers. The active VoidCat UNIT may request high-level investigation tools and summarize results, but it will not select arbitrary endpoints, obtain provider secrets, bypass policy, recursively investigate discoveries, or write directly to the graph.

## Existing models and interfaces

Hunter-Seeker currently emits bounded `HunterSeekerPublicObservation` records derived from `NormalizedObservation`. Each record provides:

- Stable observation and entity identifiers
- Entity type and geographic position
- Observation time
- Source feed provenance, fetch/receive time, upstream time, and staleness
- Confidence, evidence basis, retention class, and normalized attributes

The present interface is intentionally geospatial and position-oriented. It models aircraft, vessels, satellites, seismic events, and weather/event geometry well. It does not yet represent domains, IP addresses, email addresses, usernames, organizations, certificates, autonomous systems, or general evidence relationships.

Hunter-Seeker Stage 5 provides watchlists, geofences, protected trigger evidence, health history, and bounded replay. Those are operational monitoring concepts, not a general investigation graph or lead queue.

## Hunter-Seeker integration

A new `HunterSeekerIntakeAdapter` will map a selected public observation into an OSINT seed and preserve the exact original observation ID and provenance. It will be invoked only by an operator action or an approved high-level tool.

The initial mappings are:

| Hunter-Seeker entity | OSINT seed |
| --- | --- |
| Civil or military aircraft | Aircraft entity with ICAO, callsign, registration, position, and observation citation |
| Maritime vessel | Vessel entity with MMSI, name, position, and observation citation |
| Satellite or station | Satellite entity with NORAD identifier, position, and observation citation |
| Seismic or weather event | Event entity with source identifier, time, region, and observation citation |
| Map region | Geographic-area seed with explicit bounds and operator-selected objective |

OSINT candidate leads will be returned through a new outbox-style interface. A lead remains `candidate`, `approved`, `submitted`, `rejected`, or `expired`. Submission does not silently create a watchlist, trigger, provider request, or recursive investigation.

## Existing infrastructure to reuse

| Existing component | OSINT use |
| --- | --- |
| Shared tool registry | High-level, model-lane-independent investigation tools with closed JSON schemas, rate limits, logging, and bounded output |
| Shared job manager | Wall-clock, iteration, external-call and cancellation limits; progress and UI subscriptions |
| Storage budget manager | Pre-write guard, projection, dry-run, export, state subscriptions, and guarded cleanup patterns |
| Protected Electron credential store | Encryption and masked credential lifecycle; secrets remain in the main process |
| Safe web module | Public-URL validation, DNS pinning, redirect validation, byte limits, content cleaning, and prompt-injection removal |
| Hunter-Seeker public snapshot | Live seed evidence without raw provider payloads |
| React design tokens and notifications | Consistent OSINT screen, errors, warnings, progress, and accessibility floor |
| SQLite | Transactional graph, evidence, cache, investigation, and lead metadata |

## New modules required

- OSINT schemas for entities, identifiers, evidence, observations, claims, relationships, contradictions, leads, and investigations
- Provider descriptor, capability, adapter, normalization, health, cache, and rate-limit interfaces
- Deterministic policy engine and investigation planner
- Central provider router with global and per-provider request accounting
- Evidence store and independently scoped storage budget
- Entity graph, correlation engine, temporal reasoning, and confidence explanations
- Bounded candidate discovery with deduplication and cycle detection
- Hunter-Seeker intake and candidate-lead outbox adapters
- Shared-registry high-level tools and managed-job runtime
- OSINT Investigation interface, reports, evidence inspection, cancellation, and provider status
- Mock providers and fixture-based end-to-end tests

## Storage boundary

The planned runtime layout is isolated beneath the ignored local data root:

```text
.voidcat/data/osint/
  osint.db
  osint.db-wal
  osint.db-shm
  evidence/
  exports/
```

The directory and database are not created during Gate 0. Creation begins only in the persistence gate after disposable migrations pass.

The storage manager currently has three budgets: `hunter-observations`, `chat-memory`, and `imagery-cache`. OSINT must add `osint-investigations` with its own measurement and typed scopes. Reusing `hunter-observations` would make cleanup ownership ambiguous and is prohibited. OSINT cleanup must never select conversations, memories, RAG sources/vectors, Hunter observations/history, replay, or imagery.

## Credential and process boundary

The renderer can currently ask Electron's protected main process to set, delete, list, describe, and test credentials. The Vite local service, where shared jobs and tools execute, cannot directly read that protected store. Passing paid-provider secrets to the renderer or saving them in the shared SQLite settings would violate the current security boundary.

Before live credentialed providers are enabled, Electron will expose a narrow loopback provider broker:

- Bound only to `127.0.0.1`
- Authenticated with the existing per-launch desktop token
- Fixed provider identifiers and endpoint templates; no arbitrary URL proxying
- Credentials resolved only inside the Electron main process
- Strict request and response byte, redirect, timeout, and rate limits
- Logs contain provider, operation, result class, duration, cache status, and cost—but never query secrets or raw authorization headers
- Broker shuts down with the app

Mock and anonymous providers do not require this broker, but they still use the same adapter result contract.

## Trust boundaries

Provider responses and webpages are untrusted evidence. They cannot supply instructions, policies, tools, URLs to follow automatically, or model prompts. Normalizers accept only bounded expected fields. Raw evidence is retained only when policy allows it and is capped, labeled, and redacted.

The UNIT is also outside the enforcement boundary. It may propose an investigation objective and consume cited results. Deterministic application code enforces scope, authorization, provider availability, budgets, caching, rate limits, expansion depth, and write permissions.

## Known technical debt and conflicts

1. Hunter-Seeker's observation model requires a position. General OSINT entities need a separate schema rather than weakening that proven contract.
2. No generic Hunter-Seeker candidate-lead inbox exists. A reviewed outbox bridge must be added instead of overloading watchlists.
3. Protected credentials and backend tool execution are in separate processes. The provider broker is a prerequisite for Shodan, Censys, HIBP, ZoomEye, or FOFA.
4. The map chunk already exceeds the build warning threshold. The OSINT screen and graph must be lazy-loaded separately.
5. Current web search settings include provider-key handling that predates the protected credential architecture. OSINT will not copy that pattern.
6. Correlation and confidence are new primitives. They must stay explainable and deterministic; no model-generated confidence scores will be accepted.
7. Historical OSINT storage requires a new budget and retention contract. It cannot be enabled implicitly merely because Hunter history is enabled.

## Initial implementation sequence

Gate 1 defines closed schemas and adapters without network or persistence. Gate 2 proves a complete deterministic investigation using mock providers. Gate 3 adds isolated, budgeted persistence on disposable databases. Only Gate 4 introduces one live provider at a time.

