# VC Hunter-Seeker integration readiness

Audit snapshot: 2026-07-27. This is the formal Phase 0 readiness record for the current TypeScript/Electron implementation.

## Architecture adaptation

The original prompt described a Python FastAPI module. VoidCat Harness is actually an Electron application with a React/TypeScript renderer, Electron main-process services, and local Vite middleware. Hunter-Seeker follows the existing application architecture instead of adding a parallel Python backend. The display name remains VC Hunter-Seeker; implementation code lives under `build/hunter-seeker`, `app/HunterSeeker*`, and `desktop/aisstream-maritime-service.cjs`.

## Readiness table

| Primitive or core | Status | Location | Interface summary | Gap | First consuming phase |
|---|---|---|---|---|---|
| Model loading and routing | Partial relative to the original prompt; complete for current local-only scope | `build/voidcat-local-plugin.ts`, `app/VoidCatConsole.tsx` | Discovers LM Studio GGUF UNITs, exposes vision/tool/context metadata, loads one local chat UNIT, streams ordinary chat, and gives tool-capable UNITs an operator-controlled bounded Hunter-Seeker lane that trims evidence/history to the selected context window | No cloud lanes | Phase 4 |
| RAG layer | Exists | `build/voidcat-database.ts`, `build/voidcat-vector-index.ts`, `app/RagPanel.tsx` | PDF/DOCX/TXT/Markdown ingestion, registered folders, chunk embeddings, SQLite SimHash/LSH candidate lookup, cosine reranking, local citations, and cascade deletion of vector rows through foreign keys | No Hunter-Seeker history namespace or summary indexing | Phase 5 |
| Persistent memory | Exists | `build/voidcat-database.ts`, `app/PhaseThreePanels.tsx` | SQLite memory records, embeddings, relevance/importance retrieval, explicit remember/forget, approval-based suggestions | No Hunter-Seeker watchlist schema | Phase 5 |
| Design tokens (P1) | Implemented candidate; approval pending | `app/design-tokens.css`, `DESIGN_TOKENS.md` | Semantic color, typography, layout, motion, elevation, map, and intelligence roles with enforcement tests | Owner approval gate remains | Phase 2 frontend |
| Storage budget manager (P2) | Missing | — | — | All three budgets, accounting, watermarks, cleanup, export, projection, incremental reclamation, and UI | Before Phase 5 persistent observation writes |
| Secret storage (P3) | Exists | `desktop/secure-credential-store.cjs`, `SECURE_CREDENTIAL_STORAGE.md` | Electron safeStorage set/get/delete/list/test, namespaced credentials, renderer cannot reveal values, fail-closed behavior | General credential-management UI is incomplete | Phase 3 |
| Tool/MCP registry (P4) | Exists; owner approved and consumed | `build/voidcat-tool-registry.ts`, `build/hunter-seeker/hunter-seeker-tools.ts`, `TOOL_REGISTRY.md` | Closed declarative schemas, exactly six passive live-query tools, protected AIS snapshot bridge, per-tool limits, cancellation, result validation, coverage limitations, exact observation citations, and bounded redacted cost records | No persistent/history tools | Phase 4 |
| Job manager (P5) | Exists; owner approved and consumed | `build/voidcat-job-manager.ts`, `app/HunterSeekerPanel.tsx`, `JOB_MANAGER.md` | Bounded queue/concurrency, visible status/progress/cancellation, wall-clock/iteration/external-call caps, resource accounting, throttled updates, and cleanup-slot containment | Persistent job history is deliberately absent | Phase 4 |

## Persistent-write declaration

Hunter-Seeker observations and provider payloads are currently held only in bounded volatile memory. Basemap resources use an Electron in-memory session. The first Hunter-Seeker observation persistence is therefore Phase 5, so the P2 storage budget manager is gated immediately before the historical observation store rather than before the current live map.

Small configuration records such as setup progress, enabled state, and selected cadence may reuse VoidCat's existing settings interface during Phase 3. They are not observation telemetry, imagery, replay data, or vector content and do not bypass the Phase 5 storage gate.

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

1. P1 design-token candidate: implemented now; stop for owner approval.
2. Live-board freshness and integration tests: implemented. Sources and observations now expose live/cached/stale/degraded/acquiring/offline states, planned pull times, cached-snapshot continuity, and repeated-zero-result degradation.
3. Phase 3 active-source onboarding and settings: implemented. The reusable first-run/setup guide persists progress in existing VoidCat settings, explains zero-setup sources first, manages the current aisstream credential through the approved protected store, exposes the source matrix controls, and honestly marks storage-budget controls unavailable until P2 exists. Additional Tier 2 providers remain deferred under the owner's source freeze.
4. P4 tool registry: implemented, documented, tested, and owner approved.
5. P5 job manager: implemented, documented, tested, and owner approved.
6. Live Hunter-Seeker tools, authenticated protected-process AIS bridge, local endpoints, context-bounded managed UNIT loop, citation-integrity checks, unsupported-finding rejection, job monitor, and cancellation: implemented. The six tools are aircraft in bounds, aircraft by callsign/ICAO, vessels in bounds, satellite passes over an area, recent seismic events, and feed health.
7. Build P2 storage budget manager alone; run synthetic dry-run and pressure tests, present, and stop. This remains the next hard gate.
8. After P2 approval, build historical observations, historical RAG, watchlists, triggers, health baselines, and replay in bounded increments.
9. Finish route security, stress testing, recovery testing, attribution review, and release documentation.

## Deferred useful subsets

- P2 missing: the live map remains useful and safe because it is memory-only. Historical storage stays disabled.
- Historical RAG missing: existing document RAG remains independent and functional; live observations are not inserted into it.
