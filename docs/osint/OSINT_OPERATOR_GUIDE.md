# VoidCat OSINT Operator Guide

This guide covers the passive OSINT Investigation workspace, provider configuration, safe operation, recovery, and data handling. VoidCat does not scan targets, exploit systems, guess credentials, or recursively investigate discoveries.

## Configure providers

Open **10 OSINT**, then select **PROVIDERS & API SETUP**. Each provider card shows whether it is ready, its cache state, request guard, and the official account or setup link when configuration is required.

- **DeFlock (`deflock`)** — no credential. Used for the operator-controlled crowdsourced camera layer and bounded geographic queries. Treat coverage as incomplete and community supplied.
- **SearXNG (`searxng`)** — enter the base URL of a trusted SearXNG instance. HTTPS is required, except for an explicit loopback instance such as `http://127.0.0.1:8080`. VoidCat removes user information, query strings, and fragments from the saved endpoint.
- **OpenSquat-style local similarity (`opensquat-local`)** — no credential and no network request. It generates bounded spelling-similarity candidates; those candidates are not findings and do not imply maliciousness.
- **Shodan (`shodan`)** — obtain an API key through the official link, enter it in the protected setup dialog, and run the credential test. Exact IP and domain targets only.
- **Censys (`censys`)** — obtain a Personal Access Token through the official link, save it through the protected setup dialog, and run the credential test. Exact IP and domain targets only.
- **Have I Been Pwned (`hibp`)** — obtain an API key through the official link. Every use additionally requires a fresh, explicit, exact-target exposure authorization. Discovered email addresses never expand automatically and exposure results cannot flow into Hunter-Seeker without approval.

Credentials are saved only by Electron's protected main process. Saved state is masked; raw secret values are not returned to the interface, investigation records, cache display, visible URLs, logs, or reports. Use **REPLACE**, **RETEST**, or **REMOVE** on the provider card to manage a saved credential.

## Run an investigation

1. Open **INVESTIGATIONS** under **10 OSINT**.
2. Choose the investigation type: domain, IP address, username, organization, infrastructure, Hunter event, passive web, geographic area, or authorized exposure.
3. Enter one exact bounded seed and a clear objective.
4. Choose the authorization mode.
5. Select **PREVIEW BUDGET & PLAN**. Review provider availability, the fixed provider path, warnings, and every reserved limit.
6. Select **START APPROVED PLAN** only when the preview matches the intended scope.
7. Watch live progress. A provider failure produces a visible partial result; it does not erase evidence already collected from another path.
8. Open the saved history item to review the temporal ledger, graph, claims, contradictions, competing hypotheses, forecasts, information gaps, calibration, evidence identifiers, attribution, freshness, and cache age.

The server chooses approved providers for each investigation type. Neither a person nor a UNIT can inject an arbitrary provider into a plan.

## Authorization

Public research mode permits bounded passive queries only. Exposure-check mode is restricted to the authorized exposure investigation type and requires:

- one exact email address or verified domain;
- an explicit authorization acknowledgement for that exact value;
- a meaningful authorization statement; and
- a fresh approval for each separate check.

Candidate leads are never authorization. Approving a candidate records the review decision but does not automatically contact a provider, create a watchlist, create a trigger, or begin another investigation.

## Budgets

The preview displays the authoritative limits before start:

- maximum providers;
- maximum external calls;
- maximum wall-clock runtime;
- maximum entities;
- maximum evidence bytes; and
- maximum discovery depth.

Depth is initially capped at one. The shared job manager enforces the limits during execution. Provider request ceilings and cache lifetimes remain fixed safety controls; the interface cannot raise them.

## Cancel a job

Select **CANCEL** beside the active investigation. Cancellation propagates through the shared job manager to an in-flight provider request and to isolated-store persistence. The job must end as **CANCELLED**, not **COMPLETED**. A cancelled transaction does not leave a partially saved investigation.

If the interface closes, VoidCat cancels investigation and active-UNIT OSINT job modules during server shutdown. Closing the desktop app also ejects any VoidCat-owned UNIT.

## Cache and rate limits

Each result identifies live, cached, or fixture evidence and its age. A valid unexpired cache entry is reused before a new provider request, including when the provider request guard is active. A different uncached target remains held until the provider's minimum interval or returned `Retry-After` window expires.

Cache use never changes evidence provenance. Stale or incomplete coverage remains visible as a warning. **Refresh** does not bypass protected OSINT provider ceilings.

## Claims and evidence

Every factual finding should reference one or more evidence identifiers in the form `[EV:evidence-id]`. Open the evidence index to see provider attribution, retrieval time, source reference, cache state, and cache age. Contradicting evidence remains explicit and temporal service changes remain separate observations.

If a generated statement has no valid evidence identifier, VoidCat marks it **UNSUPPORTED — NO EVIDENCE ID**. An invented or unknown evidence identifier fails validation.

Select **INSPECT ARCHIVE** on an evidence record to verify its original retained provider payload, collection parameters, observed/collected timestamps, SHA-256 integrity hash, and bounded/redacted archive state. The normalized observation is the reasoning input; the archived response remains the verification record.

## Intelligence analysis

The temporal ledger preserves observations and changes as separate time-bounded records. Reversible `POSSIBLY_SAME_AS` reviews never merge entity rows. Deterministic detectors surface patterns, source lineage, quality issues, information gaps, and geospatial matches with citations and limitations.

Hypotheses are possible explanations and remain distinct from claims. Forecasts require an explicit probability, time window, supporting observation, and disconfirmation condition. Resolve forecasts when the outcome is known; VoidCat retains Brier scores and aggregate calibration metrics instead of judging predictions by persuasive wording.

The six analytical roles—Collector, Link Analyst, Timeline Analyst, Skeptic, Forecaster, and Synthesizer—share structured case data but retain intermediate reports and disagreements. See [INTELLIGENCE_MODEL.md](INTELLIGENCE_MODEL.md) for the complete contract.

## Candidate leads

Candidate leads are unverified suggestions. Review supporting evidence before choosing **APPROVE CANDIDATE** or **REJECT**. Approval persists in history but still requires a separate deliberate action before any bounded next step. Duplicate, cyclic, already-investigated, over-depth, and over-budget candidates remain suppressed.

## Export

Select **EXPORT CITED REPORT** in a saved investigation. The Markdown report contains the scope, findings, contradictions, relationships, candidate leads, evidence index, provider attribution, and limitations. Sensitive credentials and sensitive headers are redacted before storage and cannot appear in the export.

## Troubleshooting

- **Provider not configured** — open **PROVIDERS & API SETUP**, use the official setup link, save the credential or SearXNG endpoint, and run **TEST**.
- **Request guard active** — wait until the displayed next-allowed time. Cached results for an identical request remain available immediately.
- **Partial investigation** — inspect provider status and warnings. Completed evidence remains usable and attributed; missing coverage must not be treated as a negative finding.
- **Malformed or non-JSON response** — the provider is marked degraded and the response is not cached. Retest later or check the configured service.
- **Network failure** — the affected provider is isolated and marked degraded. Other provider paths and Hunter-Seeker remain available.
- **Job will not finish** — choose **CANCEL**. If the renderer itself fails, use the recovery control or leave and reopen the screen.
- **Hunter-Seeker display failure** — use **RESTORE BOARD**. Cached source snapshots and persisted source settings are isolated from the OSINT interface.
- **Blank or cramped display** — resize the window or use the internal panel scroll areas. Gate 9 layouts collapse at the 1200 px and 800 px breakpoints without requiring a grey page scrollbar.

## Data and cleanup

OSINT data is isolated under `.voidcat/data/osint/`. Investigation cleanup is typed, transactional, and export-before-clear. It cannot touch conversations, approved memories, RAG libraries, or Hunter-Seeker history. Migration and stress tests use disposable temporary databases only; they must never target the real `.voidcat` database.

Before clearing an investigation, export the report or the scoped data bundle. If database validation fails, stop writing and use the validated pre-migration backup/recovery path. Do not manually delete SQLite WAL files while VoidCat is running.

## Acceptance check

Run `npm run test:gate10` for the bounded Gate 10 acceptance set. Run `npm test` before release for lint, the complete regression suite, and a production build. The manual screen check should cover wide, 1200 px, 800 px, and compact desktop sizes, followed by a clean shutdown check confirming zero loaded UNITs.
