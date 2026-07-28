# VC Hunter-Seeker integration readiness

Audit snapshot: 2026-07-28. This is the formal Phase 0 readiness record for the current TypeScript/Electron implementation.

## Architecture adaptation

The original prompt described a Python FastAPI module. VoidCat Harness is actually an Electron application with a React/TypeScript renderer, Electron main-process services, and local Vite middleware. Hunter-Seeker follows the existing application architecture instead of adding a parallel Python backend. The display name remains VC Hunter-Seeker; implementation code lives under `build/hunter-seeker`, `app/HunterSeeker*`, and `desktop/aisstream-maritime-service.cjs`.

## Readiness table

| Primitive or core | Status | Location | Interface summary | Gap | First consuming phase |
|---|---|---|---|---|---|
| Model loading and routing | Partial relative to the original prompt; complete for current local-only scope | `build/voidcat-local-plugin.ts`, `app/VoidCatConsole.tsx` | Discovers LM Studio GGUF UNITs, exposes vision/tool/context metadata, loads one local chat UNIT, streams ordinary chat, and gives tool-capable UNITs an operator-controlled bounded Hunter-Seeker lane that trims evidence/history to the selected context window | No cloud lanes | Phase 4 |
| RAG layer | Exists | `build/voidcat-database.ts`, `build/voidcat-vector-index.ts`, `build/hunter-seeker/hunter-history-store.ts`, `app/RagPanel.tsx` | Document RAG plus isolated historical summary/derived-event indexing, natural-language history search, selected-library cross-reference, and transactional deletion with orphan checks | Raw live positions are intentionally never embedded | Phase 5 |
| Persistent memory | Exists | `build/voidcat-database.ts`, `app/PhaseThreePanels.tsx` | SQLite memory records, embeddings, relevance/importance retrieval, explicit remember/forget, approval-based suggestions | Hunter targeting is deliberately isolated from chat memory | Phase 5 |
| Design tokens (P1) | Approved and enforced | `app/design-tokens.css`, `DESIGN_TOKENS.md` | Semantic color, typography, layout, motion, elevation, map, and intelligence roles with literal-color, typography-floor, and responsive-layout enforcement tests | None in current scope | Phase 2 frontend |
| Storage budget manager (P2) | Implemented; approval-gated | `build/voidcat-storage-budget-manager.ts`, `STORAGE_BUDGET_MANAGER.md`, `STORAGE_BUDGET_SYNTHETIC_REPORT.md` | Three persisted budgets, ownership-safe component accounting, watermarks, projection, dry runs, subscriptions, typed scopes, export/backup validation, activity/free-space guards, and disposable migration/eviction tests | Production eviction intentionally disabled pending owner review | Before Phase 5 persistent observation writes |
| Secret storage (P3) | Exists | `desktop/secure-credential-store.cjs`, `SECURE_CREDENTIAL_STORAGE.md` | Electron safeStorage set/get/delete/list/test, namespaced credentials, renderer cannot reveal values, fail-closed behavior | General credential-management UI is incomplete | Phase 3 |
| Tool/MCP registry (P4) | Exists; owner approved and consumed | `build/voidcat-tool-registry.ts`, `build/hunter-seeker/hunter-seeker-tools.ts`, `TOOL_REGISTRY.md` | Closed declarative schemas, exactly six passive live-query tools, protected AIS snapshot bridge, per-tool limits, cancellation, result validation, coverage limitations, exact observation citations, and bounded redacted cost records | No persistent/history tools | Phase 4 |
| Job manager (P5) | Exists; owner approved and consumed | `build/voidcat-job-manager.ts`, `app/HunterSeekerPanel.tsx`, `JOB_MANAGER.md` | Bounded queue/concurrency, visible status/progress/cancellation, wall-clock/iteration/external-call caps, resource accounting, throttled updates, and cleanup-slot containment | Persistent job history is deliberately absent | Phase 4 |

## Persistent-write declaration

Hunter-Seeker observations and provider payloads remain bounded and volatile by default. Basemap resources use an Electron in-memory session. Operators may explicitly enable the isolated historical store or record a bounded replay window; both paths are guarded by the P2 storage budget manager and never write into chat memory.

Small configuration records such as setup progress, enabled state, and selected cadence reuse VoidCat's existing settings interface. Stage 5 watchlist, trigger-state, trigger-event, and health-history records live in the isolated Hunter database. Replay JSONL and manifests live in the separately measured Hunter replay directory.

## Current shared SQLite footprint

The read-only inspection performed for this audit found approximately 58.5 MiB across `voidcat.db`, its WAL, and shared-memory file. The database contains only a small amount of live row data; most allocated database pages are on SQLite's freelist, and the WAL accounts for roughly half the footprint. `PRAGMA auto_vacuum` is currently disabled. No reclamation or migration was performed during the audit.

This confirms that P2 must include a safe existing-database migration plan, free-space checks, backup/validation, WAL handling, and synthetic testing before any real cleanup is enabled.

## Approved current source scope

Provider expansion is frozen while the project finishes its infrastructure. The active scope is:

- USGS earthquakes
- NOAA/NWS alerts
- adsb.lol military aircraft
- OpenSky civil or unclassified aircraft
- CelesTrak space stations
- aisstream.io maritime vessels

Smithsonian GVP and rail systems were explicitly removed by the owner. Meshtastic is excluded because it conflicts with the prompt's NEVER BUILD mesh-networking boundary. Other providers remain deferred, not partially implemented.

## Primitive and phase gates

1. P1 design-token contract: approved by the owner's completion directive and enforced by automated checks.
2. Live-board freshness and integration tests: implemented. Sources and observations now expose live/cached/stale/degraded/acquiring/offline states, planned pull times, cached-snapshot continuity, and repeated-zero-result degradation.
3. Phase 3 active-source onboarding and settings: implemented. Setup progress, a persisted Skip choice, plus pull-source enabled state, cadence, and operator-lowered request budget persist in SQLite; maritime enabled state, region, cadence, and credential fingerprint persist in protected Electron storage. Candidate and saved AIS keys are provider-tested before acceptance or retest, and removal requires confirmation. Settings/Setup restarts the reusable guide from its first step.
4. P4 tool registry: implemented, documented, tested, and owner approved.
5. P5 job manager: implemented, documented, tested, and owner approved.
6. Live Hunter-Seeker tools, authenticated protected-process AIS bridge, local endpoints, byte-bounded managed UNIT loop, per-sentence unsupported marking, server-sent job-status subscription with polling recovery, cooperative cancellation, and killable-worker hard cancellation are implemented. The six tools are aircraft in bounds, aircraft by callsign/ICAO, vessels in bounds, bounded-source satellite passes over an area, recent seismic events, and feed health. Every result envelope remains self-describing with IDs, provenance, confidence, freshness, and coverage limitations even when its observation list is empty.
7. P2 storage budget manager: implemented and synthetically validated. Its dry-run/pressure report is presented in `STORAGE_BUDGET_SYNTHETIC_REPORT.md`; production eviction remains locked at the owner-review gate.
8. Historical observations, historical RAG, watchlists, triggers, health baselines, and replay are implemented in bounded, opt-in increments. Position history and replay remain operator-controlled; trigger metadata is isolated from chat memory.
9. Stage 5 adds persistent target management, protected/deduplicated triggers, health-history display and AI exclusion, plus checksummed offline replay. Its synthetic tests use disposable databases and replay directories only.
10. Finish route security, recovery testing, attribution review, and release documentation before distribution.

## Deferred useful subsets

- Generic P2 production clear remains approval-gated. Opt-in history uses only protected, backup-first, manually requested progressive downsampling; it cannot select chat memory.
- Historical RAG is active only after opt-in and indexes summaries/derived events, never every position. Coverage begins when recording is enabled, so absence is never presented as proof.
- Additional live providers and broader orbital catalogs remain deferred under the owner's source freeze. The pass tool reports the coverage limitations of the configured CelesTrak station catalog rather than implying global catalog completeness.

## Test baseline record

- Entry baseline requested by the Phase 2 closeout: 40 passing automated tests.
- Current Stage 5 audit baseline: 127 passing automated tests on 2026-07-28; the suite must never contain fewer than the 40-test entry baseline.
- Required gates: lint, all unit/integration tests, production renderer build, TypeScript no-emit validation, Electron script syntax checks, and the packaged-interface smoke test.

The definitive implemented/deferred inventory is maintained in `HUNTER_SEEKER_INVENTORY.md`.
