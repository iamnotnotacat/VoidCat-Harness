# VoidCat shared Job Manager

Status: P5 implementation candidate, awaiting owner approval.

The shared job manager runs bounded, cancellable work for any VoidCat module. It is process-local and memory-only. It does not add an AI client, a UI, persistent job history, a retry worker, shell access, or Hunter-Seeker analysis jobs.

Implementation: `build/voidcat-job-manager.ts`

## Safety model

Every job must declare all three caps before it can enter the queue:

- Maximum logical iterations.
- Wall-clock timeout.
- Maximum external calls.

The manager also bounds global concurrency and queued work. Defaults are two executing jobs and twenty waiting jobs. Values are deliberately capped even when a caller requests more. This prevents a burst of analysis requests from starting an unbounded number of CPU, network, or model operations.

Cancelled or timed-out work rejects its public result immediately and aborts its signal. If a faulty handler ignores the abort signal, its execution slot remains occupied until the handler actually unwinds. The manager will not start replacement work on top of a still-running cancelled handler. `cleanupPending` makes that condition visible to diagnostics and future UI.

## Context contract

A handler receives only a managed context:

- `signal` carries cancellation and timeout.
- `checkpoint()` fails once the job is no longer active.
- `consumeIteration()` enforces the iteration budget.
- `externalCall()` is the required wrapper for counted provider, tool, or model calls.
- `reportProgress()` updates bounded progress text and counters.
- `reportUsage()` accounts for tokens and generic cost units.

Crossing an iteration or external-call cap aborts and terminally marks the job before throwing. A handler cannot catch the limit error and convert the job into a successful result.

JavaScript cannot forcibly terminate an arbitrary in-process function that ignores cancellation. For that reason, managed handlers must route external work through `externalCall`, check `signal`, and call `checkpoint` inside CPU loops. The manager contains the damage from a non-cooperative handler by retaining its concurrency slot; future work that requires OS-level termination must run in a separately killable worker and still use this manager as its control plane.

## States and snapshots

States are `queued`, `running`, `completed`, `failed`, `cancelled`, `timed-out`, and `limit-exceeded`.

Snapshots contain the stable job ID, module, job name, state, creation/start/completion timestamps, progress, declared caps, resource consumption, cleanup state, and a stable error code. Inputs, outputs, provider responses, exception messages, prompts, credentials, and model context are not stored.

The default terminal history is 500 jobs and is never persisted. Callers may list by module or state and clear finished jobs explicitly.

## UI and programmatic cancellation

`handle.cancel()`, `manager.cancel(id)`, and `manager.cancelModule(module)` provide programmatic cancellation. `subscribe(listener)` emits immutable snapshots for a future UI. Progress notifications are throttled to ten per second by default, while state transitions are emitted immediately. A faulty listener is isolated from the job.

No cancellation UI is added at this primitive gate. The consuming Hunter-Seeker integration must render subscribed jobs and wire its cancel controls to these methods after P5 approval.

## Usage example

```ts
import { voidcatJobManager } from "./build/voidcat-job-manager";

const job = voidcatJobManager.start({
  module: "documents",
  name: "bounded-summary",
  caps: {
    maxIterations: 20,
    timeoutMs: 30_000,
    maxExternalCalls: 2,
  },
  async run(context) {
    context.reportProgress({ current: 0, total: 2, message: "Preparing evidence" });
    context.consumeIteration();

    const evidence = await context.externalCall(async (signal) => {
      return loadEvidence({ signal });
    });

    context.checkpoint();
    context.reportUsage({ inputTokens: 900, units: 1 });
    context.reportProgress({ current: 2, total: 2, message: "Complete" });
    return summarize(evidence);
  },
});

const unsubscribe = voidcatJobManager.subscribe((snapshot) => {
  if (snapshot.id === job.id) renderProgress(snapshot);
});

const result = await job.result;
unsubscribe();
```

## Deliberate exclusions at this gate

- No Hunter-Seeker tool or analysis job is registered.
- No model prompt or tool-call loop is changed.
- No persistent observation or job storage is created.
- No retry is automatic; retries must be a new explicitly bounded job.
- No job can execute shell commands or download binaries through this primitive.

After owner approval, a consuming milestone may connect the small passive Hunter-Seeker tool set through P4 and run model-initiated analysis through P5 with visible cancellation controls.
