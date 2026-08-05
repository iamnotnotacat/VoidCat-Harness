# OSINT Investigation Test Safety Contract

## Non-negotiable rule

No OSINT database migration, eviction, destructive test, load test, replay test, provider fixture import, or stress test may run against the operator's real `.voidcat` directory.

## Disposable storage

OSINT persistence tests will create a unique directory beneath `os.tmpdir()` with the prefix `voidcat-osint-test-`. Destructive helpers must:

1. Resolve the absolute path.
2. Resolve the operating-system temporary directory.
3. Reject symlinks and junctions.
4. Verify the target is a direct or nested child of the temporary directory.
5. Verify the disposable root basename begins with `voidcat-osint-test-`.
6. Reject `.voidcat`, the project root, a drive root, a user-profile root, or any path outside that exact disposable root.
7. Close SQLite handles before cleanup.

Production mode will refuse OSINT migrations, real cleanup, and eviction until their individual approval gates are implemented. Tests that need mutation use an explicit synthetic mode and injected data root.

## Migration tests

- Seed only synthetic records and fixtures.
- Check sufficient free space before backup or migration.
- Back up and validate the disposable database before DDL.
- Use bounded transactions with cancellation checkpoints.
- Never use routine full `VACUUM`.
- Run `PRAGMA quick_check` and foreign-key checks after each migration.
- Verify entity/evidence/claim relationships and vector/source ownership after simulated pruning.
- Preserve the pre-migration backup when validation or cancellation fails.

## Provider tests

- Unit and integration tests use injected transports and saved fixtures.
- The default test command performs no live OSINT provider requests.
- Fixtures contain no real API key, authentication header, personal breach record, or private operator data.
- Provider adapters must be tested for malformed JSON, oversized bodies, redirects, timeouts, cancellation, rate limits, partial responses, missing fields, and secret redaction.
- Live smoke tests are separate, operator initiated, minimal, and never part of `npm test`.

## Resource ceilings

Tests use deliberately small limits so limit behavior is exercised without resource pressure:

- At most two concurrent OSINT jobs by default
- Bounded fixture and response sizes
- Bounded entity, relationship, evidence, and lead counts
- Short wall-clock and external-call ceilings
- No uncontrolled retry loop
- No recursive provider expansion
- No model required for core, provider, graph, database, or UI contract tests

The opt-in integration check is `npm run test:unit-live` with `VOIDCAT_LIVE_UNIT_TEST=1`. It selects only a locally available model smaller than 7 GB—specifically, a tool-capable UNIT between 1 GB and 7 GB—refuses to run while any other LM Studio UNIT is loaded, uses a disposable VoidCat data root, and must verify ejection on completion, failure, or cancellation. It is never part of `npm test`.

## Real-data protection verification

Every persistence test must assert its resolved database path is inside its disposable root before initialization. Destructive-test coverage must include an attempt to supply the real project data path and prove that the operation is rejected before any file is opened for writing.

The existing storage-budget suite already enforces equivalent temporary-root restrictions for shared VoidCat data. OSINT tests will add their own independent guard rather than relying only on the shared suite.
