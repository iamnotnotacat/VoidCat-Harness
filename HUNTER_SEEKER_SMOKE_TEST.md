# VC Hunter-Seeker smoke test

Use this checklist after Hunter-Seeker renderer, source, Electron bridge, or scheduler changes. It deliberately avoids load testing and never runs against the user's persistent database with synthetic data.

## Automated baseline

1. Close VoidCat Harness before testing Electron preload or main-process changes.
2. Run `npm test`.
3. Confirm lint, unit tests, the production renderer build, and the 10px typography floor pass.
4. Run `npx tsc --noEmit` and the Electron script syntax checks.

## Launch and containment

1. Launch from `VoidCat Harness.cmd`; do not open the LM Studio application.
2. Confirm only one VoidCat window opens.
3. Open Hunter-Seeker and confirm the rest of VoidCat remains navigable if the map is still loading.
4. Confirm the map uses the local themed fallback if OpenFreeMap cannot load.
5. Confirm map attribution remains visible in the custom footer.

## Live sources

1. Confirm the matrix contains the six approved sources and no deferred providers.
2. Confirm each enabled pull source reaches a healthy, degraded, or rate-limited state without blanking the screen.
3. Confirm military aircraft are red and civil/unclassified aircraft are blue.
4. Confirm weather geometry, seismic events, and propagated station positions appear with category icons.
5. Confirm OpenSky shows credit balance, estimated refill, and next network request information when supplied.

## Controls and cache behavior

1. Move each pull-rate slider once and confirm Hunter-Seeker remains rendered.
2. Turn each source off; verify its contacts disappear without affecting other layers.
3. Turn it back on before its selected cadence expires; verify the latest snapshot returns immediately.
4. Use Refresh Now inside a provider floor; verify cached data remains visible and no held-request error modal appears.
5. Confirm provider floors, retry-after instructions, failure backoff, and hard hourly ceilings are still enforced.
6. Use global Disconnect; verify all volatile contacts are cleared.
7. Confirm every enabled source shows a readable `LAST` and `NEXT` time, or an honest `NEVER` / `UNSCHEDULED` state.
8. Confirm the summary, source card, recent-event row, selected-contact record, and map agree on `LIVE`, `CACHED`, `STALE`, or `DEGRADED` freshness.
9. Confirm cached and stale map contacts visibly dim while category colors and icon shapes remain recognizable.

## Maritime

1. With no saved key, enable maritime and confirm the official credential prompt appears.
2. Cancel and confirm the source remains off.
3. With a valid saved key, connect one bounded region and verify contacts populate progressively.
4. Change the display cadence and confirm no black screen, duplicate batch growth, or marquee restart.
5. Toggle maritime off and on in the same region; verify its cached snapshot returns immediately.
6. Change regions; verify the previous region's contacts clear before the new subscription populates.

## Contact presentation

1. Select one contact from every active category.
2. Confirm source, position, timestamp, confidence or certainty, and staleness are visible.
3. Confirm provider links open in the system browser.
4. Resize the app to its minimum supported size and confirm the map, source matrix, event list, and details remain usable without a page-wide gray scrollbar.
5. Confirm overflowing opt-in labels scroll smoothly right-to-left and reduced-motion mode disables the marquee.

## Managed UNIT tools

1. Initialize a UNIT whose inspection panel shows `TOOLS READY`.
2. In Command, set `HUNTER` to `ON`; confirm non-tool-capable UNITs keep this selector disabled.
3. Ask for current aircraft in an area, an aircraft by callsign or ICAO, vessels in the selected AIS region, satellite passes over an area, recent seismic events, or feed-health information.
4. Confirm `MANAGED JOBS` shows bounded progress, iteration/call counts, and a cancel control while analysis runs.
5. Cancel one active job and confirm it becomes cancelled; if cleanup is still unwinding, confirm `CLEANUP GUARDED` remains visible and no replacement work stacks on top of it.
6. Confirm tool-backed factual findings contain exact `[HS:...]` observation citations. An invented or missing citation must produce a grounding-failure response instead of an unsupported finding.
7. Confirm empty tool results are described as a bounded current snapshot and not as proof that an entity or event does not exist.
8. Confirm vessel results state the selected AIS region and bridge freshness, while no credential value appears in requests, results, job records, or the renderer.
9. Load the same tool-capable UNIT at 4K and 32K context settings and confirm the managed request reports bounded evidence without exceeding the selected window.

## Shutdown

1. Close VoidCat Harness while a source is active.
2. Confirm the process exits, maritime disconnects, volatile observations clear, and VoidCat-owned UNITs are ejected.
3. With history disabled, reopen the application and confirm no live snapshot is presented as persistent. With history explicitly enabled, confirm only the HISTORICAL counter/results survive and all live contacts are reacquired from their sources.

## Opt-in history and historical RAG

1. Confirm the History console starts `OPT-IN OFF`, then enable it and verify the retention card changes to `HISTORY ON`.
2. Allow a live source to publish twice. Query its entity and confirm historical results are labelled `HISTORICAL` while the map/register remain `LIVE` or freshness-labelled.
3. Ask “what changed?” in the history console. Confirm results cite source observation IDs and that selected knowledge libraries appear separately as `LIBRARY` results.
4. Pause recording, refresh live sources, and confirm the historical count no longer increases while live contacts continue.
5. Pin a disposable historical record through the API, inspect the maintenance dry plan, run a bounded maintenance pass only on test data, and confirm the pinned record remains and vector consistency reports zero orphans.

## Stage 5 targeting and triggers

1. Open `TARGETS`, add one rule for each identifier type, and add a 25 km geographic rule. Disable and re-enable one rule, restart VoidCat, and confirm the states survive.
2. Export the rules, import the unmodified file, and confirm it is accepted. Change a value without recalculating the checksum and confirm the import is rejected.
3. Right-click a contact and confirm contact search, cleaned research, active-UNIT analysis preparation, and contact watch are offered. Right-click empty map space and confirm region research and a 25 km watch are offered.
4. Confirm no web request occurs merely by opening the context menu. Select research and verify the normal domain, response-size, private-network, and untrusted-page safeguards still apply.
5. Exercise a disposable watch/geofence and confirm entry, exit, match, emergency, loiter, or reappearance events appear in the Trigger tab and the in-app notification center. Acknowledge one event.
6. Confirm repeated identical observations do not create rapid duplicate notifications and the trigger log never exceeds its documented bounded retention.
7. With opt-in history enabled, confirm a triggered observation reports protected retention and survives a disposable maintenance pass.

## Advanced health and offline replay

1. Open the Health tab and confirm every current source shows error rate, records/hour, expected baseline, silent-zero, status, and AI eligibility.
2. Use a synthetic or safely unavailable source to verify a sustained failure/zero state becomes `DEGRADED` and is marked excluded from UNIT context while healthy sources continue.
3. Record a one-minute replay window, allow live observations to arrive, and stop it. Confirm a JSONL/manifest pair appears with record and byte counts.
4. Play the completed replay and confirm the board is labelled `OFFLINE REPLAY`, live provider refreshes are not invoked by playback, and `RETURN TO LIVE` restores the current snapshot.
5. Confirm a modified replay file fails checksum validation rather than partially loading.

## Recorded closeout run — 2026-07-27

- Automated gate: 105 tests passed; lint, TypeScript no-emit validation, Electron syntax checks, production build, design-token enforcement, typography floor, responsive contracts, restart persistence, persisted onboarding Skip behavior, provider credential lifecycle, P4 registry limits, P5 cancellation/subscription, empty-result evidence envelopes, the six-tool managed UNIT integration, and P2 disposable-database safety tests passed.
- Rendered gate: Hunter-Seeker displayed the six-source matrix, freshness legend, live map, category register, custom OpenFreeMap/OpenMapTiles/OpenStreetMap attribution, source timings, cached states, and setup entry without runtime console errors.
- Responsive gate: at 1024 × 700 the page had no horizontal overflow and no visible text below 10px.
- Local UNIT gate: only Qwythos 9B Q4_K_M (6.10 GB) was loaded, at a 4,096-token context. A live feed-health request entered the managed tool loop and returned exact `[HS:feed-health:…]` citations for every source fact. The 32K context boundary is covered synthetically by the same integration test without loading another model.
- Shutdown gate: the 6.10 GB UNIT was ejected after the test and the interface reported `CORE OFFLINE`.
- Re-audit gate: the loopback job-status event stream emitted an initial live job snapshot, and an empty aircraft query returned IDs, provenance, confidence, freshness, and coverage limitations without loading a UNIT.

## Stage 5 automated closeout — 2026-07-28

- Full gate: 127 tests passed, followed by a successful production renderer build, TypeScript no-emit validation, and Electron main/preload/maritime syntax checks.
- Disposable-only gate: watchlist, trigger, health-history, rate-limit, and replay tests used temporary databases and directories; no UNIT was loaded and the user database was never opened by synthetic tests.
- Replay gate: manifest checksum, JSONL round trip, deterministic repeated playback, storage pre-write accounting, and zero playback API calls passed.
- Grounding gate: an unhealthy synthetic source was excluded from UNIT evidence while the feed-health tool returned error, throughput, baseline, silent-zero, and AI-eligibility fields.
