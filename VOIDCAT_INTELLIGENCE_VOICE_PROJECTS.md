# VoidCat Intelligence, Voice, Projects, and Distribution

Verified: 2026-07-28

## Command intelligence architecture

The Command interface exposes an operator-controlled capability matrix. A tool-capable active UNIT receives only the exact tools enabled for that transmission. The server intersects the requested names with immutable shared-registry discovery, rejects disabled calls, applies each tool's schema and rate limit, and runs Hunter-Seeker and OSINT work through the shared job manager.

The 23 selectable capabilities are grouped as follows:

- 6 Hunter-Seeker read tools for aircraft, vessels, satellite passes, seismic events, and feed health.
- 12 high-level OSINT investigation tools. The UNIT cannot select arbitrary providers; passive policy, credentials, authorization, budgets, cache, and provider choice remain server-controlled.
- 5 VoidCat knowledge tools for active-project memory, RAG, Hunter history, the local OSINT4All directory, and bounded news feeds.

Hunter findings must cite `[HS:observation-id]`, OSINT evidence must cite `[EV:evidence-id]`, and VoidCat knowledge must cite `[VC:record-id]`. Factual sentences that do not satisfy the active citation contract are marked unsupported. Tool outputs retain provenance, freshness, confidence or relevance information, and coverage limitations.

## Traffic and denial-of-service controls

- External tools are visibly labeled in the Command matrix and remain disabled unless selected.
- Provider requests use fixed destinations, bounded bodies and responses, timeouts, concurrency limits, conditional caches, retry windows, and per-tool/provider rate limits.
- Search providers receive a bounded query, never the whole conversation.
- Hunter source cadence and local request-budget controls cannot exceed fixed provider ceilings.
- News is explicit-pull only, runs at most two feed requests concurrently, caps each response at 1 MB, and holds repeated manual pulls for 30 seconds.
- Hugging Face search is explicit, cached for ten minutes, limited to one request per two seconds, and capped at 1 MB even for chunked responses.
- Model downloads require confirmation, 10 GB of free-disk headroom, managed-job cancellation, bounded progress metadata, and a six-hour wall-clock limit.
- HIBP requires separate exact-target operator authorization and cannot expand automatically.

## Projects

`12 PROJECTS` creates and reopens persistent project workspaces. Conversations and approved memories are scoped to the active project. Each project has separate adjustable allotments for chat-plus-memory and persistent OSINT UNIT summaries. Limits cannot be lowered below current use. Project export is inspectable JSON; import always creates a new project and never overwrites an existing one.

Source-checkout data lives under `.voidcat`. The packaged app stores durable data in the Electron user-data workspace, outside the portable application folder, so replacing the executable does not wipe projects.

## Voice

`14 APP SETTINGS` configures local voice. Push-to-talk and toggle-to-talk capture at most two minutes, resample to 16 kHz mono PCM, and send the bounded WAV only to the protected Electron main process. A user-selected `whisper.cpp` executable and local `.bin` model perform transcription. Temporary audio and transcript files are removed after every attempt.

Windows local speech is sentence-buffered, speed-adjustable, and interrupted before microphone capture begins. The four profiles are computerized male, computerized female, original tactical commander, and original high-energy pilot. The latter two are original style profiles; VoidCat does not clone or impersonate named performers or copyrighted characters.

Always-listening mode is intentionally deferred. Voice remains local unless a future operator explicitly configures a cloud provider.

## News and directory

`13 NEWS WATCH` aggregates five fixed RSS/Atom sources with explicit source toggles, caching, status, search, attribution, and direct headline links. The OSINT4All board has no dedicated news category, so current-event/live-awareness entries are identified from the complete captured catalog and shown as direct external links; they are not scraped in the background.

`11 OSINT DIRECTORY` contains all 387 links captured from the referenced OSINT4All board, with categories, VoidCat descriptions, natural-language aliases, warnings, and safe external opening.

## Settings and acquisition

- `14 APP SETTINGS`: voice, validated backups, project import/export, optional authenticated LAN access, and the privacy contract.
- `15 UNIT SETTINGS`: temperature, top-p, repeat penalty, maximum response tokens, context window, Hugging Face GGUF search/download, Ollama library/pull, download progress, cancellation, and Unit Bank rescan.

Ollama models remain in Ollama's separate runtime library. Hugging Face GGUF downloads use LM Studio's headless `lms get` command and appear in Unit Bank after rescan. LM Studio's graphical application is not opened.

## Backup, migration, LAN, and packaging

Main-database schema changes require free-disk headroom, a successful SQLite quick-check, a checkpointed backup, and validation of the copied database before DDL. OSINT and Hunter migrations retain their isolated disposable-test and active-write protections. Routine cleanup never performs a full `VACUUM`.

LAN access is off by default. Enabling it binds to the LAN only after restart and requires a protected random token exchanged for an HttpOnly, SameSite=Strict cookie. It is plain HTTP, not transport encryption, and is suitable only for a trusted private network.

`npm run package:windows` builds the portable Windows folder under `release/VoidCat Harness-win32-x64`. The executable is currently unsigned; public distribution should use an Authenticode code-signing certificate to reduce security-product warnings and establish publisher identity.

## Verified acceptance

- 230 existing unit/integration tests passed.
- 6 Phase 5/6 project, voice, news, privacy, and traffic-safety tests passed.
- Production dependency audit reported zero known vulnerabilities.
- Portable package built and launched; health, one project, and all 23 capabilities were discovered.
- Portable size was reduced from 694 MiB to 436 MiB by excluding build caches, browser-build-only dependencies, and unused Electron locales.
- A 6.10 GiB tool-capable UNIT was loaded with a 4,096-token context, invoked selected Hunter and local-directory capability groups, returned exact Hunter citations, and was explicitly unloaded. `lms ps` confirmed no model remained loaded.
