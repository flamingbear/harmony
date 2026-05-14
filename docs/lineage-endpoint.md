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
| `status` | `ready` \| `running` \| `successful` \| `failed` \| `canceled` | Limit to work items in a single status. |
| `workItem` | integer | Limit to a single work item by id. |
| `expand` | `inputs` \| `outputs` \| `both` | Read the relevant STAC catalogs from S3 and inline the resolved data hrefs as `files[]` on each work item. Applies only to the filtered set. |
| `max` | integer (default 500) | Maximum number of work items expanded. If the filtered-and-expanded set exceeds this, respond with `413 Payload Too Large` and a message pointing the caller at the filter params. |

The cap exists as a safety belt. From production data, 99.7% of jobs have ≤10
work items and the largest observed job has ~500. The default of 500
accommodates every job seen so far while protecting against a future job that
scrolls hundreds of thousands of granules.

## Response shape

```json
{
  "jobID": "<uuid>",
  "status": "failed",
  "progress": 80,
  "message": "...",
  "username": "ahowe42",
  "request": "https://harmony.../ogc-api-coverages/...?...",
  "numInputGranules": 5,
  "createdAt": "2026-05-12T08:42:04.123Z",
  "updatedAt": "2026-05-12T08:46:37.000Z",

  "originalRequest": {
    "url": "https://harmony.../ogc-api-coverages/...?...",
    "method": "GET",
    "body": null,
    "bodyNote": "POST bodies are not persisted by Harmony today. See follow-up: write request.json to artifact bucket.",
    "truncated": false
  },

  "steps": [
    {
      "stepIndex": 1,
      "serviceID": "harmonyservices/query-cmr:latest",
      "isBatched": false,
      "hasAggregatedOutput": false,
      "isComplete": true,
      "workItemCount": 1,
      "operation": { /* DataOperation with `accessToken` removed */ },

      "cmr": {
        "endpoint": "https://cmr.earthdata.nasa.gov",
        "calls": [
          {
            "workItemId": 9491393,
            "sessionKey": "<scrollID>",
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
            "catalog": "s3://artifacts/<jobID>/9491393/outputs/catalog.json"
          },
          "logs": "s3://artifacts/<jobID>/9491393/logs.json"
        }
      ]
    },

    {
      "stepIndex": 2,
      "serviceID": "nasa/harmony-opendap-subsetter:1.2.4",
      "isBatched": false,
      "hasAggregatedOutput": false,
      "isComplete": false,
      "workItemCount": 1,
      "operation": { /* DataOperation with `accessToken` removed */ },

      "workItems": [
        {
          "id": 9491415,
          "status": "failed",
          "retryCount": 0,
          "startedAt": "2026-05-12T08:43:12.000Z",
          "duration": 1234,
          "input":  { "catalog": "s3://artifacts/<jobID>/9491393/outputs/catalog.json" },
          "output": { "catalog": "s3://artifacts/<jobID>/9491415/outputs/catalog.json" },
          "logs":   "s3://artifacts/<jobID>/9491415/logs.json"
        }
      ]
    }
  ]
}
```

With `?workItem=9491415&expand=inputs`, the matching work item's `input` is
augmented:

```json
"input": {
  "catalog": "s3://artifacts/<jobID>/9491393/outputs/catalog.json",
  "files": [
    "s3://staging-bucket/.../granule_xyz.nc4"
  ]
}
```

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
| `originalRequest.url` | `jobs.request` column, stored at job creation; max 4096 chars. The `truncated` flag is set when `length === 4096`. |
| `originalRequest.method`/`body` | Not stored today; `body` is always `null` and `bodyNote` explains. Becomes populated by the Option B follow-up below. |
| Steps | `getWorkflowStepsByJobId` (`workflow-steps.ts:182`) — already includes the `operation` JSON string per step |
| `operation` | `JSON.parse(step.operation)` with the `accessToken` key removed before serialization. Matches `services/harmony/app/util/log-redactor.ts` precedent. |
| Work items | `getWorkItemsByJobId` (`work-item.ts:484`), filtered in-memory by `step`/`status`/`workItem` query params |
| `input.catalog` | `work_items.stacCatalogLocation` (null for the first step / query-cmr) |
| `output.catalog` | Deterministic: `getStacLocation(workItem)` in `work-item-interface.ts:118` — `s3://{artifactBucket}/{jobID}/{wiId}/outputs/catalog.json` |
| `logs` | Deterministic: `getItemLogsLocation(workItem)` in `work-item-interface.ts:128` |
| `cmr.params` | For each query-cmr work item, one S3 GET of `s3UrlForStoredQueryParams(scrollID)` (`cmr.ts:1315`) |
| `cmr.endpoint` | `env.cmrEndpoint` |
| Expanded `files[]` | `readCatalogItems(catalogUrl)` then `getCatalogLinks(items)` in `services/harmony/app/util/stac.ts` |

## Redactions

`DataOperation.accessToken` (encrypted EDL token, `data-operation.ts:886`) is
the only field in the operation JSON that is sensitive. It is stripped
before the response is built. Harmony already redacts this field in logs
(`log-redactor.ts:27-38`) and we follow that precedent.

## Known limitations

These are intentional gaps in v1. Each is surfaced honestly in the response
(via `bodyNote`, `truncated`, or by being null) rather than hidden.

1. **POST request body is not persisted.** Harmony stores the request URL
   but not the JSON or form body of POSTs. For POST jobs, `originalRequest.body`
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
6. **Batched / aggregated steps are not 1:1 input→output.** When `isBatched`
   or `hasAggregatedOutput` is true, the aggregated work item's input catalog
   indexes many upstream catalogs. v1 reports the flags and lets callers
   handle the fan-in/fan-out themselves; we don't enumerate per-batch
   membership.

## Cost

Default response (no `expand`): one DB read for the job, one for the
workflow steps, one for the work items. Plus one S3 GET per query-cmr work
item for the CMR `serializedQuery` (typically 1 per job).

With `?expand=`: an additional `1 + N` S3 GETs per expanded work item, where
N is the number of STAC items in that work item's catalog. N is typically
1–10. The `max` cap (default 500) bounds the worst case.

## Follow-up work (Option B): persist POST request bodies

Add a write at job-creation time that uploads the raw POST body to
`s3://{artifactBucket}/{jobID}/request.json`. The lineage handler then
attempts to read this object and, when present, populates
`originalRequest.body`. Scope (per the prior design discussion):

- POST JSON bodies only. GET URLs continue to come from `jobs.request`.
- TEXT migration on `jobs.request` is **out of scope**. The 4096 cap stays.
- Shapefile preservation (copying from `temp-user-uploads/` to a persistent
  location) is out of scope.

This is a separate PR. The lineage endpoint code already accommodates it —
when `request.json` does not exist, `originalRequest.body` is null and the
explanatory `bodyNote` is included.
