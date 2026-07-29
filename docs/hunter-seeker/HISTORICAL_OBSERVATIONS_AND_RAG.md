# Hunter-Seeker Historical Observations and RAG

Status: implemented as an opt-in subsystem. Recording is off by default.

## Safety and storage boundary

Hunter-Seeker history is stored in `.voidcat/data/hunter/history.db`, separate from the shared conversation, memory, settings, and document-library database. The storage budget manager measures the history database and its WAL as separate physical components. Replay/maintenance backups are measured separately under the Hunter replay component. Historical vector rows are reported as logical vector ownership but are not added twice to the physical Hunter total.

Enabling history is an explicit interface action. Pausing history stops new writes without deleting existing history. Live contacts remain volatile and are labelled LIVE; stored results and citations are labelled HISTORICAL. The interface and query response warn that missing history is not proof of absence and that coverage begins only after the operator opted in.

Every ingest batch is bounded to 2,500 records, strips raw provider payloads before it reaches this subsystem, and must pass the Hunter high-watermark write guard. Initial database creation requires free disk headroom, occurs through a temporary database, runs SQLite `quick_check`, and is renamed into place only after validation.

## Time-series schema and queries

`history_observations_v1` stores normalized observation ID, entity ID/type, event time, coordinates, confidence, basis, full normalized provenance, attributes, recorded time, and retention class. Indexes support entity/time, source/time, latitude/longitude/time bounding boxes (including the antimeridian), and retention/time maintenance. Queries support entity, entity type, source, bounding box, start/end time, and bounded limits. Exact provenance remains attached to every result.

## Retention and progressive downsampling

- First 24 hours: keep every bulk observation.
- 24 hours to 7 days: keep one latest observation per entity/source/5-minute bucket.
- 7 to 30 days: keep one per hour.
- 30 days to the selected retention boundary: keep one per six hours.
- Beyond the selected boundary: expire bulk positions after producing a protected summary.

`pinned`, `watchlist`, `trigger`, `derived`, and `summary` records are never bulk maintenance candidates. Maintenance is manual and group-bounded, checks cancellation, creates and validates a replay backup first, uses bounded transactions, verifies source/vector consistency before every commit, yields between groups, and never runs `VACUUM`.

## Historical RAG contract

Raw positions are never embedded. Only `summary` and `derived` records enter the historical vector index. One protected summary or derived event is one chunk, capped at 8,000 characters; titles are capped at 200. Source feed IDs and observation IDs are deduplicated and bounded.

Pending records are embedded in bounded batches only when a historical natural-language query is made, so enabling recording does not load a model. The index uses VoidCat's local deterministic SimHash/LSH and cosine re-ranking. Search can cross-reference operator-selected registered libraries and, separately, uploaded files. Results preserve their origin so the interface and active UNIT distinguish HISTORICAL summaries from LIBRARY passages.

Source and vector deletion is transactional: buckets, vector, and source record are deleted together, and an orphan check must pass before commit. Downsampling runs the same check for every group.

## Local API

- `GET/PATCH /api/hunter-seeker/history/settings`
- `POST /api/hunter-seeker/history/query`
- `POST /api/hunter-seeker/history/search`
- `POST /api/hunter-seeker/history/derived`
- `GET /api/hunter-seeker/history/maintenance/plan`
- `POST /api/hunter-seeker/history/maintenance`
- `PATCH /api/hunter-seeker/history/observations/:observationId`
- `DELETE /api/hunter-seeker/history/rag/:recordId`

## Test boundary

History schema, ingest, query, vector, deletion, downsampling, backup, protected-record, and cancellation tests use disposable operating-system temporary directories. They do not open, migrate, stress, prune, or write the operator's real database.
