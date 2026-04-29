# Work Updater Service

## Overview

The work-updater is a stateless, continuously polling microservice that consumes SQS messages from backend processing pods and advances the Harmony workflow state machine. It is the authoritative component for transitioning work item and job statuses in the database — no other service writes final results.

---

## Entry Point and Main Loop

**`services/work-updater/app/server.ts`** starts an `Updater` worker and a minimal Express app (port 3000) with `/liveness` and `/readiness` health endpoints.

**`services/work-updater/app/workers/updater.ts`** runs a tight infinite loop:

```
loop:
  batchProcessQueue()       ← poll, parse, process
  on error → sleep WORK_ITEM_UPDATE_QUEUE_PROCESSOR_DELAY_AFTER_ERROR_SEC (default 1s)
```

There is no long-polling or idle backoff — the loop runs as fast as messages arrive.

---

## SQS Queues

Two queues exist, sized by message payload:

| Queue | Env Var | Batch Size | Notes |
|---|---|---|---|
| Small item update | `WORK_ITEM_UPDATE_QUEUE_URL` | 10 (SQS max) | Processed as a single batch |
| Large item update | `LARGE_WORK_ITEM_UPDATE_QUEUE_URL` | `LARGE_WORK_ITEM_UPDATE_QUEUE_MAX_BATCH_SIZE` (default: 2) | Each message processed individually to avoid SQS visibility timeouts |

Active queue is selected by `WORK_ITEM_UPDATE_QUEUE_TYPE` (default: `large`).

**Message schema** (`WorkItemUpdateQueueItem`):

```typescript
{
  update: {
    workItemID: number;
    status: WorkItemStatus;           // successful | failed | warning | canceled | running | ready
    scrollID?: string;                // query-cmr pagination cursor
    workflowStepIndex?: number;
    hits?: number;                    // granule count from CMR
    results?: string[];               // S3 paths to STAC catalogs
    totalItemsSize?: number;          // MB
    outputItemSizes?: number[];       // bytes per output item
    message?: string;                 // error or warning text
    message_category?: string;        // noretry | nodata | granValidation | ...
    duration?: number;                // ms (service-reported)
  },
  operation?: object;                 // DataOperation for the step
}
```

**Batching by job**: after reading from SQS, messages are grouped by `jobID` (via `getJobIdForWorkItem`). All updates for the same job are processed together in a single database transaction.

---

## Lifecycle of a Request Through the Work Updater

### 1. Message Arrival

A backend service pod (e.g., a subsetter or query-cmr) completes a work item and POSTs results to the backend port of the main Harmony service. Harmony enqueues a `WorkItemUpdateQueueItem` onto SQS. The work-updater picks it up in its next poll cycle.

### 2. Preprocessing (`preprocessWorkItem`)

Before any DB writes:

- For **successful final-step items**: STAC catalogs are read from S3 to count output items and calculate sizes.
- S3 parse failures force the work item status to `FAILED` before continuing.

### 3. Database Locking and Validation

Inside a single DB transaction:

1. The work item row is locked with `SELECT FOR UPDATE` to prevent concurrent updates.
2. If the work item is already in a terminal state (succeeded, failed, canceled), the update is discarded — idempotent, no double-processing.
3. If a successful item has **zero results**, its status is coerced to `FAILED`.

### 4. Status Update

The work item row is updated with: status, message, message_category, duration (max of harmony-measured vs. service-reported), totalItemsSize, and outputItemSizes.

The parent `WorkflowStep.completed_work_item_count` is incremented, and job progress is recalculated.

### 5. Failure and Retry Handling

This is the critical branch point.

**Retry path** (triggered when `status === FAILED`):

```
if message_category !== 'noretry'
  AND retryCount < WORK_ITEM_RETRY_LIMIT (default 5):
    retryCount++
    status → READY
    ready_count++, running_count--
    RETURN EARLY  ← no next work items created, job continues
```

The work item re-enters the scheduler queue as if it were newly created. The service pod that picks it up has no knowledge of prior failures.

**Permanent failure path** (retries exhausted, or `message_category === 'noretry'`):

```
handleFailedWorkItems():
  if job.ignoreErrors = false:
    if errorCount >= MAX_ERRORS_FOR_JOB (2000)
      OR (itemsDone >= MIN_DONE_ITEMS_FOR_FAIL_CHECK (10)
          AND errorPercent >= MAX_PERCENT_ERRORS_FOR_JOB (75%)):
        completeJob(FAILED)       ← cascade cancel all remaining work items
    else:
      job.status → RUNNING_WITH_ERRORS
  add error to job_messages table
```

**query-cmr failures are unconditional**: any failure from the CMR query step immediately fails the entire job — no retry, no `ignoreErrors` escape hatch. Without granule metadata, the workflow cannot proceed.

**Cascading failure (`completeJob(FAILED)`)**:

1. Job status → `FAILED`
2. All work items in `READY`, `RUNNING`, or `QUEUED` states → `CANCELED`
3. All `user_work` entries for the job are deleted (removes the job from fair-queue scheduling)

### 6. Advancing the Workflow (Success Path)

When a work item succeeds (and is not retrying), `createNextWorkItems()` is called to fan out work for the next pipeline stage. The logic branches on the next step's aggregation mode:

| Next step type | Behavior |
|---|---|
| **Non-aggregating** | One new work item created per output result. Items are batch-inserted. |
| **Aggregating, non-batched** | Wait until **all** items from the current step complete. Then create a single work item whose input is a STAC catalog pointing to all prior outputs. |
| **Aggregating, batched** | Accumulate outputs until a batch is full (`maxBatchInputs` count or `maxBatchSizeInBytes` size), then create a work item. When the final item of the step completes, flush the incomplete batch. |

`nextWorkflowStep.workItemCount` is incremented for each new work item so that downstream step completion detection has an accurate denominator.

### 7. Final Step Completion

On the last step, successful items produce `JobLink` rows pointing to S3 output locations. These are what end users download.

When `allWorkItemsForStepComplete` is true and no further steps exist, `getFinalStatusAndMessageForJob()` decides the job outcome:

| Condition | Job terminal status |
|---|---|
| No errors | `SUCCESSFUL` |
| Errors but output data exists | `COMPLETE_WITH_ERRORS` |
| Errors and no output data | `FAILED` |
| All items failed | `FAILED` |

---

## Job State Machine (Work Updater's View)

```
ACCEPTED
   └─► RUNNING
          ├─► RUNNING_WITH_ERRORS  (ignoreErrors=true, some failures)
          │        └─► SUCCESSFUL | COMPLETE_WITH_ERRORS
          ├─► SUCCESSFUL
          ├─► COMPLETE_WITH_ERRORS
          └─► FAILED               (error limits exceeded or total failure)
```

`PAUSED` and `CANCELED` transitions are driven externally (user action or preview-mode logic), not by the work updater itself.

---

## Progress Tracking

Progress is a weighted average across workflow steps:

```
progress = sum(step.completed / step.total * step.progress_weight)
           / sum(step.progress_weight)
```

Capped at 99% until the job truly completes, to avoid showing 100% prematurely.

---

## Error Guarantees and Trade-offs

- SQS messages are **always deleted** after receipt, regardless of processing outcome. There is no dead-letter queue retry mechanism at the SQS level — processing failures are logged and the work item state in the DB reflects the true outcome.
- The DB transaction + `SELECT FOR UPDATE` lock ensures only one updater instance processes a given job's updates at a time, preventing race conditions in multi-replica deployments.
- Large-queue batch size defaults to 2 (conservative) specifically to stay within SQS visibility timeouts when S3 reads and multi-item DB writes are involved.

---

## Key Configuration

```
WORK_ITEM_RETRY_LIMIT=5
MAX_ERRORS_FOR_JOB=2000
MAX_PERCENT_ERRORS_FOR_JOB=75
MIN_DONE_ITEMS_FOR_FAIL_CHECK=10
LARGE_WORK_ITEM_UPDATE_QUEUE_MAX_BATCH_SIZE=2
WORK_ITEM_UPDATE_QUEUE_PROCESSOR_DELAY_AFTER_ERROR_SEC=1
```

---

## Key Source Files

| File | Role |
|---|---|
| `services/work-updater/app/workers/updater.ts` | Main polling loop, SQS consumption, job grouping |
| `services/harmony/app/backends/workflow-orchestration/work-item-updates.ts` | Core processing logic: retries, failures, next-step creation |
| `services/harmony/app/backends/workflow-orchestration/aggregation-batch.ts` | Batching logic for aggregating steps |
| `services/harmony/app/models/work-item.ts` | Work item DB model and status transitions |
| `services/harmony/app/models/job.ts` | Job DB model, progress, completion |
