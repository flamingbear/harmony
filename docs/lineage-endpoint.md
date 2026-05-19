# Lineage endpoint

## Purpose

Return, in JSON, the complete chain of service invocations for a Harmony job:
which service was called, what inputs it received, what outputs it produced,
and enough of the original request to reason about (and eventually replay)
the job.

The primary use case is **debugging a failed service**: given a failed work
item, a developer wants the actual data file URL that was passed to that
service. A secondary use case is **job introspection** — a JSON-shaped view
of the data the existing HTML `/workflow-ui/:jobID` page already renders.

## Route

```
GET /jobs/:jobID/lineage
GET /admin/jobs/:jobID/lineage
```

Auth: identical to `GET /jobs/:jobID` — `getJobIfAllowed(...)` in
`services/harmony/app/util/job.ts`. Owner, admin, or holder of a shared-job
access token may view.

## Query parameters

| Param | Values | Effect |
|-------|--------|--------|
| `step` | integer | Limit to one workflow step (filters work items by `workflowStepIndex`). |
| `status` | one of the `WorkItemStatus` values | Limit to work items in a single status. |
| `workItem` | integer | Limit to a single work item by id. |
| `page` | integer (default 1) | Page number for work items. |
| `perPage` | integer (default 100, max 1000) | Page size for work items. |

All filters are pushed into the SQL `WHERE` clause via the existing `queryAll`
work-item helper, so a job with a million work items never round-trips a
million rows. Pagination metadata is included in the response and is the bound
on expanding file location and fetching work-items cost.


## Response shape

```json
{
  "jobID": "<uuid>",
  "status": "failed",
  "progress": 80,
  "message": "...",
  "username": "esdis username",
  "numInputGranules": 5,
  "createdAt": "2026-05-12T08:42:04.123Z",
  "updatedAt": "2026-05-12T08:46:37.000Z",

  "request": {
    "url": "https://harmony.../ogc-api-coverages/...?...",
    "method": "GET",
    "body": null,
    "bodyNote": "POST bodies are not persisted by Harmony today.",
    "truncated": false
  },

  "operation": {
    "sources": [ /* collections, variables, granules */ ],
    "format": { /* mime, srs, scaleExtent, ... */ },
    "subset": { /* bbox, temporal, dimensions, geojson, ... */ },
    "extendDimensions": [],
    "temporal": { "start": "...", "end": "..." },
    "concatenate": false,
    "average": null,
    "pixelSubset": false,
    "extraArgs": { /* service-specific config */ }
  },

  "steps": [
    {
      "stepIndex": 1,
      "serviceID": "harmonyservices/query-cmr:latest",
      "workItemCount": 1,

      "cmr": {
        "endpoint": "https://cmr.earthdata.nasa.gov",
        "calls": [
          {
            "workItemId": 9491393,
            "params": { /* contents of s3://{stagingBucket}/SearchParams/<scrollID>/serializedQuery */ }
          }
        ]
      },

      "workItems": [
        {
          "id": 9491393,
          "status": "successful",
          "retryCount": 0,
          "startedAt": "2026-05-12T08:42:05.000Z",
          "duration": 1234,
          "totalItemsSize": 1024,
          "messageCategory": null,
          "input": null,
          "output": {
            "catalog": "s3://artifacts/<jobID>/9491393/outputs/catalog.json",
            "files": ["s3://staging-bucket/.../granule_xyz.nc4"]
          },
          "logs": "s3://artifacts/<jobID>/9491393/logs.json"
        }
      ]
    },

    {
      "stepIndex": 2,
      "serviceID": "nasa/harmony-opendap-subsetter:1.2.4",
      "workItemCount": 1,

      "workItems": [
        {
          "id": 9491415,
          "status": "failed",
          "retryCount": 0,
          "startedAt": "2026-05-12T08:43:12.000Z",
          "duration": 1234,
          "input":  { "catalog": "s3://artifacts/<jobID>/9491393/outputs/catalog.json", "files": ["s3://staging-bucket/.../granule_xyz.nc4"] },
          "output": { "catalog": "s3://artifacts/<jobID>/9491415/outputs/catalog.json", "files": [] },
          "logs":   "s3://artifacts/<jobID>/9491415/logs.json"
        }
      ]
    }
  ],

  "pagination": {
    "currentPage": 1,
    "perPage": 100,
    "total": 5,
    "lastPage": 1
  }
}
```

### The `files` contract

Every `input` and `output` has both a `catalog` URL and a `files` value:

| `files` value | What it means |
|---|---|
| `null` | The owning work item has not completed yet. The `catalog` URL is the deterministic S3 path the output *will* land at. |
| `[]` | The work item completed but the catalog was missing, unreadable, or had no STAC items with `role: 'data'`. Common case: a failed WI whose service didn't write its output catalog. |
| `["s3://..."]` | The catalog was read; these are the data hrefs (verbatim — Harmony does not rewrite `s3://` vs `https://`). |

The handler resolves catalogs only for WIs in `COMPLETED_WORK_ITEM_STATUSES`
(`successful`, `failed`, `canceled`, `warning`). Incomplete WIs (`ready`,
`queued`, `running`) never trigger S3 reads, so a running job's lineage
returns quickly with `files: null` everywhere.

`files[]` comes from walking the STAC catalog: `catalog.json` (which lists
`./catalogN.json` item links), then each item file's `assets[*].href` where
the asset has `role: 'data'` (or asset name `data`). This is the same logic
that `services/harmony/app/util/stac.ts` already uses for batch generation
and work-item updates.

URLs are returned **verbatim** — Harmony does not rewrite `s3://` vs `https://`
for staged outputs. Whichever protocol the producing service wrote is what
the lineage endpoint reports.

## Data sources

| Field | Source |
|-------|--------|
| Job-level fields | `Job.byJobID` (`services/harmony/app/models/job.ts`) |
| `request.url` | `jobs.request` column, stored at job creation; max 4096 chars. The `truncated` flag is set when `length === 4096`. |
| `request.method`/`body` | Not stored today; `body` is always `null` and `bodyNote` explains. Becomes populated by the Option B follow-up below. |
| Steps | `getWorkflowStepsByJobId` (`workflow-steps.ts:182`) — includes the `operation` JSON string per step (not exposed per-step; see `operation` row below). |
| `operation` | One canonical block at the response root, derived from step 1's stored `workflow_steps.operation` JSON. Projected to an allow-list: `sources`, `format`, `subset`, `extendDimensions`, `temporal`, `concatenate`, `average`, `pixelSubset`, `extraArgs`. Internal fields (`accessToken`, `callback`, `stagingLocation`, `user`, `client`, `version`, `requestId`, `isSynchronous`, `$schema`) are dropped. The operation is largely identical across steps, so we surface it once instead of duplicating per step. |
| Work items | `queryAll` (`work-item.ts:417`) with a `WorkItemQuery.where` clause containing `jobID` + any of `workflowStepIndex`/`status`/`id`. Filters run in SQL; results paginated with `isLengthAware` so total counts are accurate. |
| `pagination` | The `ILengthAwarePagination` object returned by `queryAll` (knex-paginate). |
| `input.catalog` | `work_items.stacCatalogLocation` (null for the first step / query-cmr) |
| `output.catalog` | Deterministic: `getStacLocation(workItem)` in `work-item-interface.ts:118` — `s3://{artifactBucket}/{jobID}/{wiId}/outputs/catalog.json` |
| `logs` | Deterministic: `getItemLogsLocation(workItem)` in `work-item-interface.ts:128` |
| `cmr.params` | For each query-cmr work item, one S3 GET of `s3UrlForStoredQueryParams(scrollID)` (`cmr.ts:1315`) |
| `cmr.endpoint` | `env.cmrEndpoint` |
| `files[]` for completed WIs | `readCatalogItems(catalogUrl)` then `getCatalogLinks(items)` in `services/harmony/app/util/stac.ts`. The handler collects the unique set of catalog URLs across all *completed* WIs on the current page and resolves them with `Promise.all`, so duplicated catalogs (step N output ≡ step N+1 input) cost a single S3 GET and incomplete WIs cost zero. |

## Redactions

The `operation` block is built by allow-list — only `sources`, `format`,
`subset`, `extendDimensions`, `temporal`, `concatenate`, `average`,
`pixelSubset`, and `extraArgs` are forwarded. Everything else, including
the encrypted `accessToken` (`data-operation.ts:886`) and internal
plumbing (`callback`, `stagingLocation`, `requestId`, etc.), is dropped.
Allow-listing also means newly added operation fields stay private by
default unless deliberately added to the public set.

## Known limitations

These are intentional gaps in v1. Each is surfaced honestly in the response
(via `bodyNote`, `truncated`, or by being null) rather than hidden.

1. **POST request body is not persisted.** Harmony stores the request URL
   but not the JSON or form body of POSTs. For POST jobs, `request.body`
   is null. The Option B follow-up below addresses this.
2. **GET URL is capped at 4096 chars on save.** The `jobs.request` column is
   varchar; `Job.save()` truncates beyond 4096. URLs longer than that are
   already lost by the time the lineage endpoint runs. The `truncated` flag
   reports when this happened.
3. **Failed work items may have no output catalog.** When a service fails
   before writing its STAC output, `output.catalog` still points to the
   deterministic S3 path, but a GET will 404. `expand=outputs` will either
   skip the entry or return an empty `files[]`.
4. **Per-work-item error messages are not in the response.** The `work_items`
   table persists `message_category` but not the `message` text itself — the
   message is only set transiently during update processing
   (`work-item-updates.ts:1068`) and routed to `job_messages` and logs.
   Use `logs` (S3 path) or `messageCategory` to investigate failures.
5. **Retried work items lose their prior attempts.** Harmony updates the
   same `work_items` row across retries; only the latest attempt's
   `startedAt`/`duration`/`message` are visible. Lineage reports the
   `retryCount` so callers know retries happened.
6. **Batched / aggregated steps are not distinguishable from this endpoint.**
   When a service step uses batching or output aggregation, the relationship
   between input and output files is not 1:1 — a single work item may consume
   many upstream catalogs. The response does not expose this; callers cannot
   tell from the lineage endpoint whether a given step batches or aggregates.
   If needed, query `workflow_steps` directly for the `isBatched` /
   `hasAggregatedOutput` flags.

## Cost

Per request: one DB read for the job, one for the workflow steps, one
paginated SQL query for the work items (bounded by `perPage`, default 100),
plus one S3 GET per query-cmr work item on the current page for the CMR
`serializedQuery` (typically 1 per job).

STAC resolution: the handler builds the set of unique catalog URLs across
the *completed* WIs on the page (input + output sides, deduplicated) and
resolves them in parallel via `Promise.all`. For a typical chain where
each step's output ≡ next step's input, this is `S` catalog reads for
`S` steps' worth of WIs on the page, plus `~1` STAC item GET per catalog.
Incomplete WIs are skipped, so a running job's lineage costs essentially
nothing in S3 reads. `perPage` (default 100, max 1000) bounds the worst
case independently of total job size.

## Follow-up work (Option B): persist POST request bodies

Add a write at job-creation time that uploads the raw POST body to
`s3://{artifactBucket}/{jobID}/request.json`. The lineage handler then
attempts to read this object and, when present, populates
`request.body`. Scope (per the prior design discussion):

- POST JSON bodies only. GET URLs continue to come from `jobs.request`.
- TEXT migration on `jobs.request` is **out of scope**. The 4096 cap stays.
- Shapefile preservation (copying from `temp-user-uploads/` to a persistent
  location) is out of scope.

This is a separate PR. The lineage endpoint code already accommodates it —
when `request.json` does not exist, `request.body` is null and the
explanatory `bodyNote` is included.
