# Work Failer Service

## Overview

The work-failer is a periodic, single-replica microservice whose only job is to detect work items that have been stuck in `RUNNING` or `QUEUED` longer than a per-service timeout threshold and mark them as failed. It does not run user code, talk to SQS as a consumer, or own any state of its own — it computes an "expiration" verdict and feeds it through the same code path the work-updater uses for real failure messages, so timed-out items get the normal retry / cascade behavior.

Conceptually: the work-updater handles failures that services *report*; the work-failer handles failures that services *never report* because they died, hung, or were lost.

---

## Entry Point and Main Loop

**`services/work-failer/app/server.ts`** starts a `Failer` worker and a minimal Express app (port 3000) with `/liveness` and `/readiness` health endpoints. The HTTP server exists only for Kubernetes — no other endpoints.

**`services/work-failer/app/workers/failer.ts`** runs a periodic loop:

```
loop:
  handleWorkItemTimeouts(FAILABLE_WORK_AGE_MINUTES)
  sleep WORK_FAILER_PERIOD_SEC (default 300s)
```

Unlike the work-updater, this is not a hot loop. It deliberately sleeps between scans because expired work is bounded by a coarse-grained threshold (minutes), not millisecond latency.

---

## What Counts as "Expired"

A work item is a candidate for failure when **all** of these are true:

1. Its `status` is `RUNNING` or `QUEUED`.
2. Its parent job's `status` is `RUNNING` or `RUNNING_WITH_ERRORS`.
3. Its `updatedAt` is older than `FAILABLE_WORK_AGE_MINUTES` (default 5).
4. Its current run time (`Date.now() - startedAt`) exceeds a **per-(job, service) timeout threshold** (see below).

Conditions 1–3 are a coarse DB filter (`getWorkItemsByUpdateAgeAndStatus` in `services/harmony/app/models/work-item.ts`). Condition 4 is an in-memory filter applied after the threshold is computed.

---

## Per-Service Timeout Threshold

For each `(jobID, serviceID)` pair seen in a batch, the failer computes a threshold in `computeWorkItemDurationOutlierThresholdForJobService`:

```
1. start with a service-specific default:
     casper, concise → 900_000 ms (15 min)   (aggregation services)
     everything else → DEFAULT_TIMEOUT_SECONDS * 1000 (default 300_000 ms)
2. if any work item for this (job, service) has already SUCCEEDED:
     threshold = 2 × max(duration of successful items)
```

The doubled-max heuristic adapts to whatever the actual service-runner has been taking for *this specific job*, which is typically much more reliable than a static timeout. The static default applies only until the first successful sibling exists.

The `serviceID` is the Docker image tag (e.g., `podaac/concise:0.10.0rc11`); the lookup strips the namespace and tag to match against the table.

---

## Backpressure Against the Update Queue

The failer can produce a large burst of "synthetic" failures, and each failure walks through the same expensive retry / cascade logic as a real one. To avoid overwhelming the work-updater pipeline, before each batch:

```
if MAX_WORK_ITEMS_ON_UPDATE_QUEUE_FAILER != -1:
  count = SMALL_ITEM_UPDATE queue depth
  if count >= MAX_WORK_ITEMS_ON_UPDATE_QUEUE_FAILER (default 1000):
    sleep failerDisabledDelay (20s) and re-check
  else:
    batchSize = min(WORK_FAILER_BATCH_SIZE, slotsAvailable)
```

Setting `MAX_WORK_ITEMS_ON_UPDATE_QUEUE_FAILER=-1` disables this throttle. Setting `WORK_FAILER_BATCH_SIZE=0` effectively disables the failer entirely.

---

## Lifecycle of an Expired Work Item

### 1. Discovery

`getExpiredWorkItems(lastUpdateOlderThanMinutes, startingId, batchSize)`:

- Pages through work items ordered by `id`, starting after `startingId`.
- Returns at most `WORK_FAILER_BATCH_SIZE` rows per page.
- For each unique `(jobID, serviceID)` in the page, computes and caches the timeout threshold.
- Filters the page down to items whose elapsed run time exceeds their threshold.

Pagination terminates when a page returns no rows with id greater than the previous page's max id.

### 2. Grouping by Job

Expired items are grouped by `jobID`. All items for a single job are failed in parallel via `Promise.all`, but jobs are processed sequentially. This matches the work-updater's batch-by-job pattern and avoids interleaved updates to the same job's progress counters.

### 3. Synthetic Failure Update

For each expired item the failer constructs a `WorkItemUpdate` with:

```typescript
{
  workItemID: item.id,
  status: WorkItemStatus.FAILED,
  scrollID: item.scrollID,
  hits: null,
  results: [],
  totalItemsSize: item.totalItemsSize,
  errorMessage: `Work item ${id} has exceeded the ${threshold} ms duration threshold.`,
  workflowStepIndex: item.workflowStepIndex,
}
```

and hands it directly to **`handleBatchWorkItemUpdatesWithJobId`** — the same function the work-updater calls. This is an in-process call, not an SQS publish: the failer is essentially a synthetic update producer that bypasses the queue.

The downstream effect is identical to any other failed item:

- The retry path applies if `retryCount < WORK_ITEM_RETRY_LIMIT`. Most timeouts retry.
- After retries are exhausted, the item is permanently failed and counts toward the job's error budget (`MAX_ERRORS_FOR_JOB`, `MAX_PERCENT_ERRORS_FOR_JOB`).
- `query-cmr` timeouts fail the entire job unconditionally (the work-updater's rule, not the failer's).

See `work-updater.md` for the full failure / retry branch.

### 4. Errors During Failing

Per-job exceptions during `handleBatchWorkItemUpdatesWithJobId` are caught and logged; processing continues with the next job. A failure in the failer itself (e.g., DB down) is caught at `start()` and the loop sleeps and retries on the next period.

---

## What the Failer Does *Not* Do

Despite the name, the failer does not:

- **Read from any queue.** It only checks the small-item-update queue *depth* for backpressure.
- **Write work item rows directly.** All state changes go through `handleBatchWorkItemUpdatesWithJobId`.
- **Delete anything.** Cleanup of finished work and old jobs is the cron-service's job.
- **Decide whether to retry.** That decision lives in `work-item-updates.ts` and depends on `retryCount` and `message_category`, neither of which the failer sets.
- **Coordinate with other replicas.** The failer is intended to run as a single replica. Multiple replicas would not corrupt state (each item update is transactional) but would do duplicate work and could double-count against the update-queue throttle.

---

## Key Configuration

```
WORK_FAILER_PERIOD_SEC=300              # interval between scans (5 min)
FAILABLE_WORK_AGE_MINUTES=5              # coarse DB filter: rows not updated in N minutes
WORK_FAILER_BATCH_SIZE=1000              # max rows per page; 0 disables the failer
MAX_WORK_ITEMS_ON_UPDATE_QUEUE_FAILER=1000  # backpressure cap; -1 disables throttle
DEFAULT_TIMEOUT_SECONDS=300              # fallback per-item timeout when no sibling succeeded
```

Service-specific defaults are hard-coded in `serviceToDefaultTimeoutSeconds` (currently `casper` and `concise` at 900 s).

---

## Key Source Files

| File | Role |
|---|---|
| `services/work-failer/app/workers/failer.ts` | Main loop, threshold computation, expiration filter, update producer |
| `services/work-failer/app/util/env.ts` | Env validation (extends `HarmonyEnv`) |
| `services/work-failer/app/server.ts` | Express bootstrap, K8s health endpoints |
| `services/harmony/app/models/work-item.ts` | `getWorkItemsByUpdateAgeAndStatus`, `workItemCountForStep` |
| `services/harmony/app/backends/workflow-orchestration/work-item-updates.ts` | `handleBatchWorkItemUpdatesWithJobId` — shared with work-updater |
