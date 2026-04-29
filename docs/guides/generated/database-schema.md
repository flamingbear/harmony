# Harmony Database Schema

## Overview

Harmony uses a relational database (SQLite in tests, PostgreSQL in production) managed via Knex.js migrations (`db/migrations/`). The schema centers on a workflow execution model: a user request produces a **Job**, which is broken into **WorkflowSteps**, each of which produces **WorkItems** that are dispatched to backend services. A separate **UserWork** table maintains live accounting for per-user fair queueing.

---

## Core Tables

### `jobs`

The top-level record for a user request. Created atomically with its workflow steps and initial work items.

| Column | Type | Notes |
|---|---|---|
| `jobID` | uuid PK | Currently identical to `requestId`; may diverge in future |
| `requestId` | uuid | ID of the originating HTTP request |
| `username` | string | EDL username of the requester |
| `status` | enum | See state machine below |
| `request` | string | Original request URL |
| `isAsync` | bool | Sync vs. async request |
| `numInputGranules` | int | Total granules matched by CMR |
| `progress` | int | 0–100, derived from workflow step progress |
| `batchesCompleted` | int | Number of aggregation batches finished |
| `ignoreErrors` | bool | Whether partial failures are tolerated |
| `collectionIds` | string[] | CMR collection concept IDs |
| `service_name` | string | Name from services.yml |
| `provider_id` | string | DAAC provider ID |
| `destination_url` | string | Optional user-specified output location |
| `dataExpiration` | date | When outputs expire from S3 |
| `original_data_size` | float | MB of input data (for metrics) |
| `output_data_size` | float | MB of output data (for metrics) |
| `createdAt` / `updatedAt` | date | Standard timestamps |

**Job status state machine** (xstate):
```
accepted → running → successful
                   → complete_with_errors
                   → failed
                   → canceled
                   → paused
         → previewing → running (after skip-preview)
                      → paused
                      → canceled
                      → failed
running_with_errors → complete_with_errors | failed | canceled | paused
paused → running (on resume)
```

**Used by:**
- `harmony` (frontend): created on every turbo service request
- `work-updater`: transitions status on work item completion
- `work-failer`: transitions status on cascading failures
- `cron-service`: expires old jobs, cleans up stale records
- `work-scheduler`: reads status to filter eligible jobs

---

### `workflow_steps`

One row per service step per job. Defines what a step does and tracks its progress.

| Column | Type | Notes |
|---|---|---|
| `jobID` | uuid FK → jobs | |
| `serviceID` | string | Docker image tag (with version) |
| `stepIndex` | int | 1-based position in the pipeline |
| `operation` | string (JSON) | Serialized `DataOperation` — the full request params for the service |
| `workItemCount` | int | Expected number of work items (updated as granules are discovered) |
| `completed_work_item_count` | int | Incremented on each work item completion |
| `progress_weight` | float | Relative contribution to overall job progress |
| `hasAggregatedOutput` | bool | Step produces a single output from many inputs |
| `isBatched` | bool | Inputs are grouped into batches |
| `is_sequential` | bool | Step runs items one at a time (e.g., query-cmr) |
| `is_complete` | bool | Set true when all items for the step are done |
| `maxBatchInputs` | int | Max granules per batch invocation |
| `maxBatchSizeInBytes` | int | Max combined input size per batch |
| `always_wait_for_prior_step` | bool | Do not start until all prior-step items finish |

**Used by:**
- `harmony` (base-service): written atomically with the job on request creation
- `work-scheduler`: reads `operation` to inject into work items before dispatch; reads `is_complete` to decide whether a step is ready
- `work-updater`: increments `completed_work_item_count`, sets `is_complete`, decrements `workItemCount` on failures
- `work-failer`: reads step state when cascading failures

**Key relationship:** `workflow_steps.jobID + stepIndex` ↔ `work_items.jobID + workflowStepIndex`

---

### `work_items`

One row per unit of work dispatched to a service. The granular execution record.

| Column | Type | Notes |
|---|---|---|
| `jobID` | uuid FK → jobs | |
| `serviceID` | string | Docker image tag matching the workflow step |
| `workflowStepIndex` | int | FK → `workflow_steps.stepIndex` for this job |
| `status` | enum | `ready → queued → running → successful \| failed \| warning \| canceled` |
| `stacCatalogLocation` | string | S3 path to input STAC catalog for this item |
| `scrollID` | string | CMR scroll session ID (query-cmr step only) |
| `sortIndex` | int | Position in aggregation output ordering |
| `retryCount` | int | Number of times this item has been retried |
| `startedAt` | date | When the service pod picked it up |
| `duration` | int | Processing time in ms |
| `totalItemsSize` | float | Combined size of inputs (bytes) |
| `message_category` | string | Error/warning classification |

**Work item lifecycle:**
```
ready → queued (when pushed to SQS, if useServiceQueues=true)
      → running (when service pod claims it)
      → successful | failed | warning | canceled
```

**Used by:**
- `harmony` (base-service): first-step items written on job creation
- `work-scheduler`: reads `ready` items using `FOR UPDATE SKIP LOCKED` to claim without contention; transitions to `queued` or `running`
- `service-runner`: pulls item from SQS/DB, executes service, POSTs result back
- `work-updater`: receives result POST, writes final status; creates next-step work items
- `work-failer`: bulk-cancels items for failed/canceled jobs
- `query-cmr` service: creates new `work_items` for downstream steps as it pages through CMR results

**Key relationship:** `work_items.jobID + workflowStepIndex` → `workflow_steps`

---

### `user_work`

A **denormalized accounting table** — one row per `(job_id, service_id)` pair. Exists purely as a performance optimization to avoid `COUNT(*)` scans on `work_items` during every scheduling decision.

| Column | Type | Notes |
|---|---|---|
| `job_id` | uuid FK → jobs | |
| `service_id` | string | Matches `workflow_steps.serviceID` |
| `username` | string | Denormalized from job |
| `ready_count` | int | Work items in `ready` state for this job+service |
| `running_count` | int | Work items in `running` state for this job+service |
| `is_async` | bool | Denormalized from job; async jobs deprioritized |
| `last_worked` | date | Timestamp of last dispatch from this row |

**Fair queue algorithm** (executed by `work-scheduler` on each scheduling tick):

1. **Pick user** — among users with `ready_count > 0` for the service, choose the one with lowest total `running_count`, breaking ties by oldest `last_worked`. Prevents any single user from monopolizing.
2. **Pick job** — for that user, pick the job with oldest `last_worked`, with sync jobs preferred over async (`ORDER BY is_async ASC, last_worked ASC`).
3. **Batch dispatch** — for larger batches, a window function (`ROW_NUMBER() OVER (PARTITION BY username)`) interleaves jobs across users round-robin.

**Count transitions:**
- Job creation: `ready_count` pre-populated with first-step item count
- Dispatch: `ready_count--`, `running_count++`, `last_worked = now`
- Completion/failure: `running_count--`
- Retry: `ready_count++`, `running_count--`
- Cancel/pause: both counts zeroed
- Resume: counts recalculated from `work_items` ground truth

**Used by:**
- `work-scheduler`: primary consumer — all scheduling decisions go through this table
- `harmony` (base-service): written on job creation
- `work-updater`: increments/decrements counts on every work item state change
- `work-failer`: zeroes counts on job termination

---

### `job_links`

Output links produced by a job. Exposed to users via the Jobs API and STAC catalog.

| Column | Type | Notes |
|---|---|---|
| `jobID` | uuid FK → jobs | |
| `href` | text | S3 presigned URL or OPeNDAP link |
| `rel` | string | Link relation type (e.g. `data`, `self`) |
| `type` | string | MIME type of the output |
| `title` | string | Human-readable description |
| `bbox` | string | Comma-separated bounding box (stored as string, parsed to number[]) |
| `temporalStart` / `temporalEnd` | date | Temporal coverage of this output |

**Used by:**
- `work-updater`: appends links as service pods report successful outputs
- `harmony` (Jobs API frontend): paginates and returns to users
- `harmony` (STAC frontend): renders as STAC item assets

---

### `job_messages`

Per-granule error and warning messages. Written when a work item fails or warns but the job continues (`ignoreErrors = true`).

| Column | Type | Notes |
|---|---|---|
| `jobID` | uuid FK → jobs | |
| `url` | string | The granule URL that failed/warned |
| `message` | string | Error/warning text (max 4096 chars) |
| `level` | enum | `error` or `warning` |
| `message_category` | string | Classification of the error |

**Used by:**
- `work-updater`: writes on partial failure/warning
- `harmony` (Jobs API): returned in job status responses

---

### `batches`

Tracks aggregation batches for steps that aggregate many inputs into one output. Used to assign a stable `batchID` to each batch and coordinate which items belong together.

| Column | Type | Notes |
|---|---|---|
| `jobID` | uuid FK → jobs | |
| `serviceID` | string | The aggregating service |
| `batchID` | int | Sequential batch number for this job+service |

**Used by:**
- `work-updater`: creates batches and assigns work items to them during aggregation steps

---

## Supporting Tables

### `raw_labels` / `jobs_raw_labels` / `users_labels`

User-defined string tags applied to jobs for filtering/organization.

- `raw_labels (id, value)` — deduplicated label strings (upserted on conflict)
- `jobs_raw_labels (job_id, label_id)` — M:N join between jobs and labels
- `users_labels (username, value)` — per-user label history (MRU for autocomplete)

**Used by:** `harmony` (Jobs API) for label CRUD operations; `work-scheduler` and job listing queries filter by labels.

---

### `service_deployments`

Audit log of service Docker image deployments triggered through the Harmony admin API.

| Column | Notes |
|---|---|
| `deployment_id` | UUID for the deployment event |
| `username` | Admin who triggered it |
| `service` | Service name (e.g. `query-cmr`) |
| `tag` | Docker image tag deployed |
| `regression_test_version` | Version of regression tests run against the deployment |
| `status` | `running \| successful \| failed` |
| `message` | Error detail if failed |

**Used by:** `harmony` (admin frontend) to trigger and poll deployment status.

---

## Relationships

```
jobs (1)
  ├── (N) workflow_steps       [jobID]
  ├── (N) work_items           [jobID]
  ├── (N) user_work            [job_id]  ← denormalized accounting
  ├── (N) job_links            [jobID]
  ├── (N) job_messages         [jobID]
  ├── (N) batches              [jobID]
  └── (N) jobs_raw_labels      [job_id]
        └── (N:1) raw_labels   [label_id]

users_labels                   [username]  ← per-user label history, not FK'd to jobs
service_deployments            ← standalone, not FK'd to jobs
```

`workflow_steps` and `work_items` are co-keyed on `(jobID, stepIndex/workflowStepIndex)` but there is no formal FK — the join is done in application code.

---

## How Each Service Uses the DB

### `harmony` (main API server)

- **Reads** `jobs` + `workflow_steps` + `work_items` + `job_links` + `job_messages` to serve Jobs API and STAC responses.
- **Writes** `jobs`, `workflow_steps`, `work_items`, `user_work` atomically on request creation (turbo path).
- **Reads/writes** `raw_labels`, `jobs_raw_labels`, `users_labels` for label management.
- **Reads/writes** `service_deployments` for admin deployment tracking.

### `work-scheduler`

- **Reads** `user_work` to select the next user and job to dispatch (fair queue).
- **Reads** `work_items` (with `FOR UPDATE SKIP LOCKED`) to claim items without contention.
- **Updates** `work_items` status to `queued` or `running`.
- **Updates** `user_work` counts (`ready_count--`, `running_count++`, `last_worked`).

### `service-runner`

- **Reads** `work_items` + `workflow_steps` to retrieve the operation definition.
- Executes the service, then POSTs results to the backend port of `harmony`.

### `work-updater`

- **Updates** `work_items` status to `successful`, `failed`, or `warning`.
- **Creates** next-step `work_items` (and updates `user_work`) when a step completes.
- **Updates** `workflow_steps.completed_work_item_count` and `is_complete`.
- **Updates** `jobs` status via state machine transitions.
- **Writes** `job_links` as outputs are produced.
- **Writes** `job_messages` for per-granule errors/warnings.
- **Creates/manages** `batches` for aggregation steps.

### `work-failer`

- **Reads** stale `work_items` (running but not updated recently).
- **Updates** `work_items` to `failed`.
- **Updates** `jobs` to `failed` or `running_with_errors`.
- **Zeroes** `user_work` counts for terminated jobs.

### `cron-service`

- **Updates** `jobs.status` to `failed` for jobs exceeding max age.
- **Deletes** expired `work_items`, `workflow_steps`, and `job_links` in batches.
- **Deletes** orphaned `user_work` rows (both counts zero).
- **Calls** `recalculateCounts` to repair any drifted `user_work` state.

### `query-cmr` (service pod)

- **Creates** `work_items` for downstream steps as it pages through CMR results.
- **Updates** `user_work.ready_count` for those new items.
- **Updates** its own `work_items` record with `scrollID` for pagination continuity.
