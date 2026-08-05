# VoidCat Harness

[![CI](https://github.com/iamnotnotacat/VoidCat-Harness/actions/workflows/ci.yml/badge.svg)](https://github.com/iamnotnotacat/VoidCat-Harness/actions/workflows/ci.yml)
[![License: CPAL-1.0](https://img.shields.io/badge/License-CPAL--1.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/iamnotnotacat/VoidCat-Harness?display_name=tag)](https://github.com/iamnotnotacat/VoidCat-Harness/releases)

VoidCat Harness is a local-first Windows desktop interface for private GGUF chat, RAG, voice, bounded web research, live Hunter-Seeker mapping, and structured passive OSINT investigations. It can use GGUF UNITs downloaded through LM Studio without requiring the LM Studio window to remain open, and it ejects VoidCat-owned UNITs when the application closes.

## Download and run

VoidCat currently targets 64-bit Windows 10 and 11.

1. Download the `VoidCat-Harness-v1.0.0-windows-x64.zip` file and its `.sha256` file from [GitHub Releases](https://github.com/iamnotnotacat/VoidCat-Harness/releases).
2. Verify the checksum if desired:

   ```powershell
   Get-FileHash .\VoidCat-Harness-v1.0.0-windows-x64.zip -Algorithm SHA256
   ```

3. Extract the complete archive to a normal writable folder. Do not run the executable from inside the ZIP.
4. Open `VoidCat Harness.exe` inside the extracted folder.

The first public build is portable and unsigned, so Windows may display a publisher warning. Confirm that the archive came from this repository and that its SHA-256 value matches the published checksum before running it.

### Runtime requirements

- Node.js 22.13 or newer. Node.js 24 is recommended.
- LM Studio installed when using its headless `lms` runtime to load local GGUF UNITs. The LM Studio interface does not need to be open.
- Enough free disk and memory for the selected UNIT, indexed documents, and configured project budgets.
- Internet access only for features you explicitly enable, such as provider pulls, web search, RSS, or model downloads.

Open **APP SETTINGS** to select model folders or run targeted/full GGUF scans. Existing LM Studio libraries are detected automatically, and additional folders can be registered without copying the model files.

## Major capabilities

### Local intelligence interface

- Local UNIT discovery, initialization, streamed chat, settings, clean shutdown, and diagnostics.
- Live resource command center for CPU/GPU, RAM, disk, request traffic, UNIT context, RAG, source cadence, storage budgets, and managed jobs, with profiles, module controls, automatic throttling, and a non-destructive emergency stop.
- Persistent SQLite conversations, profiles, operator-approved memories, import/export, projects, and validated backups.
- Inspectable context and tool selection for every Command transmission.
- Toggle-to-talk using packaged local Whisper speech recognition plus interruptible Windows speech voices.

### RAG and memory

- PDF, DOCX, TXT, and Markdown libraries plus registered local folders.
- Cancellable, bounded scans with local embeddings, persistent vector candidates, cosine reranking, and clickable passage citations.
- Multiple selectable libraries, explicit memory approval, relevance/importance retrieval, and `remember this` / `forget this` commands.
- Original registered-folder files are never copied, moved, or deleted.

### Web and news

- DuckDuckGo, Brave Search, or Tavily with per-conversation OFF, ASK, and AUTO modes.
- Selected-page fetching and cleaning with titles, URLs, quoted evidence, and prompt-injection filtering notices.
- Explicit-pull RSS News Watch and a searchable OSINT4All directory.

### Hunter-Seeker

- Screen-aware live map, source matrix, cached restoration, configurable cadences, provider health, and explicit LIVE/CACHED/STALE/DEGRADED freshness.
- Aircraft, maritime, satellite, seismic, weather, infrastructure, and region-loaded DeFlock data with provider attribution and bounded traffic.
- Opt-in time-series history, historical RAG summaries, watchlists, geofences, protected trigger records, snapshots, and deterministic replay.
- Seven cited read-only Hunter-Seeker tools exposed to the active UNIT through the shared registry and bounded job manager, including normalized cross-provider events in a bounding box.

The Expansion Source Catalog contains installed bounded adapters for all 41 registered Hunter-Seeker sources. Seven sources are scheduler-driven live-board feeds; the remaining 34 run only after an operator opens a catalog entry and supplies its required viewport, point, time window, search term, station/resource ID, or protected credential. Successful query observations join the map, optional history subscriber, and active UNIT evidence context with observation IDs, provenance, confidence, freshness, licensing, and coverage limitations. Catalogue-only sources return official references and never pretend metadata is a live event.

Credentialed source values remain inside Electron's protected provider broker. GDELT Event Database access uses an operator-owned Google Cloud project and OAuth token to query the official public BigQuery table with named parameters and a 5 GB billed-byte ceiling. NCEI daily summaries require one exact station ID; OpenStreetMap Overpass permits only the interface's fixed feature whitelist. Live adapter checks are deliberately separate from `npm test`: `npm run test:source-query-live` performs one bounded, no-credential request per public query adapter and does not load a UNIT or write a database.

### Structured passive OSINT

- Isolated investigations with archived evidence, atomic observations, a temporal entity graph, reversible identity links, contradictions, confidence explanations, hypotheses, forecasts, and candidate leads.
- Synchronized entity cockpit, explainable evidence inspector, operator-editable bounded collection plans, persistent identity-resolution queue, and evidence-cited comparisons between repeated investigations.
- Deterministic pattern, source-lineage, geospatial, information-gap, quality, and calibration analysis with a six-role MAGI assessment that preserves disagreement.
- DeFlock, SearXNG, local similarity generation, Shodan, Censys, and explicitly authorized HIBP exposure checks.
- Individually selectable active-UNIT intelligence tools, fixed policy limits, cache/rate state, job progress and cancellation, evidence identifiers, cited reports, and controlled depth-one expansion.
- Deliberate Hunter-Seeker-to-OSINT investigation drafts and review-only candidate returns.

See the [persistent intelligence model](docs/osint/INTELLIGENCE_MODEL.md) for the evidence, analysis, and operator contracts.

VoidCat is intended for lawful, authorized, passive research. It prohibits scanning, exploitation, credential guessing, recursive autonomous research, and unapproved exposure checks. See the [passive-only policy](docs/osint/OSINT_PASSIVE_ONLY_POLICY.md).

## Privacy and network behavior

The default contract is:

- Chats, approved memories, embeddings, documents, projects, and local voice stay on the computer.
- Only explicit web searches, provider requests, feed pulls, and enabled model downloads leave the computer.
- Search providers receive the bounded query, not the full conversation.
- External capabilities are visibly indicated and individually selectable before a UNIT transmission.
- Retrieved context, memories, evidence, credentials, and storage budgets remain inspectable or manageable through the interface.
- Provider content is treated as untrusted evidence and is never accepted as an application instruction.
- Per-source request ceilings, user cadence, caching, concurrency limits, and cancellation protect both the computer and upstream services.

Report vulnerabilities privately according to [SECURITY.md](SECURITY.md). Never put credentials, personal databases, private documents, model weights, or investigation evidence in a public issue.

## Local data

Packaged builds store mutable data outside the application directory under Electron's Windows user-data folder:

```text
%APPDATA%\voidcat-harness\workspace\.voidcat\
```

Development runs use `.voidcat\` inside the repository. The application exposes its active paths in **DIAGNOSTICS**; use that screen rather than assuming a path before backup or recovery work.

The main database, Hunter-Seeker history, OSINT investigation store, vector indexes, document blobs, and replay files have separate scopes and budgets. Cleanup is typed and bounded so Hunter-Seeker or OSINT cleanup cannot select conversations, approved memories, or RAG data. Never copy a live database while a write or migration is active; use the application's validated backup controls.

## Build from source

```powershell
git clone https://github.com/iamnotnotacat/VoidCat-Harness.git
cd "VoidCat-Harness"
npm ci
npm test
npm run dev
```

`npm run dev` opens the local development server. Use `npm run desktop` in another terminal for the Electron shell when needed.

To create the portable Windows application:

```powershell
npm run package:windows
```

Packaging builds the interface, prepares the pinned local Whisper runtime/model, creates `release\VoidCat Harness-win32-x64\`, trims development-only runtime files, and refreshes the checkout-local `VoidCat Harness.lnk`. Release folders, caches, runtime data, downloaded models, and shortcuts are intentionally ignored by Git.

The tagged GitHub workflow runs the complete regression suite, packages the Windows x64 directory, creates a ZIP and SHA-256 checksum, and attaches both to the release. Large application archives belong in GitHub Releases, never in repository history.

## Testing and contribution

```powershell
npm test
```

The default suite performs strict type checking, linting, offline-safe unit/integration tests, and a production build. It does not load a UNIT, contact live intelligence providers, mutate a user's database, or run stress tests against real data. Live checks remain separate and bounded; any model integration test must use a UNIT smaller than 7 GB.

Additional release smoke checks are explicit rather than part of the offline suite:

```powershell
npm run test:desktop-server
npm run package:windows
npm run test:package-runtime
$env:VOIDCAT_LIVE_UNIT_TEST="1"; npm run test:unit-live
```

The live UNIT smoke check refuses to run while any other LM Studio UNIT is loaded, selects the smallest eligible tool-capable local UNIT between 1 GB and 7 GB, uses a 2,048-token context, works from a disposable VoidCat data root, and verifies ejection before it exits. The packaged-runtime check must be run after packaging and proves that the ASAR release can start its authenticated local backend and serve the built renderer.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes. Technical contracts, operator guides, smoke tests, and historical audit evidence are organized under [`docs/`](docs/README.md). The Markdown files are documentation; executable tests live under [`tests/`](tests/).

## License and notices

VoidCat Harness is open-source software licensed under the [Common Public Attribution License 1.0](LICENSE). CPAL requires source availability for distributed modifications and external deployments, plus the modest launch attribution defined in Exhibit B: `Copyright (c) 2026 iamnotnotacat`, the phrase `www.iamnotnotacat.com`, its URL, and the supplied VoidCat graphic. The SUPPORT_VC page is VoidCat's dedicated expanded attribution and support area. See the [attribution operator note](docs/operator/CPAL_ATTRIBUTION.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
