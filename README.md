# VoidCat Harness

VoidCat Harness is a local-first Windows desktop interface for GGUF UNITs downloaded through LM Studio. It discovers UNITs from the LM Studio library, runs them through the headless local runtime, and automatically ejects VoidCat-owned UNITs when the app closes.

## Launch

Double-click **VoidCat Harness** in this folder. The shortcut opens the Electron desktop app; LM Studio does not need to be open.

## Included systems

- Local UNIT discovery, initialization, streaming chat, and clean shutdown
- Persistent SQLite conversations, profiles, and operator-approved memories
- Relevance- and priority-ranked memory retrieval
- `remember this: ...` and `forget this: ...` chat commands
- Optional memory suggestions that always require approval
- Local RAG library for PDF, DOCX, TXT, and Markdown files
- Registered local folders with explicit, cancellable rescans; original folder files are never copied or deleted
- Persistent SQLite SimHash/LSH vector candidate index with bounded cosine reranking
- Clickable local citations that reopen the exact retrieved passage
- No fixed raw-file-size cap; memory, disk-reserve, passage-count, and folder-scan safety budgets prevent runaway indexing
- Web search through DuckDuckGo, Brave Search, or Tavily
- Per-conversation web modes: OFF, ASK, and AUTO
- ASK mode separates search-result discovery from selected-page fetching and cleaning
- Expandable web citations with title, URL, quoted evidence, and filtering notices
- Read-only diagnostics for the app, UNIT runtime, database, folder jobs, and vector-index coverage
- Opt-in passive Hunter-Seeker tools for tool-capable UNITs, with exact live observation citations
- Bounded Hunter-Seeker analysis jobs with visible progress, hard limits, and cancellation
- Approval-gated storage budgets with separate DB/WAL/vector/blob/replay accounting, capacity projection, and non-destructive cleanup previews
- Opt-in isolated Hunter-Seeker time-series history with entity/bounding-box/time queries, protected records, bounded downsampling, and clear LIVE/HISTORICAL labels
- Persistent aircraft, vessel, satellite, and geographic watchlists with protected, rate-limited trigger notifications
- Advanced per-feed error, throughput, baseline, silent-zero, AI-eligibility, and health-history display
- Budgeted JSONL situation-window recording and deterministic offline replay without provider requests
- Map right-click actions for guarded web research, active-UNIT analysis preparation, and contact or region watches
- Historical “what changed?” RAG over protected summaries and derived events, with selected document-library cross-references and transactional vector deletion

## Web safeguards

VoidCat allows only HTTP/HTTPS text pages. It blocks local/private network addresses, credentialed URLs, binary downloads, oversized responses, excess redirects, blocked domains, and destinations outside an optional allowlist. Webpage content is treated as untrusted evidence; instruction-like text is removed before it enters a UNIT's context.

DuckDuckGo works without a key. Brave Search and Tavily keys can be entered under **07 WEB ACCESS**. Keys are never returned to the interface after storage.

## Local data

Persistent chat and library data is stored under `.voidcat/data/voidcat.db`. Opt-in Hunter-Seeker history is isolated in `.voidcat/data/hunter/history.db`. Indexed document copies are stored under `.voidcat/library/files`.
Registered-folder documents remain in their original locations. VoidCat records only their paths, extracted passages, embeddings, and index metadata. Folder scans run one at a time, process files sequentially, preserve free-memory and 2 GB free-disk reserves, and skip links or paths that escape the selected folder. A scan also has explicit file, directory, elapsed-time, cumulative-source-size, and per-document passage budgets.

## Development

Requires Node.js 22.13 or newer.

Hunter-Seeker engineering references:

- First launch opens a resumable Hunter-Seeker setup guide; reopen it later with `SETUP` on the Situation Board. Provider secrets are stored only through Windows protected storage.

- `HUNTER_SEEKER_READINESS.md` — integration audit, scope, and primitive gates
- `DESIGN_TOKENS.md` — shared VoidCat visual contract
- `HUNTER_SEEKER_SMOKE_TEST.md` — bounded manual verification checklist
- `HUNTER_SEEKER_ADAPTERS.md` and `FEED_REGISTRY.md` — adapter and provider behavior
- `TOOL_REGISTRY.md` — shared P4 discovery, validation, rate-limit, and cost-recording contract
- `JOB_MANAGER.md` — shared P5 bounded execution, cancellation, progress, and resource-accounting contract
- `STORAGE_BUDGET_MANAGER.md` and `STORAGE_BUDGET_SYNTHETIC_REPORT.md` — P2 accounting, dry-run, backup, cancellation, and approval-gate contract
- `DATA_ATTRIBUTION.md` — provider and map credits

- `HISTORICAL_OBSERVATIONS_AND_RAG.md` — opt-in time-series retention, progressive downsampling, and historical summary-index contract
- `HUNTER_SEEKER_STAGE_FIVE.md` — watchlists, trigger limits, advanced health, right-click research, and bounded replay contract
- `OSINT_GATE_0_BASELINE.md` — pre-implementation regression baseline and Gate 1 entry conditions
- `OSINT_ARCHITECTURE_ASSESSMENT.md` — OSINT integration, process, credential, and storage boundaries
- `OSINT_PASSIVE_ONLY_POLICY.md` — enforced passive-research and authorization contract
- `OSINT_TEST_SAFETY.md` — disposable-database, provider-fixture, and resource-safety rules
- `OSINT_CORE_CONTRACTS.md` — Gate 1 schemas, provider boundary, policy, budgets, plans, normalization, and Hunter-Seeker intake

```powershell
npm install
npm run dev
npm run build
```
