# OSINT Investigation Gate 0 Baseline

Recorded: 2026-07-28 (America/Chicago)

Gate 0 records the state that the OSINT Investigation subsystem must preserve. It does not enable providers, create an OSINT database, migrate user data, or load a UNIT.

## Repository baseline

| Item | Recorded state |
| --- | --- |
| Branch | `main` |
| Commit | `7362034ddcec68c0c0179b783d067852fd67cdf0` |
| Node.js | `v24.18.0` |
| npm | `11.16.0` |
| Test count | 127 |
| Unit tests | 127 passed, 0 failed, 0 skipped |
| Lint | Passed |
| Production build | Passed |
| Electron entry syntax | `main.cjs`, `preload.cjs`, credential store, and maritime service passed |
| UNIT loaded for verification | None |

The worktree was already intentionally modified before Gate 0. It contained ongoing Hunter-Seeker Stage 5 work across 19 tracked files plus four untracked Stage 5 files. Gate 0 treats those changes as the baseline and does not revert, replace, or claim ownership of them.

## Verification performed

The following non-provider verification completed successfully:

```powershell
npm test
node --check desktop/main.cjs
node --check desktop/preload.cjs
node --check desktop/secure-credential-store.cjs
node --check desktop/aisstream-maritime-service.cjs
```

`npm test` ran lint, the 127-test suite, and the production Vite build. Existing tests cover Hunter-Seeker source normalization, toggles and cached restoration, provider cadence, freshness, history, historical RAG, watchlists, triggers, health, replay, shared tools, managed jobs, storage budgets, credentials, web safety, RAG vectors, frontend contracts, and typography.

The build reports one existing warning: the lazily loaded Hunter-Seeker map JavaScript chunk is larger than 500 kB after minification. This is performance debt, not a functional or Gate 0 failure. The OSINT interface must remain separately lazy-loadable and must not increase the initial application bundle.

## Runtime safety statement

- Gate 0 did not invoke LM Studio, start its server, load an embedding UNIT, or load a chat UNIT.
- No provider network request was made.
- No database migration, cleanup, eviction, stress test, or synthetic write targeted `.voidcat/data`.
- Database tests used temporary directories such as `voidcat-storage-test-*`, `voidcat-history-test-*`, and `voidcat-stage-five-test-*` under the operating-system temporary directory.
- The real `.voidcat` directory remains ignored by Git.

An automated Electron GUI launch was deliberately not used as a Gate 0 test because the production desktop entry opens the operator's real local data and services. Application assembly was verified through the production build and Electron syntax checks; interactive behavior remains covered by the existing Hunter-Seeker smoke checklist and operator use.

## Gate 0 deliverables

| Deliverable | Status | Location |
| --- | --- | --- |
| Current regression baseline | Complete | This document |
| Architecture and integration assessment | Complete | `OSINT_ARCHITECTURE_ASSESSMENT.md` |
| Passive-only and authorization policy | Complete | `OSINT_PASSIVE_ONLY_POLICY.md` |
| Disposable-data testing rules | Complete | `OSINT_TEST_SAFETY.md` |
| Isolated OSINT storage contract | Defined; creation deferred to the persistence gate | `OSINT_ARCHITECTURE_ASSESSMENT.md` |
| Live provider access | Disabled by design | Gate 4 |
| OSINT database or migrations | Not started by design | Gate 3 |

## Gate 1 entry conditions

Gate 1 may define schemas and interfaces, but it must remain network-free and persistence-free. Before any later live-provider work:

1. A protected main-process provider broker must be implemented and tested so credentials never enter renderer, logs, reports, URLs, or local API payloads.
2. `osint-investigations` must receive an independent storage budget and typed cleanup scopes. It must not be charged to or cleaned through `hunter-observations`.
3. Candidate leads must remain proposals. Hunter-Seeker has no general-purpose autonomous lead-ingestion contract today.
4. Exposure checks must require explicit authorization and exact scope.
5. Model integration tests, when reached, may use only local UNITs smaller than 7 GB.

