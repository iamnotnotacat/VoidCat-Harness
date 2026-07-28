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
3. Reopen the application and confirm no interrupted Hunter-Seeker job or observation history is presented as persistent.

## Recorded closeout run — 2026-07-27

- Automated gate: 85 tests passed; lint, TypeScript no-emit validation, Electron syntax checks, production build, design-token enforcement, typography floor, responsive contracts, restart persistence, persisted onboarding Skip behavior, provider credential lifecycle, P4 registry limits, P5 cancellation/subscription, empty-result evidence envelopes, and the six-tool managed UNIT integration passed.
- Rendered gate: Hunter-Seeker displayed the six-source matrix, freshness legend, live map, category register, custom OpenFreeMap/OpenMapTiles/OpenStreetMap attribution, source timings, cached states, and setup entry without runtime console errors.
- Responsive gate: at 1024 × 700 the page had no horizontal overflow and no visible text below 10px.
- Local UNIT gate: only Qwythos 9B Q4_K_M (6.10 GB) was loaded, at a 4,096-token context. A live feed-health request entered the managed tool loop and returned exact `[HS:feed-health:…]` citations for every source fact. The 32K context boundary is covered synthetically by the same integration test without loading another model.
- Shutdown gate: the 6.10 GB UNIT was ejected after the test and the interface reported `CORE OFFLINE`.
- Re-audit gate: the loopback job-status event stream emitted an initial live job snapshot, and an empty aircraft query returned IDs, provenance, confidence, freshness, and coverage limitations without loading a UNIT.
