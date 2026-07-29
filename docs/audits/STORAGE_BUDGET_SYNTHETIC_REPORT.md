# P2 synthetic dry-run and stress report

Run date: 2026-07-27  
Environment: disposable `voidcat-storage-test-*` SQLite databases and file trees under the operating-system temporary directory  
Real VoidCat database used: **no**  
UNIT loaded: **no**  
Production eviction enabled: **no**

## Requirement audit

| Requirement | Status | Evidence |
|---|---|---|
| Register three specified budgets | Pass | `DEFAULT_BUDGETS`; live disposable endpoint test |
| Separate DB, WAL, vectors, blobs, replay | Pass | Component report; active-WAL and RAG/Hunter ownership tests |
| Configurable high/low watermarks | Pass | Validation, settings persistence, partial PATCH endpoint test |
| Projected time-to-full | Pass | Positive-growth clock/file fixture |
| Dry-run cleanup | Pass | Hunter, chat, and imagery dry-run tests; mutation comparison |
| Export-before-clear | Pass | Database/file manifests validated before every synthetic delete |
| Typed, scoped clears | Pass | Six-scope type contract and independent database/file tests |
| Protect chat from Hunter cleanup | Pass | Chat survives Hunter pressure test; dedicated confirmation required |
| State-change subscriptions | Pass | Isolated programmatic listeners, activity events, and live SSE test |
| Backup/validate before migrations | Pass | Pre-migration export plus `quick_check`; corrupt source rejection |
| Sufficient free disk | Pass | Source and export filesystems checked with database/scoped-file margins |
| Block active Hunter/RAG writes | Pass | Both activity kinds reject clear and migration |
| Bounded transactions/cancellation | Pass | Bounded clear batches yield; migration is a timed, killable worker transaction |
| Avoid routine full compaction | Pass | Reclaim statements are rejected; cleanup contains no compaction path |
| Disposable databases first | Pass | Synthetic mode requires an exact temporary disposable root |
| Consistency after simulated eviction | Pass | Orphan checks after every observation batch and final operation |
| Never stress the user database | Pass | All pressure tests use temporary roots; external DB paths are rejected |
| Approval before real eviction | Pass / locked | Production manager and `/api/storage/clear` reject with `APPROVAL_REQUIRED` |

## Result

All 20 dedicated P2 tests passed. The complete project suite now contains 105 passing tests.

| Scenario | Result |
|---|---|
| Register 5 GiB / 500 MiB / 2 GiB budgets | Pass |
| Separate DB, WAL, vector, blob, replay, and imagery accounting | Pass |
| Separate RAG/Hunter vector ownership | Pass |
| Include real `document_chunks` embedding payloads in vector accounting | Pass |
| High/low validation and positive-growth time-to-full projection | Pass |
| Hunter dry-run targets low watermark without mutation | Pass |
| Hunter plan cannot select chat memory | Pass |
| Subscription isolation and unsubscribe | Pass |
| Activity begin/end state subscriptions without double counting | Pass |
| Live SSE connected/configured events through a disposable Vite server | Pass |
| Production clear and migration rejection | Pass |
| Export and SQLite validation before typed synthetic clear | Pass |
| Scoped file eviction and pre-cancel behavior | Pass |
| Export-volume free-space calculation includes every scoped file | Pass |
| Active Hunter/RAG write guard | Pass |
| Insufficient-disk migration rejection | Pass |
| Validated backup before bounded migration | Pass |
| Reclaim-statement rejection and migration cancellation | Pass |
| Killable migration worker and post-backup cancellation | Pass |
| Database-clear cancellation between one-row batches | Pass |
| Corrupt source rejection before backup/migration | Pass |
| Synthetic database-path containment | Pass |
| 2,000-observation pressure test in 37-row batches | Pass |
| Vector/source consistency check after every observation batch | Pass |
| Missing observation parent correctly reports orphan vectors/sources | Pass |
| Chat and RAG survival after Hunter eviction | Pass |
| Dedicated chat confirmation | Pass |
| Local read/dry-run/config/subscription routes and locked clear route | Pass |
| Validated budget settings survive a backend restart | Pass |

## Dry-run review

The synthetic Hunter budget was deliberately placed above its configured high watermark. The plan calculated the bytes needed to reach the low watermark; selected only Hunter replay, Hunter blobs, Hunter vectors, and Hunter observation rows, in that order; marked `chat-memory` protected; excluded RAG-owned vector and embedding bytes; returned `realEvictionEnabled: false`; and left every row and file byte unchanged.

The chat-memory dry-run produced a manual-only report with no automatic actions. The imagery dry-run uses only the imagery-cache scope.

## Pressure and recovery review

The stress fixture created 2,000 observations, 2,000 Hunter vectors, 2,000 Hunter provenance/source rows, 2,000 RAG vector rows, protected chat records, and separate cache files. Observation eviction ran in 37-row transactions. After each batch, orphan vectors and orphan sources remained zero. At completion:

- Hunter observation/vector/source rows were zero;
- protected messages and memories remained present;
- all 2,000 RAG vector rows remained present;
- the pre-clear exported database passed `quick_check`;
- the remaining database passed `quick_check`;
- no compaction operation ran.

Cancellation was tested before file clear, between one-row database-clear batches, and against the killable migration worker after a validated backup. The active-write guard rejected both Hunter and RAG activity. Separate low-space fixtures rejected source-database work and scoped export before copying or deletion. A corrupt database was rejected before migration.

## Gate decision

The primitive is ready for owner review. Real eviction remains locked. Historical Hunter-Seeker writes, replay storage, imagery persistence, and historical RAG remain deferred until the owner explicitly approves this report and separately authorizes enabling production eviction.
