# OSINT Gate 6 — Controlled expansion

Status: implemented and verified offline. Gate 6 evaluates and approves candidate leads; it never invokes a provider, starts a job, submits a plan, or writes to storage.

## Boundary

The controlled-expansion evaluator accepts one completed investigation, its candidate leads, registered passive-provider descriptors, the investigation's consumed resources, its ancestor path, and previously investigated seeds. It returns a deterministic list of eligible or suppressed suggestions. Every suggestion is marked `automatic: false` and `requiresExplicitApproval: true`.

The initial discovery-depth ceiling is hard-capped at one even if a broader investigation budget is supplied. An approved follow-up receives `maximumDiscoveryDepth: 0`, one provider, one capability, one call, one entity slot, 10 seconds, and 64 KiB of evidence capacity. The follow-up must still pass the ordinary policy evaluator and job limits before another component may submit it.

## Identity, duplicate, and cycle controls

Candidate seeds are normalized by entity type before comparison. Domain case and trailing-dot variants, normalized identifiers, and repeated provider discoveries therefore share one key. The evaluator:

- retains one deterministic representative and suppresses duplicate candidates;
- suppresses seeds found in the supplied completed-investigation history;
- treats the current seed and every ancestor seed as a path and suppresses a return to any member, preventing `A → B → A` and longer cycles;
- suppresses non-candidate lead states and leads outside the depth-one boundary;
- refuses leads belonging to a different investigation.

No lead status is promoted during evaluation.

## Provider, fan-out, and budget controls

Only registered, validated, passive, non-sensitive capabilities compatible with the candidate seed and authorization mode can support a suggestion. Authorized exposure checks are deliberately excluded: they require a new exact-target authorization instead of ordinary expansion approval.

The default fan-out ceiling is 10 and the hard configurable ceiling is 25. Each eligible suggestion reserves one provider capability, one call, one entity, 10 seconds, and 64 KiB. Reservations accumulate while suggestions are evaluated, so the displayed set as a whole—not merely each item in isolation—fits the remaining investigation budget.

Suppression reasons are explicit:

- not a candidate;
- depth limit;
- duplicate candidate;
- already investigated;
- cycle detected;
- no compatible passive provider;
- provider, external-call, runtime, entity, or evidence budget exhausted;
- fan-out limit.

## Explicit approval

Approval requires the exact investigation, evaluation, suggestion, and lead IDs; a valid timestamp; a confirmed operator or Hunter-Seeker actor; an actor identifier; and a meaningful confirmation statement. A suppressed suggestion cannot be approved.

Successful approval creates an immutable `approved-not-submitted` record and a bounded next-request description. It does not start a provider, create a managed job, or submit the request. Exposure-mode candidates fail closed and must return through the stricter exact-target authorization flow.

## Verification

`tests/osint-controlled-expansion.test.ts` proves:

- `A → B → A` cycle prevention;
- normalized duplicate and already-investigated suppression;
- deterministic ordering independent of candidate input order;
- hard fan-out enforcement;
- separate provider, external-call, runtime, entity, evidence, and depth exhaustion behavior;
- exact operator/Hunter-Seeker approval and rejection of suppressed candidates;
- approved requests remain unsubmitted and cannot discover grandchildren;
- the Gate 6 module contains no transport, executor, job-start, credential, database, or filesystem-write primitive.

The Gate 2 deterministic investigation now includes its controlled-expansion evaluation, proving that every generated lead crosses this boundary while remaining a candidate.
