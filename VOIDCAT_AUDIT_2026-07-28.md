# VoidCat Harness audit — 2026-07-28

## Result

VoidCat passes its complete automated regression, strict TypeScript check, lint check, production web build, Windows desktop packaging, disposable UI route sweep, and bounded live DeFlock smoke check. The audit did not load a UNIT, so it did not violate the rule that any model used for testing must be smaller than 7 GB.

## Verification record

| Area | Verification | Result |
| --- | --- | --- |
| Static correctness | Strict TypeScript with unused-code checks | PASS |
| Code quality | ESLint over tracked source | PASS |
| Automated behavior | 250 tests across chat infrastructure, RAG, memory, web, Hunter-Seeker, OSINT, storage, projects, voice, settings, and support | PASS |
| Production frontend | Vite production build | PASS |
| Desktop distribution | Electron Windows x64 package | PASS |
| UI routing | All 16 navigation destinations rendered in a disposable desktop-equivalent session | PASS |
| Screen fit | Every audited page fit a 1280 × 720 viewport without a page-level scrollbar | PASS |
| Renderer stability | No new renderer errors after the disposable preview remained available | PASS |
| Voice runtime | Checksum-pinned Whisper 1.9.1 runtime loads its CPU backend | PASS |
| DeFlock live source | One worldwide index request plus one selected-region request; 52 region hubs and 5,384 normalized cameras returned | PASS |
| Launcher | Shortcut resolves to Windows command host, checked launcher, and current packaged executable | PASS |

## Repairs and performance work

- The Windows launcher now prefers the packaged desktop executable. The development Electron runtime is only a pre-package fallback.
- The generated shortcut no longer relies on a OneDrive Desktop target that Windows can rewrite incorrectly.
- The main test command now includes strict TypeScript checking, exposing implementation errors that transpile-only tests could miss.
- Generated release, cache, vendor, work, runtime-data, and packaging directories are excluded from type checking.
- Active RAG folder scans poll a lightweight folder-status endpoint once per second instead of reloading the entire application state every 800 ms.
- Hunter-Seeker map freshness is passed as a memoized object instead of repeatedly encoding and parsing a signature string.
- Hunter-Seeker GeoJSON is built once per state change, and DeFlock camera/region/live features are partitioned in one pass.
- DeFlock region and camera counts, source lookup, and freshness lookup are memoized.
- Heavy secondary screens are loaded on demand. The initial JavaScript payload fell from 460.42 KB to 254.52 KB, a reduction of approximately 45%.
- The bundled Whisper distribution retains only the executable and DLLs required for local transcription.
- Windows packaging removes source maps and TypeScript declarations from packaged dependencies only; licenses, JavaScript, native modules, PDF resources, fonts, WASM, and source-project files remain intact. Packaged PDF and Vite runtime imports were verified afterward.
- Temporary audit runtimes, obsolete zero-byte development logs, stale TypeScript build metadata, and the unused Wrangler cache were removed. Persistent `.voidcat` data was not changed.

## Size results

- Previous Windows package: approximately 488.84 MiB.
- Audited Windows package: 445.47 MiB.
- Package reduction: approximately 43.37 MiB (8.9%).
- Bundled voice runtime: 40.03 MiB with one executable (`whisper-cli.exe`).
- Vite temporary cache files in the package: zero.
- Development-only dependency maps and declarations in the package: zero (373 files / 30.63 MiB removed).

Electron itself remains the largest part of the package. MapLibre is isolated in Hunter-Seeker's lazy-loaded bundle, so its approximately 1 MiB JavaScript chunk is not loaded by the other app screens.

## External and hardware-dependent limits

Provider adapters, cache/rate-limit behavior, cancellation, malformed-response handling, and credential isolation pass fixture and integration tests. Only DeFlock received a live network smoke request during this audit. Credentialed providers were not called because no test credentials were supplied and exercising them unnecessarily would violate VoidCat's bounded-traffic policy.

No local model inference was run. The configured LM Studio hub currently exposes model manifests but no directly discoverable GGUF files at that path, and loading a model was unnecessary for infrastructure verification. When an actual inference smoke test is requested, VoidCat must select a discovered UNIT below 7 GB.

## Preserved user data

The audit did not delete or rewrite conversations, memories, projects, RAG sources, vectors, Hunter history, credentials, downloaded models, or the real `.voidcat` database.
