# OSINT Gate 9 — Investigation Interface

Status: **implemented and verified**

## Operator workflow

Open **10 OSINT** and choose **INVESTIGATIONS**. The workspace is introduced in two layers: the investigation list and evidence workspace are the primary view; the entity and relationship graph is a secondary analysis view inside the selected investigation.

1. Select an investigation type and enter an exact seed.
2. Describe the objective and choose the authorization mode.
3. Select **PREVIEW BUDGET & PLAN**. VoidCat shows the fixed provider route, provider availability, policy decision, runtime ceiling, external-call ceiling, entity ceiling, evidence-byte ceiling, and discovery depth before any job starts.
4. Select **START INVESTIGATION**. Progress, status, elapsed time, resource accounting, and cancellation remain visible while the shared job manager runs the work.
5. Select a history item to inspect its graph, claims, contradictions, confidence explanation, evidence identifiers, provider attribution, cache age, and candidate leads.
6. Approve or reject candidate leads individually. Approval records a review decision only; it does not automatically expand the investigation, contact another provider, or create a Hunter-Seeker watchlist.
7. Select **EXPORT REPORT** to download the cited Markdown report.

## Implemented controls

- Investigation types: domain, IP, username, organization, infrastructure, Hunter event, passive web, geographic area, and explicitly authorized exposure check.
- Exact seed validation and an explicit authorization acknowledgement for exposure checks.
- Server-controlled provider plans. The interface cannot select arbitrary providers or exceed the passive-only policy.
- Preflight budget and provider-status preview before execution.
- Live job updates, hard cancellation, bounded runtime/calls/entities/evidence/depth, and partial-result handling.
- Persistent investigation history in the isolated OSINT store.
- Entity graph with relationship links and accessible entity details.
- Claims with supporting and contradicting evidence, confidence category, confidence explanation, freshness, and coverage limitations.
- Evidence IDs, provider attribution, source URL when safe, observed time, cache state, and cache age.
- Candidate-lead approval and rejection with persisted status.
- Cited Markdown report export.
- Prominent warnings for partial investigations, missing providers, sensitive exposure data, unsupported conclusions, stale evidence, and incomplete coverage.
- A separate **PROVIDERS & API SETUP** tab that preserves the existing provider credential and availability workflow.

## Safety contract

- Every live investigation runs through the shared job manager.
- Provider selection is fixed by the server for each investigation type.
- Discovery depth is capped at one and candidate leads never run automatically.
- Credentials remain in Electron's protected process and are not returned to this interface or written to investigation records.
- HIBP is available only in the exact-target, explicitly authorized exposure mode.
- Reports cite evidence identifiers; conclusions without usable citations are marked unsupported.
- Provider failure produces a visible partial result instead of silently discarding completed evidence.

## Verification record

- Gate 9 focused tests: **10/10 passed**.
- Full VoidCat suite: **215/215 passed**.
- TypeScript type check: passed.
- Production build: passed.
- Lint: passed.
- Desktop smoke test: passed with no browser-console errors.
- Manual smoke path: a domain investigation produced a fixed two-provider plan, ran through the shared job manager, saved a partial result when SearXNG was unavailable, retained the completed local OpenSquat evidence, rendered the entity graph, displayed the warning and provider state, persisted candidate approval, and reopened from history.
- UNIT policy: no UNIT was loaded for this interface/infrastructure verification.

## Repeatable smoke check

1. Launch VoidCat and open **10 OSINT**.
2. Confirm **INVESTIGATIONS** opens by default and **PROVIDERS & API SETUP** remains available.
3. Enter `example.com`, preview the plan, and confirm the displayed ceilings match the start request.
4. Start, observe progress, and cancel a disposable run to verify hard cancellation.
5. Start again and allow completion. Confirm provider failures are shown as partial, not successful.
6. Reopen the result from history.
7. Inspect the graph, claims, confidence explanation, evidence IDs, provider attribution, and cache age.
8. Approve one candidate, reopen the result, and confirm the approval persists without automatic expansion.
9. Export the report and confirm its findings contain evidence citations.
10. Confirm no secret value appears in the interface, report, investigation record, or visible URL.
