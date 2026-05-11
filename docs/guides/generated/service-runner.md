# Service Runner

## Overview

The service-runner is the only Harmony component that actually runs user payloads. Each instance lives as a **manager container** ("service-runner") alongside a **worker container** (the actual data-processing image, e.g. `podaac/concise`) in the same Kubernetes pod. The manager polls Harmony for work, hands the work to the worker via either `kubectl exec` or a local HTTP call, captures the worker's output, and posts the result back to Harmony's backend.

A pod is dedicated to exactly one service: the `HARMONY_SERVICE` env var (e.g. `podaac/concise:0.10.0rc11`) names the image, and the pod's pull loop only requests work for that service ID.

There is no SQS in the service-runner. It pulls work *over HTTP* from the Harmony backend (`GET /service/work`). The backend, behind the scenes, drains the per-service SQS queue that the work-scheduler populated.

---

## Entry Point and Startup

**`services/service-runner/app/server.ts`** is the manager-container entry point:

1. Install a `SIGTERM` handler that calls `process.exit(0)` (cooperates with K8s graceful shutdown via `terminationGracePeriodSeconds`).
2. `waitForContainerToStart('worker', timeout=180s, checkInterval=3s)` — polls the k8s API for the sibling worker container's `state.running` field. Throws if the worker never comes up.
3. Start the `PullWorker`.
4. Bring up Express on port 3000 with `/liveness`, `/readiness`, and `/metrics` endpoints (Prometheus format via `service-metrics.ts`).

**`services/service-runner/app/workers/pull-worker.ts`** starts the pull loop, but first does one quirky thing: **prime the k8s exec client**. The first `exec()` call against a freshly-started worker reliably fails due to k8s client bug [#714](https://github.com/kubernetes-client/javascript/issues/714), so the manager fires one throwaway `runServiceFromPull` against a stub work item before entering the main loop. Retries up to `maxPrimeRetries` (1200 in prod, 2 in tests). If priming exhausts retries, the process exits and K8s restarts the container. Priming is skipped for `query-cmr` since it does not use `exec`.

---

## The Pull Loop

```
loop (every 500 ms):
  clean working dir (leave WORKING and TERMINATING files)
  write WORKING                       ← PreStop signal: do not kill mid-work
  if TERMINATING file exists:
    remove TERMINATING, return        ← PreStop hook has signaled shutdown
  work = GET /service/work?serviceID=...&podName=...   ← long-poll, infinite retry
  if 404: schedule next tick
  else if work.item:
    workItem = _doWork(work.item, work.maxCmrGranules)
    workItem.duration = elapsed
    PUT /service/work/{id}            ← retried up to MAX_PUT_WORK_RETRIES
  remove WORKING
  setTimeout(loop, 500ms)
```

Two filesystem markers coordinate with the K8s `preStop` hook:

| File | Created by | Read by | Meaning |
|---|---|---|---|
| `WORKING` | Manager at start of each iteration; deleted at end | PreStop hook | "Don't kill me — work is in flight" |
| `TERMINATING` | PreStop hook | Manager at start of each iteration | "Stop pulling new work" |

This is how the pod drains before SIGTERM rather than dropping a half-processed work item.

### HTTP Clients

Two axios clients with different retry policies (`util/axios-clients.ts`):

| Client | Used for | Max retries | Retry condition |
|---|---|---|---|
| `axiosGetWork` | `GET /service/work` | `Number.MAX_SAFE_INTEGER` | retryable status AND not terminating |
| `axiosUpdateWork` | `PUT /service/work/:id` | `MAX_PUT_WORK_RETRIES` | retryable status |

Both use exponential backoff: `delayMs ≈ 2^(retryNumber + 3) * 100`, capped at 60 s, plus jitter.

The infinite get-work retry is deliberate: a pod that can't reach Harmony is useless, so it should keep trying until either Harmony comes back or the pod is terminated.

---

## Performing Work

`_doWork` branches on whether the work item has a `scrollID`:

| Branch | Function | Mechanism |
|---|---|---|
| `scrollID` present (query-cmr) | `runQueryCmrFromPull` | HTTP POST to `127.0.0.1:WORKER_PORT/work` in the same pod |
| Everything else | `runServiceFromPull` | `kubectl exec` into the `worker` container |

This split exists because `query-cmr` runs as a Node.js HTTP server in its own container (it doesn't have a `harmony-service-lib` CLI to invoke), whereas standard backend services are Python/Java CLIs invoked once per work item.

### `runQueryCmrFromPull`

```
POST http://127.0.0.1:5001/work
  {
    outputDir: s3://artifacts/.../outputs/,
    harmonyInput: <DataOperation JSON>,
    scrollId: <prior page cursor>,
    maxCmrGranules: <page size from scheduler>,
    workItemId: <id>,
  }
```

On 2xx, the worker has written `catalog*.json` files (and optionally `batch-catalogs.json`) to the S3 output directory. The manager then calls `_getStacCatalogs` to enumerate the catalogs in order, attaches them to the response as `batchCatalogs`, and propagates the `hits` count and next-page `scrollID` back. Non-2xx responses become an `error` string.

Timeout is `WORKER_TIMEOUT` (default 4 hours).

### `runServiceFromPull`

This is the path every other service uses. The manager:

1. Reads `INVOCATION_ARGS` (whitespace- or newline-separated CLI prefix from the service's deployment manifest).
2. Builds a command line:
   ```
   <invocationArgs> \
     --harmony-action invoke \
     --harmony-input <JSON>   (or --harmony-input-file <path> if > 100 KB)
     --harmony-sources <stacCatalogLocation> \
     --harmony-metadata-dir <s3 outputs dir>
   ```
   The 100 KB switch exists because SQS messages (and therefore some path of upstream args) are capped at 262 144 bytes. Large operations are written to `/tmp/operation.json` in the shared volume and passed as a file path.
3. If `operation.subset.shape` is an inline GeoJSON string (not an `{href, type}` object), writes it to `/tmp/shapefile.json` and rewrites the field to reference it.
4. Calls `k8s.Exec.exec('harmony' namespace, this pod, 'worker' container, commandAndArgs, stdoutStream, stderr, stdin, tty=true, callback)`.
5. Captures the worker's stdout via `LogStream` — parses each line as JSON if possible, attaches `workerTimestamp`/`workerLevel`, and accumulates into an in-memory array.
6. On the exec callback's `V1Status`:
   - `Success` → call `_getStacCatalogs(catalogDir)` and return `{ batchCatalogs }`.
   - Failure → read `error.json` from the catalog dir (if present) for the user-facing error message, level (`error` or `warning`), and category. Falls back to a status-derived message.
   - `status.code === 500` → mark `retryable: true`, sleep with exponential backoff (5s, 10s, 20s, ...), retry up to 5 times. This is for k8s-client-internal errors, not service errors.
   - Exit code `137` (OOM) → "Service failed due to running out of memory."
7. Upload the captured log array to `s3://.../logs/...` via `uploadLogs` (appends if a prior log object exists for this work item).
8. Overall timeout: `WORKER_TIMEOUT` (4 hours). When hit, resolves with `error: 'Worker timed out after N seconds'`. The actual work-item timeout used by the work-failer is much shorter and computed independently — see `work-failer.md`.

### Output: How the WorkItem Is Updated

After `_doWork` resolves, the manager mutates the in-memory `WorkItemRecord`:

| Service response | WorkItem fields set |
|---|---|
| `batchCatalogs` present | `status = SUCCESSFUL`, `results`, `totalItemsSize`, `outputItemSizes` |
| `errorLevel === 'warning'` | `status = WARNING`, `message`, `message_category` |
| Otherwise (with `error`) | `status = FAILED`, `message`, `message_category` |
| `scrollID` present (query-cmr) | `scrollID`, `hits` propagated for the next page |

Before PUT-ing back, `operation.sources[*].variables` is cleared — the backend already has them and it shaves payload size. The PUT goes to `BACKEND_HOST:BACKEND_PORT/service/work/:id`, where `BACKEND_HOST` resolves to either `harmony` (in-cluster) or a hostname in `host.docker.internal` form (local dev); the protocol is `http` for those and `https` otherwise.

If the PUT returns 409, the manager logs a warning and continues — 409 means the work item was already in a terminal state (e.g. the work-failer beat us), which is harmless.

---

## Working Directory Hygiene

Each iteration clears `WORKING_DIR` (default `/tmp`) of everything except the `WORKING` and `TERMINATING` marker files. This prevents pods from accumulating per-work-item temp files and eventually getting evicted for ephemeral storage exhaustion. Errors during cleanup are logged but not fatal.

---

## What the Service Runner Does *Not* Do

- **Read from SQS.** The service-runner is a *consumer of the Harmony backend's HTTP API*, not of SQS directly. The backend reads SQS on its behalf.
- **Decide retry.** A failed item PUT just reports the failure; the work-updater applies `WORK_ITEM_RETRY_LIMIT` logic.
- **Validate input.** If the worker rejects the operation, that surfaces as the worker's exit status. The manager does not sanity-check the DataOperation.
- **Know about other pods.** Each pod is autonomous. The work-scheduler is responsible for not over-queueing.

---

## Key Configuration

```
HARMONY_SERVICE=podaac/concise:0.10.0rc11   # the service ID this pod handles
INVOCATION_ARGS=python -m podaac.subsetter   # whitespace/newline-separated CLI prefix
BACKEND_HOST=harmony                         # Harmony backend (in-cluster)
BACKEND_PORT=3001
WORKER_PORT=5001                             # local port for query-cmr HTTP worker
WORKER_TIMEOUT=14400000                      # 4 hours
MAX_PUT_WORK_RETRIES=...                     # PUT /service/work/:id retry budget
WORKING_DIR=/tmp                             # ephemeral work dir & marker files
ARTIFACT_BUCKET=...                          # S3 bucket for STAC catalogs and logs
```

---

## Key Source Files

| File | Role |
|---|---|
| `services/service-runner/app/server.ts` | Bootstrap, SIGTERM handler, wait for worker container |
| `services/service-runner/app/workers/pull-worker.ts` | Pull loop, priming, axios retry clients, WORKING/TERMINATING handshake |
| `services/service-runner/app/service/service-runner.ts` | `runQueryCmrFromPull`, `runServiceFromPull`, `LogStream`, error extraction, STAC catalog enumeration |
| `services/service-runner/app/service/service-metrics.ts` | `/metrics` Prometheus exporter |
| `services/service-runner/app/util/k8s.ts` | `waitForContainerToStart`, `isContainerRunning` |
| `services/service-runner/app/util/axios-clients.ts` | Exponential-backoff axios factory and retryability predicate |
| `services/harmony/app/routers/backend-router.ts` | The `/service/work` GET/PUT endpoints the runner talks to |
