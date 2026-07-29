# OSINT Gate 3 — Isolated persistence and evidence safety

Status: implemented, deployed, and verified. The running application lazily opens the isolated store when the OSINT provider screen or query route is used. Production OSINT cleanup and eviction remain approval-locked.

## Isolation boundary

OSINT data is stored only in `.voidcat/data/osint/osint.db`. Its WAL and validated pre-migration recovery backups are measured under the independent `osint-investigations` budget. The shared `voidcat.db`, Hunter history, RAG vectors/sources, replay files, imagery, conversations, messages, and memories are never opened by an OSINT cleanup operation.

The schema is currently version 2. It contains versioned tables for investigations, entities and aliases, observations, claims and supporting evidence, relationships, contradictions, candidate leads, provider cache, rate-limit state, invocation logs, and decision logs, plus Gate 5 identity links, structured conclusions, temporal changes, and contradiction details. Investigation-owned records use foreign keys and cascading deletion within the isolated store. Cross-reference tables are checked for orphaned rows after migration and every eviction.

## Write safety

Every managed write path requires an injected, fail-closed storage-budget guard. This includes schema initialization/migration, investigation bundles, provider-cache entries, rate-limit state, invocation logs, decision logs, cleanup mutations, and recovery copies. The deployed integration calls `VoidCatStorageBudgetManager.ensureWriteAllowed("osint-investigations", estimatedBytes)`.

Migrations require a validated source database, configurable free-disk reserve, accounted main/WAL/shared-memory footprint, bounded full WAL checkpoint, validated pre-migration backup, bounded `BEGIN IMMEDIATE` transaction, WAL mode, full synchronous durability, and post-migration `quick_check`, foreign-key, and orphan checks. Active writers and corrupt sources are refused before migration.

## Evidence and credential safety

Raw provider responses are optional and capped at 256 KiB per evidence record. Oversized responses become a sanitized bounded preview with original byte count, truncation marker, and SHA-256 digest. Recursive redaction removes authorization, cookies, API keys, access/refresh tokens, secrets, passwords, credentials, URL user information, and sensitive URL query parameters before serialization. Evidence and cache rows retain explicit status, age, expiry, attribution, retrieval times, and provenance.

The store is not a credential store. Provider credentials remain in Electron's protected main process.

## Cleanup, export, and recovery

Typed cleanup scopes are `investigation`, `provider-cache`, `raw-responses`, `invocation-logs`, and `decision-logs`. Each clear requires and hash-verifies an export outside the managed data root before it starts a transaction. It commits only its isolated scope, uses passive WAL checkpointing and bounded incremental reclamation rather than full `VACUUM`, then reruns consistency checks.

Eviction first produces an inert oldest-first plan. Production eviction fails closed unless explicitly approved; tests enable mutation only in uniquely named `voidcat-osint-test-*` temporary roots. Recovery accepts only a validated migration backup within the isolated backup directory and replaces a damaged disposable database through a temporary file.

## Disposable verification

`tests/osint-store.test.ts` covers migration and schema inventory, backup validation, budget accounting, full Gate 2 graph persistence, raw-response bounds and redaction, cache age/expiry/provenance, budget guards for all state/log writes, export-before-clear, shared-data sentinels, dry-run and eviction, cancellation, corruption refusal, recovery, consistency, and unsafe-path rejection.

No Gate 3 test opens the user's `.voidcat/data`, starts VoidCat or LM Studio, loads a UNIT, contacts a provider, or performs a network request.

## Deployment verification

The 2026-07-28 deployment audit opened `.voidcat/data/osint/osint.db` through the application, persisted one normalized local-provider cache entry plus rate-limit, invocation, and policy-decision records, then verified `quick_check=ok`, zero foreign-key violations, and zero orphaned rows. The shared core database and Hunter history database also passed separate read-only integrity checks. Reopening the current schema no longer creates redundant migration backups.

## Approval gate

The 2 GiB OSINT budget, 85%/70% watermarks, 256 KiB raw-response ceiling, redaction key list, cleanup scopes, external-export rule, and disposable eviction/recovery tests are implemented. Provider cache/log wiring is enabled; destructive production cleanup remains explicitly approval-locked.
