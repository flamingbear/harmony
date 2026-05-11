# Work Scheduler Service

## Overview

The work-scheduler is the bridge between the database (where work items are *created*) and the per-service SQS queues (where work items are *consumed* by service-runner pods). It does not invent work — every scheduling cycle is triggered by a message on the **scheduler queue** asking it to send some items for a named service. Its real job is deciding *how many* items to put on each service queue given current pod counts, queue depth, and update-pipeline pressure.

Conceptually:
- A service-runner pod asks Harmony's backend for work.
- If the service queue is empty, the backend drops a `serviceID` onto the scheduler queue.
- The work-scheduler picks that up, pulls a calibrated batch of ready work items from the DB (via the fair-queue algorithm), and writes them onto the service's SQS queue.
- The pod's next poll finds the work waiting.

This indirection is why `USE_SERVICE_QUEUES=true` is required for the scheduler to do anything — the scheduler queue is the only input it has.

---

## Entry Point and Main Loop

**`services/work-scheduler/app/server.ts`** starts a `Scheduler` worker and a minimal Express app (port 3000) with `/liveness` and `/readiness` endpoints.

**`services/work-scheduler/app/workers/scheduler.ts`** runs a tight infinite loop:

```
loop:
  processSchedulerQueue()       ← drain → group → enqueue
  on error → log and continue
```

There is no sleep between iterations. The scheduler queue's long-poll on the first read provides the natural idle backoff (`drainQueue` long-polls once, then short-polls up to `WORK_ITEM_SCHEDULER_QUEUE_MAX_GET_MESSAGE_REQUESTS` times to drain a burst).

---

## SQS Queues

The scheduler interacts with three SQS surfaces:

| Queue | Direction | Purpose |
|---|---|---|
| Scheduler queue (`WORK_ITEM_SCHEDULER_QUEUE_URL`) | Read | One message = one request to schedule work for the contained `serviceID` |
| Per-service queues (`getQueueUrlForService(serviceID)`) | Write | The actual work queue each service-runner pod consumes |
| Small item update queue (`SMALL_ITEM_UPDATE`) | Depth check only | Backpressure signal — if too deep, scheduling halts |

**Scheduler-queue message shape**: the message body is the bare `serviceID` string (e.g. `podaac/concise:0.10.0rc11`). No JSON. The producer is `makeWorkScheduleRequest` in `services/harmony/app/backends/workflow-orchestration/work-item-polling.ts`, called by `getWorkFromQueue` when a service-runner asks for work and finds nothing on its service queue.

**Per-service-queue message shape**: a JSON-serialized `WorkItemData` (the work item plus, for `query-cmr`, the `maxCmrGranules` page limit).

---

## Lifecycle of a Scheduling Cycle

### 1. Drain the Scheduler Queue

`drainQueue` reads up to `WORK_ITEM_SCHEDULER_QUEUE_MAX_BATCH_SIZE` (default 10) messages per request, repeating up to `WORK_ITEM_SCHEDULER_QUEUE_MAX_GET_MESSAGE_REQUESTS` (default 10) times. With defaults that's up to 100 scheduler-queue messages absorbed per cycle. The first read uses long-polling; subsequent reads use short-polling so we stop as soon as the queue is empty.

### 2. Backpressure Check

Before doing any DB work:

```
if MAX_WORK_ITEMS_ON_UPDATE_QUEUE != -1:
  count = SMALL_ITEM_UPDATE queue depth
  if count > MAX_WORK_ITEMS_ON_UPDATE_QUEUE (default 1200):
    log warning, sleep schedulerDisabledDelay (3s), return
```

Same throttle pattern as the work-failer's. The intent is to keep the work-updater from drowning when many pods finish at once.

### 3. Group by serviceID

Drained messages are grouped by their body (the `serviceID`). Each group is processed independently. Multiple messages for the same service collapse into a single scheduling decision plus a single batch fetch from the DB; only after the batch is published are *all* the receipt handles deleted.

### 4. Size Calculation

For each service, the scheduler computes how many items to queue. Inputs:

| Input | Source |
|---|---|
| `servicePodCount` | k8s API (`getPodsCountForService`), LRU-cached for `POD_COUNT_CACHE_TTL` (90s) |
| `schedulerPodCount` | k8s API (`getPodsCountForPodName('harmony-work-scheduler')`), same cache |
| `queuedCount` | Current depth of the per-service SQS queue |
| `numMessagesReceived` | Number of scheduler-queue messages for this service this cycle |
| `scaleFactor` | `SERVICE_QUEUE_BATCH_SIZE_COEFFICIENT` (0.25) for normal services, `FAST_SERVICE_QUEUE_BATCH_SIZE_COEFFICIENT` (1.25) for `query-cmr` |

`calculateNumItemsToQueue` has two regimes:

```
if queuedCount <= 0.1 * servicePodCount:
    # starvation: queue ≈ as many items as there are idle pods,
    # but no more than the number of pull requests we just absorbed
    return max(1, min(servicePodCount - queuedCount, numMessagesReceived))

else:
    n = scaleFactor * (servicePodCount / max(1, schedulerPodCount)) - queuedCount
    return max(1 if queuedCount <= 0 else 0, floor(n))
```

The starvation branch is the common case when scaling up after idle. The normal-regime formula divides the per-replica share of pods by the scheduler-replica count so multiple schedulers don't collectively over-queue; the `-queuedCount` term means the queue self-regulates as items accumulate.

The `query-cmr` coefficient is 5× the default because query-cmr items complete in seconds — feeding fewer than the pod-count's worth would starve downstream services.

### 5. Pull Items From the DB

`getWorkItemsFromDatabase(serviceID, logger, batchSize)` is the read side of fair queueing:

1. `getNextJobIds(serviceID, batchSize)` walks the `user_work` table round-robin across users and returns up to `batchSize` job IDs that have ready work for this service.
2. The list is **Fisher-Yates shuffled** so multiple scheduler replicas competing for the same jobs don't lock-step.
3. For each job:
   - Open a transaction.
   - Compute `workSize = ceil(remainingBatchSize / remainingNumOfJobs)` — small jobs at the front leave room for bigger jobs at the back.
   - `getNextWorkItems(serviceID, jobID, workSize)` claims up to that many `READY` items.
   - `incrementRunningAndDecrementReadyCounts(jobID, serviceID, n)` updates `user_work` so the next scheduler call doesn't claim the same items.
   - For `query-cmr` items only: attach `maxCmrGranules` via `calculateQueryCmrLimit` (the page limit for the next CMR scroll).

If a job in `user_work` claims ready work but the DB returns none, `recalculateCounts` is called to repair the drift.

The size calculation in step 4 yields a total; step 5 chunks it into `WORK_ITEM_SCHEDULER_BATCH_SIZE` (50) DB queries.

### 6. Publish to the Service Queue

Each `WorkItemData` is JSON-serialized and pushed to the service queue via `sendMessage(json, workItemId)` (the message group ID is the work-item ID — preserves SQS FIFO ordering if the queue is FIFO).

### 7. Delete the Scheduler-Queue Receipts

Once all items for this service are published, all the drained receipt handles for this service are deleted from the scheduler queue in a single batch. This is intentionally *after* the publish: if the scheduler crashes mid-batch, SQS visibility timeout returns the requests and the next scheduler tries again.

---

## Pod Count Caching

K8s API calls (`getPodsCountForService`, `getPodsCountForPodName`) are wrapped in `LRUCache` (`lru-cache`) with TTL `POD_COUNT_CACHE_TTL` (default 90 000 ms = 90 s) and capacity 1000. Without this, every cycle would round-trip to the API server twice per service, which is both slow and abusive of the kube-apiserver during scale events. Stale pod counts are tolerable because the size formula has built-in slack.

---

## Multi-Replica Behavior

The scheduler is designed to run multiple replicas:

- The size formula divides by `schedulerPodCount`, so collectively replicas converge on the same total.
- `getNextJobIds` does not lock jobs, but `getNextWorkItems` claims rows under transaction.
- The Fisher-Yates shuffle avoids two replicas marching down the same job list in the same order.

There is no leader election. Replicas work concurrently and the per-row claim transaction is the only correctness guarantee.

---

## What the Scheduler Does *Not* Do

- **Create work items.** Those come from the frontend (`createNextWorkItems` lives in `work-item-updates.ts`).
- **Decide service selection.** That happened at request time in `service-selection` middleware.
- **Apply fair queueing.** It *consumes* the fair queue via `getNextJobIds`; the algorithm itself lives in `app/models/user-work.ts`.
- **Talk to service-runner pods directly.** Communication is one-way through SQS queues.
- **Retry failed work.** Retry decisions are owned by the work-updater (`message_category !== 'noretry'` branch).

---

## Key Configuration

```
WORK_ITEM_SCHEDULER_QUEUE_URL=...               # required input queue
WORK_ITEM_SCHEDULER_QUEUE_MAX_BATCH_SIZE=10     # SQS getMessages page size
WORK_ITEM_SCHEDULER_QUEUE_MAX_GET_MESSAGE_REQUESTS=10  # max pages per drain
WORK_ITEM_SCHEDULER_BATCH_SIZE=50                # max rows per DB query
SERVICE_QUEUE_BATCH_SIZE_COEFFICIENT=0.25        # normal-service scale
FAST_SERVICE_QUEUE_BATCH_SIZE_COEFFICIENT=1.25   # query-cmr scale
MAX_WORK_ITEMS_ON_UPDATE_QUEUE=1200              # backpressure cap; -1 disables
POD_COUNT_CACHE_TTL=90000                        # k8s API cache TTL (ms)
```

---

## Key Source Files

| File | Role |
|---|---|
| `services/work-scheduler/app/workers/scheduler.ts` | Main loop, drain, size formula, publish |
| `services/work-scheduler/app/util/k8s.ts` | Pod-count lookups against the k8s API |
| `services/work-scheduler/app/util/env.ts` | Env validation (extends `HarmonyEnv`) |
| `services/harmony/app/backends/workflow-orchestration/work-item-polling.ts` | `getWorkItemsFromDatabase`, `makeWorkScheduleRequest`, `getWorkFromQueue` |
| `services/harmony/app/models/user-work.ts` | `getNextJobIds`, fair-queue read side, ready/running counters |
| `services/harmony/app/util/queue/queue-factory.ts` | `getQueueUrlForService`, `getWorkSchedulerQueue` |
