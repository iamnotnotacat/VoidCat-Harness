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
- Operator-controlled DeFlock/OpenStreetMap ALPR camera layer with bounded viewport loading, dedicated map icons, exact record links, and explicit crowdsourced-coverage warnings
- Passive OSINT provider matrix for DeFlock, SearXNG, local OpenSquat-style similarity, Shodan, Censys, and strictly authorized HIBP exposure checks
- Twelve bounded active-UNIT OSINT tools with fixed server-side provider policy, managed progress/cancellation, context limits, exact evidence citations, and unsupported-finding labels
- Persistent OSINT Investigation workspace with plan and budget preview, managed live jobs, history, evidence and confidence review, entity graph, candidate approval, and cited report export
- Searchable OSINT4All directory with 387 externally opened tools, VoidCat-authored descriptions, category filters, source attribution, and safety labeling
- Historical “what changed?” RAG over protected summaries and derived events, with selected document-library cross-references and transactional vector deletion
- Per-transmission Command capability matrix with 23 independently selectable Hunter-Seeker, OSINT, project-memory, RAG, history, directory, and news tools
- Persistent project workspaces with separate chat/memory and OSINT-memory allotments, usage meters, export, and non-overwriting import
- Local push-to-talk and toggle-to-talk through user-configured whisper.cpp, plus interruptible sentence-buffered Windows voices
- Explicit-pull RSS News Watch with source toggles, bounded caching, attribution, and OSINT4All current-event links
- Separate App Settings and UNIT Settings for privacy, backups, optional authenticated LAN, sampling, context, and managed model acquisition
- Portable Windows packaging through `npm run package:windows`; packaged data is stored outside the application folder

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
- `OSINT_MOCKED_VERTICAL_SLICE.md` — Gate 2 deterministic offline investigation, correlation, confidence, candidate leads, and cited report
- `OSINT_GATES_0_2_AUDIT.md` — formal requirement-by-requirement readiness audit and current verified test baseline
- `OSINT_GATE_5_CORRELATION_CONFIDENCE.md` — explainable identity correlation, temporal change, contradictions, source independence, confidence, and schema-v2 safety
- `OSINT_GATE_6_CONTROLLED_EXPANSION.md` — depth-one candidate evaluation, cycle and duplicate suppression, budget reservations, and explicit next-step approval
- `OSINT_GATE_7_HUNTER_SEEKER_INTEGRATION.md` — deliberate Hunter-to-OSINT drafts, provenance preservation, and review-only candidate returns
- `OSINT_GATE_8_ACTIVE_UNIT_TOOLS.md` — bounded active-UNIT OSINT tools, managed jobs, cancellation, context limits, and evidence-citation enforcement
- `OSINT_GATE_9_INVESTIGATION_UI.md` — investigation planning, managed progress, persistent evidence review, graph analysis, candidate approval, and report-export contract
- `OSINT_GATE_10_HARDENING_ACCEPTANCE.md` — release hardening matrix, acceptance commands, and verification boundaries
- `OSINT_OPERATOR_GUIDE.md` — provider configuration, safe investigation operation, recovery, export, and cleanup guide
- `OSINT_DIRECTORY.md` — OSINT4All snapshot scope, operator behavior, attribution, safety boundary, and refresh procedure
- `OSINT_GATE_4_PROVIDERS.md` — live-provider boundaries, DeFlock map behavior, credential controls, and the operator smoke test
- `VOIDCAT_INTELLIGENCE_VOICE_PROJECTS.md` — capability selection, traffic safety, projects, local voice, news, settings, packaging, and verified acceptance

```powershell
npm install
npm run dev
npm run build
npm run package:windows
```
