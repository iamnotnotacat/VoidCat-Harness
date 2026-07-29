# OSINT Gates 0-4 Deployment Audit

Audited: 2026-07-28 (America/Chicago)

## Decision

Gates 0 through 4 are implemented and deployed. The full regression passes, the desktop application opens, Hunter-Seeker remains functional, the isolated OSINT store is healthy, and the anonymous/local providers work through the running application. Four credentialed providers are deployment-ready but could not receive a successful live request because no protected credentials or SearXNG endpoint are configured. That external configuration state is shown explicitly in the UI and fails closed; it is not reported as a successful live-provider test.

## Verified baseline

| Check | Result |
| --- | --- |
| Full test suite | 182 passed, 0 failed, 0 skipped |
| TypeScript compilation | Passed |
| ESLint | Passed |
| Production build | Passed |
| Desktop launch | Authenticated local service healthy |
| Hunter-Seeker live check | DeFlock healthy; 167 bounded viewport observations |
| Local provider check | OpenSquat-style query; 22 normalized entities |
| Core database | `quick_check=ok`; 0 foreign-key violations |
| Hunter history database | `quick_check=ok`; 0 foreign-key violations |
| Isolated OSINT database | Schema v1; `quick_check=ok`; 0 foreign-key violations; 0 orphaned rows |
| UNIT check | 4.68 GB UNIT loaded at 4,096 context, streamed exact response, then ejected |
| Real-database destructive tests | None |

## Gate 0 - baseline and boundaries

| Requirement | Status | Evidence |
| --- | --- | --- |
| Record test/build baseline | Complete | Original 127-test baseline is preserved; current deployment baseline is 182/182. |
| Application opens and Hunter-Seeker functions | Complete | Real Electron launch succeeded; authenticated health endpoint and bounded live map pull succeeded. |
| Integration boundaries | Complete | Architecture document separates renderer, local backend, protected Electron broker, Hunter intake, shared jobs/tools, and isolated storage. |
| Isolated OSINT data location | Complete | `.voidcat/data/osint/osint.db` is live and independently budgeted. |
| Passive-only policy | Complete | Provider contracts and policy reject active behavior. |
| Prohibited behavior | Complete | Scanning, exploitation, credential guessing, recursive autonomous research, and unapproved exposure checks are documented and enforced. |
| Disposable migrations/stress | Complete | Migration, eviction, recovery, cancellation, and consistency tests use guarded temporary databases. |
| No UNIT in infrastructure tests | Complete | Offline infrastructure suite loads none; the separate runtime check used only a 4.68 GB UNIT. |

## Gate 1 - core contracts

All entity, identifier, observation, claim, relationship, evidence, lead, and investigation schemas compile and have runtime validation. Hunter intake covers aircraft, vessel, satellite, events, and areas while preserving observation provenance. Provider capability metadata, deterministic policy decisions, all six budget dimensions, deterministic planning, and centralized result normalization are tested. Static boundary tests confirm Gate 1 contains no network or persistence primitives.

## Gate 2 - mocked vertical slice

The deterministic fixture investigation accepts both domains and Hunter observations, reserves bounded resources, runs through the shared job manager, normalizes mock evidence, deduplicates entities, creates cited claims and relationships, calculates explained confidence, leaves leads as unexecuted candidates, and emits stable structured/Markdown reports. Queued and in-flight cancellation, contradictions, tiny budgets, and deterministic digests are covered.

## Gate 3 - persistence and evidence safety

The isolated schema is now version 2 and includes investigations, aliases, observations, claims/evidence, relationships, contradictions, identity links, structured conclusions, temporal changes, contradiction details, leads, provider cache, rate limits, invocations, and decisions. Raw responses are redacted and capped; every write is budget-guarded; cache provenance and age are explicit; deletion is typed, exported first, transactional, and consistency-checked. Cleanup cannot open core chat/memory/RAG or Hunter databases. Production eviction remains approval-locked. The deployed migration checkpointed the real WAL, created a validated backup, preserved provider cache/accounting, and completed with zero integrity, foreign-key, or orphan errors.

## Gate 4 - provider wave

| Provider | Fixture/offline | Deployed state | Live result |
| --- | --- | --- | --- |
| DeFlock | Passed | Configured, opt-in map layer | Passed: 167 bounded camera observations |
| OpenSquat-style local | Passed | Configured | Passed: 22 normalized entities; no network |
| SearXNG | Passed | Unconfigured | Not callable; fails closed with HTTP 409 before network |
| Shodan | Passed | Unconfigured | Not callable; fails closed before network |
| Censys | Passed | Unconfigured | Not callable; fails closed before network |
| Have I Been Pwned | Passed | Unconfigured | Not invoked without a key and explicit exact-target authorization |

The provider status screen exposes capability discovery, configuration state, cache state, request guards, rate limits, protected save/test/remove controls, normalized evidence, and isolated-store health. Credentials remain inside Electron's protected process. HIBP requires a fresh exact-target authorization statement, masks sensitive output, never expands discovered emails, and blocks Hunter forwarding pending separate approval.

## Operator follow-up

To turn the four externally configured rows into successful live checks, add the desired SearXNG endpoint and/or provider keys through **OSINT PROVIDERS**, then use **TEST LIVE** once per provider. For HIBP, also supply a target you are explicitly authorized to check. No code change is required.
