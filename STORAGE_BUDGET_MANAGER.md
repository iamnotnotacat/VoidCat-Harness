# VoidCat P2 storage budget manager

Status: implemented behind the Stage 4 approval gate on 2026-07-27. Measurement, configuration, projection, subscriptions, and dry-run planning are enabled. Production migrations and eviction are deliberately disabled.

## Registered budgets

| Budget | Default limit | High / low watermarks | Ownership |
|---|---:|---:|---|
| Hunter observations | 5 GiB | 85% / 70% | Future Hunter observation rows, Hunter vectors, Hunter blobs, and replay files only |
| Chat memory | 500 MiB | 90% / 75% | Conversations, messages, and approved memory rows; manual scope only |
| Imagery cache | 2 GiB | 85% / 70% | Files under the managed imagery cache only |

Limits and watermarks are validated, saved in VoidCat settings, and restored at application startup. Automatic cleanup is fixed to `false` during this gate.

## Accounting contract

The manager reports the physical shared SQLite database, the physical SQLite WAL, logical RAG embeddings/index metadata and Hunter vector payloads with separate ownership totals, Hunter blobs, Hunter replay files, and imagery-cache files as separate components.

The physical database and WAL are never assigned wholesale to a cleanup budget because both contain shared data. Hunter usage is calculated only from explicitly Hunter-owned tables and directories. RAG vector bytes are measured but excluded from Hunter cleanup. Chat rows are measured through their own budget and cannot appear in a Hunter dry-run.

Time-to-full is calculated only after at least two bounded samples show positive growth. Flat or shrinking storage reports no projection instead of inventing one.

## Local interfaces

| Interface | Behavior |
|---|---|
| `GET /api/storage/budgets` | Measures components and returns all three budget states and projections |
| `PATCH /api/storage/budgets/:id` | Validates and persists limit/high/low settings |
| `POST /api/storage/cleanup/dry-run` | Returns a typed, non-mutating plan to return one budget to its low watermark |
| `GET /api/storage/events` | Server-sent state-change subscription with an initial budget contract and keepalive |
| `POST /api/storage/clear` | Returns the approval-gate error; no production deletion path is enabled |

## Typed clear scopes

The primitive defines six non-overlapping scopes: `hunter-observation-rows`, `hunter-vectors`, `hunter-blobs`, `hunter-replay`, `imagery-cache`, and `chat-memory`.

Chat memory is not a Hunter scope. Even in disposable tests it requires the dedicated `CLEAR_CHAT_MEMORY` confirmation. Observation eviction deletes dependent Hunter vector/source rows in the same bounded transaction before deleting each observation batch. RAG tables are never included.

## Migration and eviction safety

Mutation code can run only when the manager is constructed in synthetic mode. Synthetic mode resolves and rejects symbolic or non-temporary roots, requires a `voidcat-storage-test-*` directory, and requires `voidcat.db` to be directly inside that exact root. A disposable root cannot be paired with an external database path. The running application always constructs production mode.

Before every synthetic migration or clear, the manager:

1. checks that both Hunter and RAG write counts are zero;
2. checks the source and export filesystems independently for a full database set, every scoped file, and rollback margin;
3. exports the affected database set or scoped files outside the managed data directory;
4. validates every database backup with SQLite `quick_check`;
5. honors cancellation before work and between bounded clear batches, and hard-terminates a killable migration worker on cancellation or timeout;
6. uses bounded transactions and a wall-clock ceiling;
7. verifies SQLite integrity after a migration;
8. verifies Hunter vector/source consistency after every observation-eviction batch and after the operation.

Migration plans are limited to 1-32 validated `CREATE TABLE`, `CREATE INDEX`, or `ALTER TABLE` statements and 128 KiB total. They execute as one transaction in a killable child process so the application event loop remains responsive. Reclaim statements, attachment, data changes, and destructive schema statements are rejected. Routine cleanup never performs a full database compaction.

RAG upload, incremental indexing, search-time index migration, and registered-folder scans declare active RAG writes to the shared guard. The opt-in Hunter history writer uses the exported Hunter activity tracker and the pre-write high-watermark guard. Its isolated database and WAL are measured as separate physical components; historical vector ownership is reported logically without double-counting the same physical database bytes.

## Approval state

The synthetic report is in `STORAGE_BUDGET_SYNTHETIC_REPORT.md`. Generic production clear remains disabled. Historical recording is separately opt-in; its manual progressive downsampling is scoped only to bulk rows, creates a validated replay backup, protects pinned/watchlist/trigger/derived/summary records, checks cancellation and vector consistency per bounded group, and never touches chat memory or runs a full `VACUUM`.
