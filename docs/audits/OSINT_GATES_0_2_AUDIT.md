# OSINT Investigation Gates 0–2 Formal Audit

Audited: 2026-07-28 (America/Chicago)

## Decision

**Gates 0, 1, and 2 are complete and ready to serve as the foundation for the next gated stage.** No incomplete or malfunctioning item remains within their defined scope.

The audit was adversarial: it reviewed the implementation against every stated requirement, added structural readiness checks, challenged invalid and boundary inputs, tested queued and in-flight cancellation, introduced contradictory evidence, locked a deterministic report digest, ran the full regression, and repaired every discovered gap before this decision.

## Current verification baseline

| Check | Result |
| --- | --- |
| Full unit/integration suite | 182 passed, 0 failed, 0 skipped |
| Gate 0–2 focused audit | 19 passed, 0 failed |
| TypeScript `noEmit` compilation | Passed |
| ESLint | Passed |
| Production Vite build | Passed |
| Git whitespace/error check | Passed |
| Gate 1–2 network/persistence primitive scan | Passed |
| Live OSINT provider requests | None during Gates 0-2; later Gate 4 deployment audit verified DeFlock live and OpenSquat locally |
| OSINT database writes or migrations | None during Gates 0-2; Gate 3 now deploys the isolated store |
| UNIT or LM Studio runtime used | None during Gates 0-2; later deployment audit used and ejected one 4.68 GB UNIT |

The production build retains the pre-existing warning that the lazy Hunter-Seeker map chunk exceeds 500 kB. This does not affect Gates 0–2 and the new OSINT modules are not part of the renderer bundle.

## Gate 0 — Baseline and boundaries

| Requirement | Status | Verification |
| --- | --- | --- |
| Record the current pre-OSINT baseline | Complete | `OSINT_GATE_0_BASELINE.md` records commit, environment, dirty-worktree context, and the original 127/127 baseline. The current full deployment regression is 182/182. |
| Verify existing application assembly | Complete | Production build, Electron syntax checks, launcher-chain test, authenticated health-route test, ready-to-show gate, and clean-shutdown wiring all pass. |
| Preserve existing Hunter-Seeker behavior | Complete | The full Hunter-Seeker adapter, registry, frontend, tool, history, Stage 5, and integration suites pass. |
| Document integration boundaries | Complete | `OSINT_ARCHITECTURE_ASSESSMENT.md` separates OSINT orchestration from Hunter live-source normalization and identifies reusable versus new primitives. |
| Establish isolated OSINT data location | Complete as a contract | `.voidcat/data/osint/` and its ownership are defined. Physical creation remains prohibited until the persistence gate, which is the required safe behavior. |
| Define passive-only behavior | Complete | Allowed passive collection and evidence operations are explicit and test-anchored. |
| Define prohibited behavior | Complete | Scanning, exploitation, credential testing, brute force, circumvention, covert monitoring, recursive research, and automatic Hunter actions are prohibited. |
| Define sensitive/exposure authorization | Complete | Exact target, explicit authorization, restricted handling, and no authorization inheritance are defined. |
| Protect real data during tests | Complete | Disposable-prefix, resolved-path, symlink/junction, production-mode, backup, validation, and no-real-`.voidcat` requirements are documented and structurally checked. |
| Restrict model testing | Complete | Core stages require no model; later model tests are explicitly limited to UNITs under 7 GB. |

The desktop GUI was not force-launched by the automated audit because doing so opens the operator's real local services and data. Instead, the audit verifies the complete launch chain and production assembly without creating that side effect. This is a safety-preserving verification choice, not an implementation gap.

## Gate 1 — Core contracts

| Requirement | Status | Verification |
| --- | --- | --- |
| Entity schema | Complete | Versioned closed schema plus runtime validation, typed identifiers, JSON-only attributes, and timestamp consistency. |
| Identifier schema | Complete | Typed normalization, stable IDs, confidence, temporal range, and evidence references. |
| Observation schema | Complete | Entity/provider/evidence linkage, temporal fields, confidence/category consistency, directness, freshness, and limitations. |
| Claim schema | Complete | Subject/predicate/value, support state, evidence and observation citations, temporal validity, confidence, and explanation. |
| Relationship schema | Complete | Directed/undirected graph edge, evidence, temporal fields, confidence consistency, and status. |
| Evidence schema | Complete | Provider/source attribution, retrieval/observation time, safe URL, SHA-256, byte count, sensitivity, cache state, and metadata. |
| Lead schema | Complete | Candidate lifecycle, bounded depth, evidence, timestamps, and immutable seed structure. |
| Investigation schema | Complete | Seed, objective, authorization, lifecycle, all budgets, plan link, accounting, warnings, and terminal-state completeness. |
| Hunter-Seeker intake adapter | Complete | Aircraft, vessel, satellite, seismic/weather event, and geographic-area mappings preserve exact observation provenance; repeated intake is deterministic. |
| Provider interface | Complete | Pure capability discovery, bounded planning, and normalization interface; no transport method exists. |
| Capability metadata | Complete | Seeds, outputs, authorization modes, sensitivity, query ceiling, auth namespace, rate, cache, reliability, and attribution. |
| Policy decision structure | Complete | Deterministic outcome, rule results, providers/capabilities, denials, budget, reasons, and confirmation state. |
| Maximum providers | Complete | Default 4, hard maximum 12, validated and reserved. |
| External calls | Complete | Default 12, hard maximum 100, validated, planned, and job-accounted. |
| Runtime | Complete | Default 120 seconds, valid range 50 ms–10 minutes, passed to the shared job manager. |
| Entities | Complete | Default 250, hard maximum 5,000, normalized and post-correlation enforcement. |
| Evidence bytes | Complete | Default 2 MiB, hard maximum 50 MiB, per-result accounting and post-correlation enforcement. |
| Discovery depth | Complete | Default 1, hard maximum 3, candidate-lead enforcement and no automatic following. |
| Deterministic plan | Complete | Stable provider/capability ordering, content-derived IDs, resource reservations, controlled steps, and tampered-decision rejection. |
| Provider result normalization | Complete | Closed top-level and nested drafts, stable IDs, canonical identifiers, reference resolution, budgets, evidence metadata, leads, warnings, and limitations. |
| No internet or persistence | Complete | Static audit rejects network, database, credential-store, and filesystem-write primitives from Gate 1 modules. |

## Gate 2 — Mocked vertical slice

| Requirement | Status | Verification |
| --- | --- | --- |
| Accept a domain | Complete | Plain FQDN validation and canonicalization occur before job creation. Invalid scheme/path/account input fails closed. |
| Accept a Hunter-Seeker observation | Complete | Selected observations pass through the Gate 1 intake and retain exact source citation. |
| Produce a bounded plan | Complete | Provider, call, entity, evidence, runtime, and depth reservations remain inside the approved budget, including tiny-budget edge cases. |
| Route through shared job manager | Complete | Module/name, progress, iterations, external calls, usage, timeout, terminal status, cleanup, and cancellation are recorded. |
| Query mock providers | Complete | Four deterministic offline providers cover domain and Hunter context paths through an isolated fixture executor. |
| Normalize evidence | Complete | Every fixture response crosses the centralized provider normalizer and runtime validators. |
| Deduplicate entities | Complete | Typed normalized identifiers drive deterministic union groups; observations, relationships, and leads are remapped safely. |
| Create claims | Complete | Primitive observations and relationships produce cited deterministic claims. |
| Create relationships | Complete | Graph edges are deduplicated, confidence-scored, cited, and reference-checked. |
| Calculate confidence | Complete | Provider reliability, source independence, observation confidence, directness, freshness, and contradiction penalties are deterministic and explained. |
| Generate candidate leads | Complete | IP, organization, and username fixture leads remain `candidate`, depth 1, cited, deduplicated, and unexecuted. |
| Produce a report | Complete | Structured and Markdown forms include scope, findings, confidence, relationships, leads, evidence index, attribution, limitations, and exact evidence citations. |
| Deterministic end-to-end fixture | Complete | Two independent runs are deeply equal; investigation, plan, report ID, counts, and Markdown SHA-256 are locked. |
| Cancellation | Complete | Both queued cancellation and an in-flight delayed provider operation abort promptly and release the job slot. |
| Contradictions | Complete | Conflicting normalized observations remain separate contested claims and receive a verified confidence penalty. |
| No live side effects | Complete | Static and runtime tests prove no network, database, credentials, filesystem writes, or UNIT use. |

## Audit findings repaired

The initial implementation passed its tests, but this audit found and fixed seven hardening opportunities:

1. Confidence category labels are now required to match numerical confidence.
2. Terminal investigations require completion time, plan linkage, and budget-consistent accounting.
3. Entities, observations, relationships, and candidate leads now require their essential identifier/evidence support.
4. Planner fan-out now accounts for very small entity and evidence budgets before allocating a step.
5. Provider result drafts now reject unknown nested properties, not only unknown top-level properties.
6. The mocked vertical slice now supports and tests active in-flight abort, not only queued cancellation.
7. The contradiction path now has an explicit regression proving separate contested claims and a confidence penalty.

## Intentional next-stage exclusions

The following are not incomplete Gate 0–2 items:

- No OSINT screen is exposed in the app yet.
- Investigations are not persisted.
- No real or paid provider is registered or called.
- No provider credential is accepted.
- No active UNIT tool invokes the OSINT runtime.
- Candidate leads are not submitted to Hunter-Seeker.

Those capabilities require their own later gates. Enabling them in Gates 0–2 would violate the approved isolation and safety sequence.

## Exit conclusion

Gates 0–2 meet their exit conditions with a deterministic, cited, bounded, cancellable, passive-only, offline investigation path and a regression-backed contract foundation. The implementation is ready for the next approved gate.
