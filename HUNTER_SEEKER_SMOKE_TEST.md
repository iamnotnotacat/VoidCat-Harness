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

## Shutdown

1. Close VoidCat Harness while a source is active.
2. Confirm the process exits, maritime disconnects, volatile observations clear, and VoidCat-owned UNITs are ejected.
3. Reopen the application and confirm no interrupted Hunter-Seeker job or observation history is presented as persistent.
