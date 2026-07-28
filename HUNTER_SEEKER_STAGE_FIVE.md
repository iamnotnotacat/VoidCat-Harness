# Hunter-Seeker Stage 5: beyond nowcast

Stage 5 adds operator-controlled targeting, automated trigger evaluation, advanced source-health history, and bounded offline replay. It does not add a new model lane, provider credential, or background web crawler.

## Watchlists and geofences

The persistent targeting console is opened with `TARGETS` on the Situation Board. Rules support exact aircraft ICAO addresses, callsigns, tail numbers, vessel MMSIs, satellite NORAD IDs, and circle or bounding-box geographic areas. Identifiers are normalized before exact matching. Rules can be armed, disabled, deleted, exported to checksummed JSON, and imported with validation and a 500-rule ceiling.

Matching observations are returned to the history boundary as protected IDs. If opt-in historical observation recording is enabled, those records receive protected trigger retention and are excluded from progressive bulk downsampling. Trigger evidence remains persisted even when position history is off. Watchlists are capped at 500 rules, including at most 20 geofences, and each source publication evaluates at most 1,000 observations in one bounded transaction.

Right-clicking a map object opens contact actions; right-clicking empty map space opens region actions. External search and cleaned-page research happen only after that click. `ANALYZE WITH ACTIVE UNIT` prepares a citation-required prompt in the ordinary Command interface; it does not create a separate model configuration or send automatically. Contact and 25 km region watches can also be created from this menu.

## Trigger engine

The engine evaluates new normalized observations for geofence entry and exit, watchlist matches, emergency squawks or emergency states, ten-minute loiter inside a five-kilometre radius, and reappearance after thirty minutes. Trigger evidence is deduplicated for ten minutes and globally limited to 30 events per rolling hour. At most 5,000 trigger events are retained. New triggers arrive through a server-sent event stream and appear in VoidCat's notification center; the trigger log supports acknowledgement.

Trigger state, deduplication state, and events are stored in the isolated Hunter database, never the shared chat-memory database.
Entity trigger state is limited to the 100,000 most recently seen keys and 48 hours; deduplication keys expire after 24 hours.

## Advanced feed health

Every pull source tracks one-hour error rate, records observed per hour, a learned or provider-declared expected baseline, silent-zero state, and current AI-context eligibility. Repeated empty results or a sustained error rate automatically produce `DEGRADED`. Observations from disabled, down, rate-limited, degraded, or silent-zero sources are removed from active UNIT tool evidence. The health console persists samples no more than once every five minutes per source and retains 30 days.

The protected AIS desktop bridge publishes the same health fields with an explicit bridge-availability boundary. It counts positioned records and rejected messages over a rolling hour, learns a bounded expected baseline for the active connection, and automatically degrades after five minutes of silent-zero operation.

## Snapshot and replay

Replay is opt-in per recording. A recording window is bounded to 30 seconds through 30 minutes and may be limited to selected source IDs. Future normalized observations are written as JSONL beside a manifest containing source scope, timestamps, record and byte counts, status, and a SHA-256 checksum. Both files are accounted to the Hunter observation budget before and during writes.

Playback validates the manifest, 64 MiB file ceiling, 50,000-record ceiling, observation structure, and checksum. It loads only the local file, reports `offline: true` and `apiCallsConsumed: 0`, and clearly replaces the live display until `RETURN TO LIVE` is selected. Replay files are suitable for deterministic integration fixtures because identical files produce identical observation arrays.

## Storage and safety boundaries

- Stage 5 metadata and replays use the isolated Hunter paths under `.voidcat/data/hunter`.
- All writes pass through the P2 Hunter observation budget and active-write accounting.
- Chat conversations and memories are not in any Stage 5 clear or retention scope.
- Automated tests create disposable operating-system temporary directories and never open the user's database.
- Replay recording drains pending writes before the checksum is finalized.
- Replay automatically seals at 50,000 records or 64 MiB even if its selected time window has not elapsed.
- An interrupted `recording` manifest is recovered as `cancelled` on the next launch and is never offered as playable evidence.
- Web research remains subject to the existing domain, size, private-network, and prompt-injection defenses.
