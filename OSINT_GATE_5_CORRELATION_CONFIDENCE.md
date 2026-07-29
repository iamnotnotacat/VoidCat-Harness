# OSINT Gate 5 — Correlation and confidence

Status: implemented, deployed, and verified with deterministic offline fixtures. Gate 5 does not add provider calls or autonomous discovery.

## Identity correlation

Entities correlate only through typed identifiers. Exact matches retain an `exact` audit link. Formatting variants with the same normalized identifier retain a `normalized` link and every original value. Human-readable aliases—usernames, organization names, aircraft callsigns, vessel names, and geographic labels—require compatible entity types and confidence of at least 0.85 on both records. Weak aliases remain separate. Provider record IDs and Hunter observation IDs never merge identities.

Every accepted merge produces an identity-link record containing the canonical entity, member records, identifier type, normalized and original values, match kind, minimum identity confidence, and supporting evidence IDs. Identifier values are preserved rather than overwritten.

## Temporal and conflicting evidence

Raw observations remain distinct records. Claims are time-bounded episodes derived from them:

- repeated equivalent observations extend the evidence for the same episode;
- a later value closes and supersedes the earlier episode and creates an explicit change record;
- service, port, protocol, product, software, and technology changes are typed as `service-change`;
- service arrays are deduplicated and canonically ordered so list reordering is not reported as a change;
- incompatible values observed within the 60-second contemporaneous window create separate contested claims and an explicit contradiction rather than an arbitrary winner;
- relationships retain their observation time instead of being silently merged across time.

Each change records its previous and next claim, values, observation time, evidence, observations, and an explanation. Each contradiction records every competing claim, value, evidence item, observation, detection time, and explanation.

## Explainable confidence

Confidence is calculated per conclusion and is not a provider-count vote.

1. Evidence is grouped into independent source families using explicit upstream dataset/feed metadata first, then attribution/provider identity.
2. Only the strongest item from a shared source family contributes independent corroboration. Additional copies are counted as duplicates.
3. The observation confidence is multiplied by provider reliability, directness, freshness, and cached-age weights.
4. Independent weighted sources combine with a bounded noisy-OR calculation capped at 0.99.
5. An unresolved contradiction applies a 0.55 penalty.
6. The final numeric score maps through the shared confidence categories.

Directness weights are direct 1.00, derived 0.82, and inferred 0.62. Freshness weights are live 1.00, recent 0.95, stale 0.70, historical 0.55, and unknown 0.60. Cached evidence decays gradually to a floor of 0.65 over seven days. Provider reliability comes from the provider descriptor; an unknown provider fails conservatively to 0.65.

Every structured conclusion and report finding answers:

- what is claimed;
- which evidence and observations support it;
- which claims and evidence contradict it;
- how fresh the supporting observations are;
- the score, category, independent-source count, duplicate count, weights, and contradiction penalty;
- what coverage limitations remain.

The human-readable claim explanation uses explicit `Claim`, `Support`, `Contradiction`, `Freshness`, `Confidence`, and `Coverage` fields. The deterministic report format is version 1.1 and carries the structured conclusion beside each finding.

## Persistence and migration safety

The isolated OSINT schema is version 2. It adds identity links, structured claim conclusions, temporal changes, and contradiction details without altering shared conversations, memories, RAG, or Hunter history.

Before a v1 database migrates, VoidCat:

- accounts for the main database, WAL, and shared-memory footprint;
- requires the configured free-disk reserve;
- requests a bounded full WAL checkpoint and refuses migration while another writer is active;
- validates the source after checkpointing;
- creates and validates a pre-migration backup;
- applies the additive schema in one bounded immediate transaction;
- runs quick-check, foreign-key, and orphan checks afterward.

No Gate 5 test opens the user's database. Migration, conflict, alias, temporal-change, and confidence tests run only against deterministic fixtures and uniquely named disposable databases.

## Verification

`tests/osint-correlation-confidence.test.ts` proves exact, normalized, strong-alias, and weak-alias behavior; temporal separation; canonical service sets; explicit changes; near-contemporaneous conflicts; contradiction penalties; independent-source detection; provider reliability; freshness; directness; and complete coverage explanations.

`tests/osint-mocked-vertical-slice.test.ts` locks the deterministic report ID, counts, digest, citations, and full-result repeatability.

`tests/osint-store.test.ts` proves schema v1-to-v2 migration, legacy-row preservation, active-writer refusal, validated backup recovery, persistence of the complete explainability graph, transactional deletion, and orphan-free consistency.

## Deployment verification

The current full application suite passes 182/182 with lint, TypeScript compilation, and a production build. Before restarting the desktop app, the UNIT runtime was verified offline and Hunter-Seeker was verified stopped. The real isolated OSINT database had a 4 KiB main file and approximately 443 KiB of committed WAL content; the new migration path checkpointed it into a 212 KiB main database, created and validated a 212 KiB pre-migration backup, and preserved the existing provider-cache, rate-limit, invocation, and policy-decision records. The running app reports schema version 2, `quick_check=ok`, zero foreign-key violations, zero orphaned rows, approval-locked cleanup, no loaded UNIT, and no migration error.
