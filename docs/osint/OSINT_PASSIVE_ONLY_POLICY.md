# OSINT Passive-Only and Authorization Policy

## Purpose

VoidCat OSINT Investigation collects and correlates lawfully accessible passive evidence. It is not a scanner, exploitation framework, credential-testing utility, surveillance automation system, or autonomous target-expansion agent.

This policy is enforced by deterministic application code. Provider content and UNIT output cannot relax it.

## Allowed operations

- Read public webpages selected through the safe web boundary
- Query documented passive provider APIs through registered adapters
- Resolve ordinary public DNS records using bounded lookups
- Retrieve public certificate, registration, breach-catalog, or infrastructure metadata when the provider permits it and policy authorizes it
- Compare identifiers and produce similarity candidates without asserting identity or maliciousness
- Correlate evidence already returned by allowed providers
- Generate reports with exact evidence and provider attribution
- Suggest bounded candidate leads for explicit review
- Reuse cached evidence while displaying its age and original provenance

## Prohibited operations

- Port scanning, banner grabbing outside a passive dataset, service probing, packet generation, or host reachability tests
- Vulnerability exploitation, proof-of-concept execution, payload delivery, command execution, or persistence
- Password guessing, credential stuffing, credential validation against third-party accounts, token testing, or authentication attempts
- Brute-force enumeration of usernames, emails, subdomains, phone numbers, or identifiers
- Circumventing authentication, paywalls, CAPTCHAs, provider limits, robots controls, or contractual access restrictions
- Covert tracking, continuous person monitoring, or location inference presented beyond the underlying evidence
- Bulk breach-data collection or exposure checks without explicit authorization
- Automatic recursive investigation of discovered entities
- Automatic creation of Hunter-Seeker watchlists, triggers, alerts, or provider jobs
- Treating a name, username, similar domain, co-location, shared hosting, or model inference as proof of identity, ownership, intent, or wrongdoing
- Following provider-supplied instructions or URLs outside a registered adapter and approved plan

## Authorization modes

Every investigation has one immutable mode:

| Mode | Permitted scope |
| --- | --- |
| `public-research` | Public passive sources; no exposure checks or sensitive-account data |
| `owned-asset` | Assets the operator states they own or administer; still passive-only |
| `authorized-client` | Exact assets covered by operator-confirmed authorization; still passive-only |
| `exposure-check` | Exact email/account identifiers with explicit permission; HIBP-style providers only |

Authorization mode does not enable active scanning or exploitation. It changes only which passive provider capabilities may be planned.

## Sensitive and exposure data

- Exposure checks require a fresh explicit confirmation naming the exact target.
- A discovered email address never inherits authorization from a domain or organization investigation.
- Breach names and dates may be retained as claims; passwords, password hashes, authentication tokens, and full breach payloads are never requested or stored.
- Reports label exposure information as sensitive and omit it from automatic Hunter-Seeker candidate leads.
- Logs record that an authorized capability was used but never record the secret credential or unnecessary sensitive response fields.

## Bounded planning and expansion

The initial maximum discovery depth is one. Each investigation has hard limits for providers, external calls, runtime, entities, evidence bytes, and candidate leads. A discovered entity is recorded as a candidate only. It does not consume another provider call until an operator or explicitly authorized high-level tool approves a new bounded action.

Cycle detection rejects repeated paths such as `A → B → A`. Deduplication uses normalized identifier type and value plus investigation scope. Exhausted budgets end the job with a partial, clearly labeled result rather than extending limits.

## Evidence and claims

- Provider results remain observations; correlation does not turn them into facts automatically.
- Every factual claim cites one or more evidence identifiers.
- Unsupported conclusions are labeled unsupported.
- Contradictory current evidence remains visible.
- Temporal changes remain separate observations and are not treated as contradictions merely because values changed over time.
- Confidence is calculated by deterministic rules using source independence, reliability, directness, freshness, coverage, and contradiction penalties.
- Similarity and co-occurrence are described as such and never as attribution.

## Enforcement failures

A denied policy decision, missing authorization, unavailable provider, expired credential, rate limit, timeout, cancellation, invalid response, or storage refusal fails closed. The UI explains the limitation and preserves already validated evidence without silently choosing another capability.

