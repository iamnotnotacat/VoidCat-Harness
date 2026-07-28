# OSINT Investigation Gate 1 Core Contracts

Gate 1 is a pure, network-free, persistence-free contract layer. Its modules compile independently of the UI and do not initialize VoidCat services.

## Contract version

Every stored or transferred OSINT record declares schema version `1.0.0`. The eight closed record contracts are:

- Entity
- Identifier
- Observation
- Claim
- Relationship
- Evidence
- Lead
- Investigation

Each contract has a versioned schema descriptor with `additionalProperties: false` and a runtime validator. Runtime validation also checks supported enum states, confidence ranges, bounded strings and arrays, ISO timestamps and temporal ordering, JSON-only attributes, evidence URLs, SHA-256 digests, cache metadata, attribution, accounting, and nested identifiers.

## Investigation budgets

Every investigation has six independent integer limits:

| Limit | Conservative default | Absolute application maximum |
| --- | ---: | ---: |
| Providers | 4 | 12 |
| External calls | 12 | 100 |
| Runtime | 120 seconds | 10 minutes |
| Entities | 250 | 5,000 |
| Evidence bytes | 2 MiB | 50 MiB |
| Discovery depth | 1 | 3 |

Budgets reject unknown fields, fractions, negative values, missing dimensions, and values above an absolute maximum. Later settings may lower these values but may not expand the hard contract.

## Provider boundary

Provider descriptors declare:

- Passive-only status
- Transport class
- Authentication requirement and protected credential namespace
- Supported capabilities, seeds, authorization modes, and output entity types
- Per-capability query ceilings
- Rate and concurrency limits
- Cache and stale-on-error windows
- Reliability input
- Documentation, terms, and attribution
- Default availability

Gate 1 provider adapters deliberately have only three operations:

1. Determine whether a seed and authorization mode are supported.
2. Produce bounded query descriptions.
3. Normalize an already supplied result.

They have no network, socket, database, filesystem-write, or credential method. A later execution layer will deliver responses after the policy, job, broker, rate, and request-size gates approve them.

## Provider result normalization

The centralized normalizer:

- Rejects unknown top-level data and malformed collections.
- Requires unique local references.
- Resolves entity and evidence references explicitly.
- Produces stable content-derived identifiers.
- Canonicalizes identifier values and removes duplicates.
- Preserves temporal observations rather than merging them.
- Converts discoveries into `candidate` leads only.
- Enforces entity, evidence-byte, and discovery-depth budgets.
- Adds provider attribution, cache state, confidence categories, freshness, directness, warnings, and coverage limitations.
- Emits only records that pass the shared runtime validators.

Raw provider responses are not part of the normalized contract.

## Policy decisions

A policy decision records its deterministic identifier, outcome, individual rule results, effective budget, allowed providers and capabilities, denied capabilities, reasons, and whether operator confirmation is required.

Exposure checks require all of the following:

- `exposure-check` authorization mode
- An email seed
- The `authorized-exposure-check` capability
- A fresh affirmative statement
- An exact normalized match between the confirmed target and seed

Changing a request, provider registry, or decision invalidates the decision supplied to the planner.

## Deterministic plans

Plans use stable provider and capability ordering. Each step reserves one external call, a bounded evidence allocation, an entity allocation, and a query cache key. Plan validation proves that provider, call, entity, evidence, and depth reservations fit the approved budget.

Every step declares:

```text
automatic expansion: false
discovered entities: candidate leads
```

The planner cannot create a plan from a denied, held, or altered policy decision.

## Hunter-Seeker intake

`HunterSeekerIntakeAdapter` maps selected live observations into an investigation seed, entity, evidence record, and OSINT observation. It currently recognizes:

- Military and civilian aircraft
- Maritime vessels
- Satellites and space stations
- Seismic and weather events
- Explicit map bounding boxes, including antimeridian regions

The adapter preserves the Hunter observation ID, entity ID, source feed, observation time, position, source confidence, evidence basis, staleness, and retention classification. It never accepts or copies a raw provider payload. Its stable IDs make repeated intake idempotent for the same investigation and observation.

## Verification

`tests/osint-core-contracts.test.ts` verifies schemas, closed validation, every budget dimension, hard limits, provider capability metadata, exposure authorization, policy integrity, deterministic planning, controlled expansion, provider normalization, evidence accounting, broken references, Hunter-Seeker mappings, antimeridian regions, and the absence of network/database/write/credential primitives.

