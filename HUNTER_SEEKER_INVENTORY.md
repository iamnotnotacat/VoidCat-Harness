# Hunter-Seeker definitive implementation inventory

Audit date: 2026-07-27. This file is the authoritative implemented/deferred inventory for the live system and its opt-in controlled-history scope.

## Implemented

- Six bounded source layers: USGS earthquakes, NOAA/NWS alerts, adsb.lol military aircraft, optional anonymous OpenSky civil/unclassified aircraft, CelesTrak space stations, and one operator-selected aisstream.io maritime region.
- Volatile observation normalization, per-source isolation, freshness states, zero-result degradation, cached toggle restoration, provider ceilings, operator-lowered request budgets, restart-persistent settings, and manual refresh that bypasses only the selected cadence.
- Custom OpenFreeMap attribution, category icons, responsive layouts, 10px typography floor, semantic design tokens, reduced motion, and error-boundary map recovery.
- First-run and Settings/Setup onboarding with resumable progress, persisted Skip behavior, credential-free explanation, AIS region setup, dynamic summary, protected credential fingerprint, provider validation, replace/retest/remove lifecycle, and removal confirmation.
- Shared P4 tool registry and P5 job manager, including discovery, closed schemas, rate limits, invocation accounting, programmatic and UI event-stream subscriptions, polling recovery, cooperative cancellation, and killable-worker hard cancellation.
- Six read-only UNIT tools with self-describing result envelopes and per-observation IDs, provenance, confidence, freshness, limitations, byte-bounded context, job status/cancellation, exact citation validation, explicit unsupported marking, exact function discovery, and a citation-safe evidence renderer for local UNITs that emit a generic textual tool wrapper.
- Memory-only operation by default, plus an explicit opt-in isolated historical observation store with entity/bbox/time queries, protected retention classes, budget-gated writes, manual progressive downsampling, and live/historical labels.
- Historical RAG over summaries and derived events only, natural-language “what changed?” queries, selected library cross-reference, and transactional source/vector deletion with orphan verification.
- Shared P2 storage-budget manager with three persisted budgets, separate DB/WAL/vector/blob/replay/imagery accounting, watermarks, time-to-full projection, dry-run planning, state subscriptions, typed scopes, validated export/backup, active-write and free-disk guards, bounded/cancelable synthetic operations, and consistency checks. Production eviction remains approval-locked.

## Deliberately deferred

- Automatic background eviction, replay playback, imagery persistence, automatic watchlist/trigger engines, and historical health baselines remain deferred. Generic production clear remains approval-gated.
- Additional providers, registered OpenSky accounts, cloud model lanes, rail, Smithsonian GVP, mesh networking, and broader orbital catalogs.
- Optical/radio satellite visibility. Current passes are bounded SGP4 subpoint estimates for the configured station catalog and state this limitation in every result.
- Persistent job and tool-invocation history; both remain bounded and volatile.

Anything not listed under Implemented is not to be represented in the interface as available.
