# Hunter-Seeker definitive implementation inventory

Audit date: 2026-07-27. This file is the authoritative implemented/deferred inventory for the approved live-only scope.

## Implemented

- Six bounded source layers: USGS earthquakes, NOAA/NWS alerts, adsb.lol military aircraft, optional anonymous OpenSky civil/unclassified aircraft, CelesTrak space stations, and one operator-selected aisstream.io maritime region.
- Volatile observation normalization, per-source isolation, freshness states, zero-result degradation, cached toggle restoration, provider ceilings, operator-lowered request budgets, restart-persistent settings, and manual refresh that bypasses only the selected cadence.
- Custom OpenFreeMap attribution, category icons, responsive layouts, 10px typography floor, semantic design tokens, reduced motion, and error-boundary map recovery.
- First-run and Settings/Setup onboarding with resumable progress, persisted Skip behavior, credential-free explanation, AIS region setup, dynamic summary, protected credential fingerprint, provider validation, replace/retest/remove lifecycle, and removal confirmation.
- Shared P4 tool registry and P5 job manager, including discovery, closed schemas, rate limits, invocation accounting, programmatic and UI event-stream subscriptions, polling recovery, cooperative cancellation, and killable-worker hard cancellation.
- Six read-only UNIT tools with self-describing result envelopes and per-observation IDs, provenance, confidence, freshness, limitations, byte-bounded context, job status/cancellation, exact citation validation, explicit unsupported marking, exact function discovery, and a citation-safe evidence renderer for local UNITs that emit a generic textual tool wrapper.
- Memory-only Hunter-Seeker operation. No observation history is implied or persisted.

## Deliberately deferred

- Persistent Hunter-Seeker observation history, replay, historical RAG, watchlists, triggers, and health baselines until the P2 storage-budget manager is separately built and approved.
- Additional providers, registered OpenSky accounts, cloud model lanes, rail, Smithsonian GVP, mesh networking, and broader orbital catalogs.
- Optical/radio satellite visibility. Current passes are bounded SGP4 subpoint estimates for the configured station catalog and state this limitation in every result.
- Persistent job and tool-invocation history; both remain bounded and volatile.

Anything not listed under Implemented is not to be represented in the interface as available.
