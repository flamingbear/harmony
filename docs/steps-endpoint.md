# Steps endpoint

## Purpose

Return, in JSON, the complete chain of service invocations for a Harmony job: which service and version was called, what inputs it received, what outputs it produced, and enough of the original request to reason about and replay the job.

A primary use case is **debugging a failed service**: given a failed work item, a developer wants the actual data file URL that was passed to that service.

A secondary use case is **Parital Job Completion** — Allowing a user who had a workstep that may have failed the ability to find and get the output that did work.

Is there a third usecase? Replaying failed jobs?  This is perhaps after MVP. Add cmr/operation/full request


## Route

```
GET /jobs/:jobID/steps
GET /admin/jobs/:jobID/steps
```

Auth: identical to jobs endpoint: `GET /jobs/:jobID` — `getJobIfAllowed(...)`
Owner, admin, or holder of a shared-job access token may view.

## Query parameters

| Param      | Values                          | Effect                                                                                                                     |
|------------|---------------------------------|----------------------------------------------------------------------------------------------------------------------------|
| `step`     | integer                         | Limit to one or more steps in the job service chain (filters on `workflowStepIndex`) e.g. just net2cog steps               |
| `status`   | `WorkItemStatus` values         | Limit to work items by one or more statuses. [`ready`, `queued`, `running`, `successful`, `failed`, `canceled`, `warning`] |
| `workItem` | integer                         | Limit to one or more work items by id.                                                                                     |
| `page`     | integer (default 1)             | Page number for work items.                                                                                                |
| `perPage`  | integer (default 100, max 1000) | Page size for work items.                                                                                                  |

Query filters are pushed into the SQL `WHERE` clause via the existing `queryAll` work-item helper, so a job with a million work items never round-trips a million rows. Pagination metadata is included in the response and is the bound on expanding file locations from s3 and fetching work-items.


## Response shape

```json
{
  "jobID": "<uuid>",
  "serviceName": "service name from service-{ENV}.yml",
  "status": "complete_with_errors",
  "progress": 100,
  "message": "The job has completed with errors. See the errors field for more details",
  "username": "esdis-username",
  "numInputGranules": 5,
  "request": "https://harmony.../ogc-api-coverages/...?...",
  "steps": [
    {
      "stepIndex": 1,
      "serviceID": "harmonyservices/query-cmr:latest",
      "workItemCount": 1,
      "statuses": {
        "successful": 1
      },
      "workItems": [
        {
          "id": 9491393,
          "status": "successful",
          "retryCount": 0,
          "inputFiles": null,
          "outputFiles": [
            "https://harmony.example/service-results/staging-bucket/public/.../granule_xyz.nc4"
          ]
        }
      ]
    },
    {
      "stepIndex": 2,
      "serviceID": "nasa/harmony-opendap-subsetter:1.2.4",
      "workItemCount": 20,
      "statuses": {
        "successful": 19,
        "failure": 1
      },
      "workItems": [
        {
          "id": 9491415,
          "status": "successful",
          "retryCount": 0,
          "inputFiles": [
            "https://harmony.example/service-results/staging-bucket/public/.../granule_xyz.nc4"
          ],
          "outputFiles": [
            "https://harmony.example/service-results/staging-bucket/public/.../granule_xyz_subsetted.nc4"
          ]
        },
        {
          "id": 9491416,
          "status": "failure",
          "retryCount": 0,
          "inputFiles": [
            "https://harmony.example/service-results/staging-bucket/public/.../granule_xyz1.nc4"
          ],
          "outputFiles": [
            "https://harmony.example/service-results/staging-bucket/public/.../granule_xyz1_subsetted.nc4"
          ]
        },
        {
          "etc": "more worktems"
        }
      ],
      "paging": {
        "next": "link to next  block of workitems for harmony-opendap-subsetter"
      }
    }
  ]
}
```

### `inputFiles` / `outputFiles`

Each work item carries two flat fields, `inputFiles` and `outputFiles`,
each one of three values:

| Value | What it means |
|-------|---------------|
| `null` | Nothing to show. For `outputFiles`: the work item has not completed yet (its output catalog doesn't exist). For `inputFiles`: the work item has not completed yet. |
| `[]` | The work item completed but the relevant catalog was missing, unreadable, or had no STAC items with `role: 'data'`. |
| `["https://harmony.../service-results/.../granule_xyz.nc4", ...]` | Resolved data hrefs. |

The handler resolves catalogs only for WIs in `COMPLETED_WORK_ITEM_STATUSES` (`successful`, `failed`, `canceled`, `warning`). Incomplete WIs have both `inputFiles` and `outputFiles` set to `null`.
URLs are signed via the same `createPublicPermalink` path that `/jobs/:jobID` uses for `links` hrefs.

#### Truncation of large query-cmr outputs

Reading STAC catalogs from S3 is one round-trip per catalog file. A query-cmr work item that produced thousands of granules would force thousands of reads per page of work items, which could dominate the response time.

To bound that fan-out operation, the handler caps the number of catalog files it reads per work item at `MAX_BATCH_CATALOGS` (currently 100). When a `batch-catalogs.json` lists more than that, only the first `MAX_BATCH_CATALOGS`(100) are resolved and the last element of `outputFiles` is the sentinel string:

```
"Not all files resolved, there are <N> more files not shown"
```

where `<N>` is the count of catalog files skipped (`total - MAX_BATCH_CATALOGS`). This only affects query-cmr-style work items (`wi.scrollID` set); regular service work items always have exactly one output catalog file and are never truncated.

I have added a sentinal for the case where a file is created and it's somewhere we can't create a link to, not after a `/public` path in s3., that returns `<private file location>` but I'm not sure that's useful or needed.


## Redactions

I don't know for sure how important the `operation` block is for this service. But it is built by allow-list — only `sources`, `format`, `subset`, `extendDimensions`, `temporal`, `concatenate`, `average`, `pixelSubset`, and `extraArgs` are forwarded. Everything else, including the encrypted `accessToken` and internals (`callback`, `stagingLocation`, `requestId`, etc.), are dropped.

## Open Questions / limitations

1. Long requests, POST with large bodies get truncated.
   - Should we save the entire POSTed body to s3 when we exceed the URL limit of 4096 that can be stored in the database?  I assume the workflow-ui, presents even less than that and maybe just the GET encoded full (up to 4096) will be pretty good? good enough?
   - Where would that be writen? `s3://{artifactBucket}/{jobID}/request.json`.

2. Shapefiles? IDK.
   - Would those be available to include if uploaded? Would it be useful?

3. Operations block? Should we keep it?

4. Documentation?
   app/markdown/endpoints.md

5. Private file sentinal?  keep/ignore
