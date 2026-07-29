# OSINT Investigation Gate 2 Mocked Vertical Slice

Gate 2 proves the complete investigation architecture with deterministic offline fixtures. It does not contact the internet, read credentials, create a database, write a report file, or load a UNIT.

## Accepted seeds

The runtime accepts:

- A plain fully qualified domain name
- A selected `HunterSeekerPublicObservation`

Domain input is normalized and validated before a job is created. Hunter-Seeker input passes through the Gate 1 intake adapter and retains the source feed, observation ID, entity ID, time, position, confidence, evidence basis, and staleness.

## Execution path

```text
seed
  → policy decision
  → bounded deterministic plan
  → shared VoidCat job manager
  → offline fixture provider executor
  → provider adapter normalization
  → entity and evidence deduplication
  → relationship correlation
  → deterministic claims and confidence
  → candidate leads (never followed)
  → structured + Markdown report
```

Every mock provider request is passed through `ManagedJobContext.externalCall`. The shared job manager therefore enforces and records external-call count, iteration count, timeout, progress, usage, cancellation, and terminal state even though the fixture response is local.

## Fixture providers

| Provider | Domain output |
| --- | --- |
| `mock.passive-dns` | Domain, documentation IP, passive resolution relationship, and IP candidate lead |
| `mock.certificate` | Domain, synthetic certificate, organization, certificate relationships, and organization lead |
| `mock.search` | Domain, organization, username, public co-mention relationship, and username lead |
| `mock.hunter-context` | Synthetic contextual observation for selected aircraft, vessel, satellite, event, or region seeds |

All IPs, records, URLs, organizations, certificates, and handles are reserved or explicitly synthetic fixtures. Their reports display `MOCK EVIDENCE ONLY` prominently.

## Deduplication

Entities are merged using normalized typed identifiers rather than provider-local IDs or display names. The correlation stage uses deterministic union groups, remaps observations and relationships, and merges identifiers, evidence references, timestamps, and non-identical attribute variants.

Evidence is content-addressed and deduplicated by stable evidence ID. Conflicting records sharing one stable ID fail closed rather than being silently merged.

Candidate leads are deduplicated by normalized seed type and value. Their only Gate 2 state is `candidate`; they do not trigger new provider calls, watchlists, alerts, or Hunter-Seeker submissions.

## Claims and confidence

Claims are generated from normalized primitive observation attributes and explicit relationships. Identical subject/predicate/value claims combine supporting observations and evidence. Different values for the same subject and predicate become contested claims and receive a contradiction penalty.

Confidence is deterministic and explainable. It uses:

- Observation confidence
- Provider reliability metadata
- Direct, derived, or inferred evidence
- Freshness classification
- Independent provider count
- Contradiction penalty

The report records the score, category, evidence IDs, observation IDs, and explanation for every claim. No model contributes to the score.

## Report

The report contains:

- Scope and provider calls
- Executive summary
- Deduplicated entities
- Cited findings
- Cited relationships
- Candidate leads labeled candidate-only
- Evidence index with provider, source reference, byte count, and SHA-256 digest
- Provider attribution
- Coverage limitations and fixture warnings

Random managed-job IDs are intentionally excluded from the report. With the same input, fixtures, policy, budget, and clock, the investigation, plan, correlations, and report are byte-for-byte deterministic.

## Deterministic acceptance fixture

The domain fixture for `Example.COM.` produces:

| Output | Expected value |
| --- | ---: |
| Providers / external calls | 3 / 3 |
| Deduplicated entities | 5 |
| Observations | 6 |
| Claims | 12 |
| Relationships | 4 |
| Evidence records / bytes | 3 / 333 |
| Candidate leads | 3 |
| Contradictions | 0 |
| Report ID | `report_9093df9c6f393488358b1f6d` |
| Markdown SHA-256 | `d21bbb04cf4c3008ca468d81dded596ba87030a773b08f02cea035316b9049d7` |

`tests/osint-mocked-vertical-slice.test.ts` runs the same investigation twice and requires deep equality. It also locks the expected IDs, counts, and Markdown digest; verifies every finding citation; verifies graph references; tests a Hunter-Seeker aircraft seed; proves provider fan-out obeys a reduced budget; rejects malformed domains before job creation; proves queued and in-flight hard cancellation; and verifies that conflicting observations remain separate contested claims with a confidence penalty.
