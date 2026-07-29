# VC Hunter-Seeker adapter framework

The Phase 2 adapter framework is passive and provider-neutral. It performs no network activity until a separately registered adapter's `fetch()` method is invoked. The initial store is bounded, in-memory, and live-only; it never writes observations or raw provider payloads to disk.

## Lifecycle

Each adapter declares immutable metadata and implements three methods:

1. `fetch()` receives an `AbortSignal` and retrieves one provider payload.
2. `normalize()` converts that payload into `NormalizedObservation[]`.
3. `health()` reports the adapter's upstream view as healthy, degraded, or down.

The registry owns the remaining lifecycle:

`fetch → normalize → validate → store → publish`

It also owns TTL expiry, maximum cached records, per-window rate limits, a hard hourly request budget, exponential backoff with jitter for HTTP 429/5xx failures, cancellation, and subscriber isolation. A failed adapter returns a failure result and cannot throw through `refreshAll()` into another adapter.

The registry health snapshot exposes both the provider/backoff boundary (`nextAllowedAt`) and the scheduler's planned pull (`nextScheduledAt`). The interface displays the later value so a user can see when a source will actually be contacted. A manual refresh bypasses the selected display cadence, but never bypasses provider floors, retry-after guidance, backoff, or hard request budgets.

Adapters may declare a `healthPolicy` with an expected minimum positioned-record count and a consecutive-low-result threshold. A single legitimate empty result is accepted. Repeated suspicious empty successes degrade the source while preserving the last valid bounded snapshot; a later valid pull resets the degraded condition.

## Freshness contract

The board derives one explicit freshness state for each source and contact:

- `LIVE`: healthy and refreshed inside the selected cadence.
- `CACHED`: a valid snapshot is being reused inside its freshness envelope.
- `STALE`: the cache envelope or moving-contact staleness window has expired.
- `DEGRADED`: the adapter is failing or repeatedly returning too little usable data.
- `ACQUIRING`: enabled, but no successful snapshot exists yet.
- `OFFLINE`: disabled.

Changing a source off and back on restores its last valid snapshot inside the selected cadence without issuing an unnecessary provider request. Map symbols are dimmed by freshness, and the source matrix shows both last success and next planned pull.

## Observation contract

Every record contains:

- Stable observation, entity, and entity-type identifiers.
- Latitude/longitude and optional altitude/accuracy.
- Observation timestamp.
- Source, fetch, receipt, upstream timestamp, and staleness provenance.
- Confidence from 0–1 and a measured/derived/estimated basis.
- Bulk/protected/derived retention class.
- Structured attributes and an optional separately droppable raw payload.

Invalid records are rejected before storage or publication. Valid records from the same batch still publish, while the feed health becomes degraded and records the rejection count.

## Usage example

```ts
import type { SourceAdapter } from "./build/hunter-seeker/source-adapter";
import { SourceRegistry } from "./build/hunter-seeker/source-registry";

class ExampleAdapter implements SourceAdapter<{ items: unknown[] }> {
  readonly descriptor = {
    id: "example.events",
    displayName: "Example Events",
    category: "seismic" as const,
    authTier: "tier-1" as const,
    credentialType: "none" as const,
    pollCadenceMs: 60_000,
    rateLimit: { requestsPerWindow: 1, windowMs: 10_000, hardHourlyBudget: 60 },
    providerDocsUrl: "https://provider.example/docs",
    cache: { ttlMs: 120_000, maxObservations: 5_000 },
    retentionPolicy: { mode: "live-only" as const },
    estimatedBytesPerDay: 25_000_000,
  };

  async fetch({ signal }: Parameters<SourceAdapter<{ items: unknown[] }>["fetch"]>[0]) {
    const response = await fetch("https://provider.example/public-feed", { signal });
    if (!response.ok) throw new Error(`Provider returned ${response.status}`);
    return response.json() as Promise<{ items: unknown[] }>;
  }

  normalize() {
    return []; // Provider-specific normalization is implemented here.
  }

  health() {
    return { status: "healthy" as const };
  }
}

const registry = new SourceRegistry();
registry.register(new ExampleAdapter());
registry.subscribe((sourceId, observations) => {
  console.log(sourceId, observations.length);
});
registry.start();
```

Provider adapters must be built from their providers' current official documentation. Registering a persistent retention policy against the live-only store is rejected; persistent storage remains gated on VoidCat's future storage budget manager.
