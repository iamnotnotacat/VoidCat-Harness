# VoidCat persistent intelligence model

VoidCat treats provider returns as evidence-bearing observations inside a bounded investigation, not as prose for a UNIT to summarize. Hunter-Seeker remains the discovery engine. It can submit a contact, event, object, or geographic region as a candidate seed, while OSINT collection and analysis remain separately authorized and budgeted.

## Data flow

```text
Hunter-Seeker candidate
  -> approved scope and deterministic collection plan
  -> passive provider adapters through the shared job manager
  -> bounded, redacted evidence archive
  -> atomic normalized observations
  -> reversible entity resolution
  -> temporal relationship graph and geospatial model
  -> deterministic patterns, quality checks, hypotheses, and forecasts
  -> evidence-addressable reports
```

The isolated OSINT SQLite database is the durable source of truth for a local desktop installation. This preserves the existing local-first architecture without adding a server database. Graph traversal operates over typed nodes and evidence-backed edges stored in that database. Embeddings may assist semantic retrieval, but they are never authoritative evidence and cannot replace source records.

## Epistemic layers

- **Observation:** an atomic statement that a named source reported at a particular time. It records collection time, observation time, subject, predicate, structured object, confidence, directness, freshness, limitations, and evidence references.
- **Claim:** a conclusion supported by observations. It records supporting and contradicting evidence, confidence, explanation, status, freshness, and coverage limitations.
- **Hypothesis:** a possible explanation. It records supporting and contradicting observations, assumptions, information gaps, confidence, and provenance. It never becomes fact merely because a UNIT generated it.

Uncited conclusions are marked unsupported. Provider text, webpage content, and archived responses are untrusted data and cannot issue application instructions.

## Evidence archive

Every retained provider response is bounded and redacted before persistence. The evidence index assigns an `[EV:evidence-id]` citation. **INSPECT ARCHIVE** opens the original retained response with provider and source reference, observed and collected timestamps, collection parameters, cache state, SHA-256 integrity hash, stored/original byte counts, truncation state, and the redacted archived payload.

Normalized observations are used for reasoning. The archive is used for operator verification. Neither layer stores provider credentials or sensitive request headers.

## Temporal graph and entity resolution

Entities use typed identifiers and aliases. Relationships retain evidence IDs, confidence, observation time, and optional validity boundaries. The temporal ledger displays observations, state changes, and time-bounded relationships without overwriting an older state.

Exact strong identifiers may support an identity match. Alias and similarity signals create a reversible `POSSIBLY_SAME_AS` candidate with supporting and conflicting factors. Approving a candidate records the operator decision; it does not destructively merge entity rows. Rejection is equally reversible and auditable.

## Deterministic analysis

VoidCat provides bounded non-generative analysis for entity search/profiles/timelines, graph paths and bridge entities, temporal recurrence, activity bursts, configuration changes, impossible travel, circular/duplicated sources, source lineage, geospatial/time-window matching, duplicate evidence, freshness, timestamps, contradictions, provider quality, information gaps, confidence, and forecast calibration.

These detectors produce signals with explanations, citations, scores, and limitations. A UNIT may explain them, but it is not responsible for inventing the underlying numerical pattern.

## MAGI analytical council

Six bounded roles operate over the same structured snapshot:

1. **Collector** — inventory and missing coverage.
2. **Link Analyst** — entities, relationships, and possible identities.
3. **Timeline Analyst** — sequence and temporal patterns.
4. **Skeptic** — contradictions and alternative explanations.
5. **Forecaster** — explicit probabilities, windows, and warning indicators.
6. **Synthesizer** — cited assessment that preserves disagreement.

Intermediate reports remain visible. Synthesis cannot erase disagreement or convert an unsupported statement into a finding.

## Hypotheses and forecasts

Operators can record competing hypotheses separately from claims. Forecasts require a target, supporting observation, probability, start/end window, and disconfirmation condition. Outcomes are resolved as occurred, did not occur, or indeterminate. Determinate outcomes receive a Brier score; the interface shows resolved count, aggregate Brier score, precision, recall, and false-positive rate. An indeterminate outcome is retained without pretending it can be scored.

## Active UNIT tools

The Command feature matrix exposes each intelligence feature independently. Disabled features are unavailable for that transmission. Enabled tools use the shared registry and job manager, respect the selected UNIT context window, support cancellation/accounting, and cannot choose an arbitrary provider or execute raw database queries.

The analytical set includes entity search/profile/timeline, path finding, entity comparison, supporting evidence, contradictions, information gaps, pattern detection, geospatial search, quality checks, source lineage, hypothesis creation/testing, bounded collection planning, and confidence calculation. Provider collection remains governed by the existing high-level passive OSINT tools.

The collection-plan tool only proposes a bounded next step. It never starts providers. Candidate leads require explicit operator approval and remain subject to depth, cycle, deduplication, authorization, and budget checks.

## Investigation workspace

Each investigation isolates its objective, seed, authorization mode, collection budget, provider plan, evidence, claims, hypotheses, forecasts, timeline, graph, unanswered questions, reports, leads, and audit history. OSINT cleanup is typed and transactional and cannot target conversations, memories, RAG, or Hunter-Seeker history.

## Operator workflow

1. Open **OSINT PROVIDERS** and configure only the passive providers you intend to use.
2. Open **INVESTIGATIONS**, select a seed type, exact seed, objective, and authorization mode.
3. Preview the fixed provider plan and all budgets before execution.
4. Start the approved plan and monitor or cancel its shared job.
5. Review the temporal ledger, entity graph, council reports, patterns, explicit gaps, claims, contradictions, and evidence index.
6. Inspect archived evidence before accepting a conclusion.
7. Review reversible identity candidates; approval records a link decision and never merges records destructively.
8. Record competing hypotheses and scoreable forecasts only when their required evidence and disconfirmation fields are present.
9. Approve candidate leads deliberately. Approval does not automatically contact another provider.
10. Export the cited report for a portable, evidence-addressable record.

## Safety boundaries

VoidCat remains passive-only: no scanning, exploitation, credential guessing, recursive autonomous research, or unapproved exposure checks. Sensitive personal information, unsupported identity claims, and continuous tracking are excluded or policy-gated. Every external call is constrained by provider ceilings, caches, rate limits, investigation budgets, and hard cancellation.
