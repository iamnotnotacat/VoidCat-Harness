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
- Persistent SQLite conversations, profiles, operator-approved memories, import/export, projects, and validated backups.
- Inspectable context and tool selection for every Command transmission.
- Push-to-talk and toggle-to-talk using packaged local Whisper speech recognition plus interruptible Windows speech voices.

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
- Six cited read-only Hunter-Seeker tools exposed to the active UNIT through the shared registry and bounded job manager.

### Structured passive OSINT

- Isolated investigations, normalized evidence, entity/alias correlation, temporal changes, contradictions, confidence explanations, and candidate leads.
- DeFlock, SearXNG, local similarity generation, Shodan, Censys, and explicitly authorized HIBP exposure checks.
- Fixed policy limits, cache/rate state, job progress and cancellation, evidence identifiers, cited reports, and controlled depth-one expansion.
- Deliberate Hunter-Seeker-to-OSINT investigation drafts and review-only candidate returns.

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

Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes. Technical contracts, operator guides, smoke tests, and historical audit evidence are organized under [`docs/`](docs/README.md). The Markdown files are documentation; executable tests live under [`tests/`](tests/).

## License and notices

VoidCat Harness is open-source software licensed under the [Common Public Attribution License 1.0](LICENSE). CPAL requires source availability for distributed modifications and external deployments, plus the modest launch attribution defined in Exhibit B: `Copyright (c) 2026 iamnotnotacat`, the phrase `www.iamnotnotacat.com`, its URL, and the supplied VoidCat graphic. The SUPPORT_VC page is VoidCat's dedicated expanded attribution and support area. See the [attribution operator note](docs/operator/CPAL_ATTRIBUTION.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
