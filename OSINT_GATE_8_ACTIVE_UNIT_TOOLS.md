# OSINT Gate 8 — Active UNIT tools

Status: implemented and verified.

Gate 8 gives a tool-capable active VoidCat UNIT a closed set of high-level, passive OSINT actions. The UNIT cannot call a raw provider API, supply a provider name, change the server-side provider route, mint an exposure authorization, or bypass investigation budgets.

## Exposed tools

- Investigate domain
- Investigate IP
- Investigate username
- Investigate organization
- Investigate infrastructure
- Authorized exposure check
- Investigate Hunter event
- Search passive web sources
- Expand an entity
- Retrieve evidence
- Explain a claim or confidence score
- List candidate leads

The shared registry publishes exactly these twelve `osint-unit` tools with closed JSON input schemas. Their model-facing aliases contain only task-level parameters. Provider selection remains fixed in the protected backend.

## Execution contract

Every chat analysis and every individual tool invocation runs through the shared job manager. Jobs publish queued, running, progress, resource, completed, failed, and cancelled states. The chat screen subscribes to those states and exposes a hard **CANCEL** action while a job is active.

The selected UNIT context window bounds both the messages sent to the UNIT and the evidence returned by a tool. Server-owned limits independently cap runtime, iterations, external calls, output size, provider fan-out, discovered entities, evidence bytes, and discovery depth.

All factual results use exact evidence markers in the form `[EV:evidence_id]`. Invented citation IDs are rejected. Uncited factual conclusions are marked `[UNSUPPORTED — NO EVIDENCE ID]`. If a small UNIT produces prose without citing evidence that its tool already retrieved, VoidCat replaces that prose with a deterministic cited evidence summary.

Candidate expansion never runs automatically. It returns a candidate awaiting separate operator approval. An exposure check additionally requires an exact-target, one-use authorization created by the operator in the provider screen. The authorization expires after five minutes and the UNIT cannot create it.

## Verification

The complete application suite passes **205 tests**, lint, and the production build. Gate 8 has thirteen focused tests covering the registry surface, closed schemas, fixed provider routing, context limits, evidence retrieval, confidence explanations, lead handling, one-use exposure approval, cancellation propagation, model aliases, citations, unsupported findings, UI progress, and the under-7-GB integration guard.

A live integration check used the tool-capable **Gemma4 Coding** UNIT at **5.67 GB** with a **4,096-token** context window. It completed a passive domain investigation through the shared job manager and returned exact evidence citations and coverage limitations. The unavailable SearXNG branch was reported as a coverage limitation while the configured local passive path completed. The UNIT was then automatically unloaded and the LM Studio process table was verified empty.

The isolated OSINT store remained valid after the check: schema version 2, SQLite quick-check `ok`, zero foreign-key violations, and zero orphaned rows.

## Operator smoke test

1. Load a tool-capable UNIT smaller than 7 GB.
2. Open chat and set **OSINT** to **ON**. Hunter tools will turn off because only one analysis lane can be armed at a time.
3. Ask: `Investigate the domain example.com using passive OSINT and cite the evidence IDs.`
4. Confirm the managed job appears with progress and a **CANCEL** button while active.
5. Confirm the response contains `[EV:...]` citations and clearly states provider failures or coverage limitations.
6. Ask to expand one candidate. Confirm it remains pending operator approval and does not run automatically.
7. In the OSINT provider screen, enter an exact exposure target and deliberately authorize the next UNIT check. Confirm the approval works once and cannot be reused.
8. Close or unload the UNIT and confirm the local runtime reports no loaded UNIT.

