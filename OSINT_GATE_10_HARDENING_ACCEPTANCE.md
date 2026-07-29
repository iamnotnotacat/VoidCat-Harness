# OSINT Gate 10 — Hardening and Acceptance

Status: **implemented; automated acceptance passed on 2026-07-28**

## Acceptance policy

Gate 10 is a release gate, not a feature toggle. A failing item blocks acceptance. Automated infrastructure checks do not load a UNIT. If a future model-integration smoke check is needed, it must use a UNIT smaller than 7 GB.

## Regression suite

`npm test` is the authoritative release command. It runs lint, the full Node test suite, and the production build. `npm run test:gate10` is a faster focused acceptance command but does not replace the full regression run.

## Provider fixtures

Every live-provider adapter—DeFlock, SearXNG, OpenSquat-style local similarity, Shodan, Censys, and HIBP—normalizes deterministic fixtures without network access. Fixtures verify capability metadata, attribution, cache policy, rate policy, authorization boundaries, evidence, observations, and entities.

## Disposable databases

OSINT migrations, corruption recovery, transactional deletion, eviction, budget enforcement, backup validation, and consistency checks run only against unique temporary roots. Synthetic-mode path guards reject a root that does not match the disposable-test contract. Tests verify that conversations, memories, RAG data, and Hunter-Seeker history survive every OSINT cleanup operation.

## Cancellation

Acceptance covers queued jobs, running shared jobs, worker termination, active-UNIT tools, Gate 9 provider execution, provider-bridge requests, OSINT persistence, database migration, scoped clear, storage eviction, folder work, and application shutdown. A cancelled operation must not report completion or publish a partial transaction.

## Rate limits and cache

Acceptance verifies that an identical unexpired cache entry is returned without a network call, cache age and expiry remain visible, an uncached request is held by the provider minimum interval, and provider retry state exposes the next allowed time. Rate state and cache records remain bounded and credential-free.

## Network and malformed responses

Network rejection, HTTP errors, rate-limit responses, oversized responses, non-JSON content, and malformed JSON place only the affected provider in a degraded state. Invalid data is not cached. A failed provider can yield a clearly marked partial investigation while evidence from successful fixed paths remains available.

## Secret-leak prevention

Protected configuration never returns raw credentials. Provider request URLs, status, invocation logs, cache data, errors, raw evidence, investigation records, and reports are checked against sentinel secrets. Sensitive object keys, authorization headers, bearer values, credential query parameters, and HIBP email addresses are redacted before return or storage.

## Unsupported claims

Factual conclusions must cite known evidence identifiers. Uncited statements receive the unsupported marker. Invented evidence identifiers fail validation. Reports retain evidence identifiers, observation identifiers, provider attribution, contradictions, freshness, confidence explanations, and coverage limitations.

## Controlled expansion

Depth remains capped at one. Duplicate, already-investigated, cyclic, fan-out, and budget-exhausted leads are suppressed deterministically. No candidate executes automatically. A separate operator or Hunter-Seeker approval is required for any next step.

## Hunter-Seeker recovery

A retryable source failure is isolated from other feeds. Last valid snapshots remain available through the configured cache interval, repeated silent-zero results become degraded, unhealthy feeds leave AI context, persisted feed settings restore on restart, and the display error boundary provides an explicit board recovery action.

## Screen-aware interface

Automated interface checks enforce minimum 10 px typography, internal scrolling, minimum-height containment, and responsive breakpoints at 1200 px and 800 px. Desktop acceptance additionally checks wide and compact views for clipped controls, page-level grey scrollbars, graph/evidence usability, warnings, progress, and cancellation.

## Configuration and operator documentation

The complete operator procedure is in `OSINT_OPERATOR_GUIDE.md`. Provider-specific acquisition and credential behavior remain documented in `OSINT_GATE_4_PROVIDERS.md`; active-UNIT boundaries in `OSINT_GATE_8_ACTIVE_UNIT_TOOLS.md`; and the investigation interface in `OSINT_GATE_9_INVESTIGATION_UI.md`.

## Acceptance commands

```powershell
npm run test:gate10
npm test
npx tsc --noEmit
```

After the automated run, launch the Electron app, perform the screen-aware smoke checklist, close it, and verify that port 4177 has no listener and `lms ps --json` returns an empty list.

## Verified result — 2026-07-28

- Focused Gate 10 acceptance: **65/65 passed**.
- Complete VoidCat regression: **225/225 passed**.
- ESLint: passed.
- TypeScript `--noEmit`: passed.
- Production build: passed.
- Provider tests used deterministic fixtures; no provider credentials were required.
- All migration, recovery, eviction, and consistency checks used disposable databases.
- No UNIT was loaded during automated infrastructure verification.
- Desktop screen check at 1280×720: passed with no clipped investigation controls, no page-level scrollbar, a 10 px rendered typography floor, themed internal scrolling, and no interface-console errors.
- Responsive 1200 px and 800 px contracts: passed through automated layout checks.
- Clean shutdown: zero VoidCat Electron processes, zero port 4177 listeners, and `lms ps --json` returned `[]`.
