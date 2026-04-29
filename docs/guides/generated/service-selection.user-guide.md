# Understanding Service Selection in Harmony

## What is "service selection"?

When you make a request to Harmony, it automatically routes your request to the backend service (or chain of services) best suited to fulfill it. You do not need to know which service runs — Harmony matches your request against what is available for the collection you are accessing and what operations you asked for.

This guide explains how to discover what services are available, what Harmony will and won't do for a given request, and how to influence service selection when needed.

---

## Step 1: Discover what Harmony can do for a collection

Before making a data request, check the capabilities endpoint to see which operations Harmony supports for your collection.

**By collection concept ID:**
```
GET /capabilities?collectionId=C1234567890-PROVIDER
```

**By short name:**
```
GET /capabilities?shortName=MY_COLLECTION_SHORT_NAME
```

The response lists every operation the collection supports across all configured services:

```json
{
  "conceptId": "C1234567890-PROVIDER",
  "shortName": "MY_COLLECTION_SHORT_NAME",
  "variableSubset": true,
  "bboxSubset": true,
  "shapeSubset": false,
  "temporalSubset": true,
  "concatenate": false,
  "reproject": true,
  "outputFormats": ["image/tiff", "application/x-netcdf4"],
  "services": [
    {
      "name": "my-service-name",
      "href": "https://cmr.earthdata.nasa.gov/search/concepts/S1234-PROVIDER",
      "capabilities": { ... }
    }
  ],
  "variables": [ ... ]
}
```

If a capability is `false` at the top level, no service associated with this collection supports it. Requesting it will result in an error.

**Tip**: Use `?version=2` to get a richer response that includes per-service capability details and links to UMM-S records.

---

## Step 2: Understand how Harmony picks a service

Harmony narrows the list of candidates by applying filters in order, one per requested operation. The first service that satisfies all your requested operations is selected.

The filters run in this order:

1. **Collection match** — only services associated with your collection are considered
2. **Concatenation** — if you requested concatenation, only services that support it remain
3. **Variable subsetting** — if you specified variables, only services that support variable subsetting remain
4. **Spatial subsetting** — if you specified a bounding box, only services that support bbox subsetting remain
5. **Temporal subsetting** — if you specified a time range, only services that support temporal subsetting remain
6. **Dimension subsetting** — if you specified dimension ranges, only services that support dimension subsetting remain
7. **Reprojection** — if you specified a target CRS, only services that support reprojection remain
8. **Output format** — only services that can produce your requested format remain (checked last)

If at any point the list reaches zero, the request fails with HTTP 422 and a message identifying which combination of operations is unsupported.

---

## Step 3: Know when you get "best effort" results

If you combine spatial or temporal subsetting with other required operations (variable subsetting, reprojection, reformatting, etc.) and no single service supports all of them, Harmony falls back to a **best-effort** match:

- It drops the spatial and/or temporal subsetting requirement
- It selects a service that satisfies everything else
- Your results will include a message:

> "Data in output files may extend outside the spatial and temporal bounds you requested."

This means the data is reformatted or reprojected as you asked, but the spatial/temporal clipping was skipped because no service could do it alongside the other operations.

**If you requested only spatial or temporal subsetting (nothing else), best effort does not apply** — Harmony will return an error if it cannot clip the data rather than silently returning unclipped output.

---

## Step 4: Verify which service was used

After submitting a request, the job status response includes a `service_name` field that identifies which service chain handled the job:

```
GET /jobs/{jobId}
```

```json
{
  "jobID": "...",
  "status": "successful",
  "service_name": "my-service-name",
  ...
}
```

You can also filter job listings by service name using the `service_name` parameter on the jobs list endpoint.

---

## Step 5: Request a specific service (admin/power-user feature)

If you need to target a specific service chain — for testing or to bypass automatic selection — you can add `serviceId` to your request:

```
GET /C1234567890-PROVIDER/ogc-api-coverages/1.0.0/collections/all/coverage/rangeset
    ?serviceId=S9876543210-PROVIDER
```

`serviceId` can be either a CMR UMM-S concept ID (e.g. `S9876543210-PROVIDER`) or the service chain name from `services.yml`.

**Whether this is available depends on the deployment.** It is controlled by the `ALLOW_SERVICE_SELECTION` environment variable (the as-shipped default in `env-defaults` is `true`, but individual deployments may set it to `false`). If it is disabled and you include `serviceId`, you will receive:

> "Requesting a service chain using serviceId is disabled in this environment."

---

## Common error scenarios

### "no operations can be performed on \<collection\>"

No service is associated with the collection you requested. Either the collection is not configured for use with Harmony, or you do not have access to the underlying CMR collection.

**Check**: Run the `/capabilities` endpoint for your collection. If the `services` array is empty, the collection has no Harmony backend.

### "the requested combination of operations: \<list\> on \<collection\> is unsupported"

One or more operations you requested are not available for this collection. The error message identifies the specific combination.

**Check**: Examine `bboxSubset`, `shapeSubset`, `temporalSubset`, `reproject`, `outputFormats`, etc. in the `/capabilities` response to see what is actually available.

### "Could not find a service chain that matched the provided serviceId"

You used `?serviceId=` but the value did not match any service's UMM-S concept ID or name.

**Check**: Use the `/capabilities` endpoint for the collection; the `services[].href` links point to the CMR UMM-S records, and `services[].name` shows the chain names.

---

## Summary

| Goal | How |
|---|---|
| See what operations are available for a collection | `GET /capabilities?collectionId=<id>` |
| See which service was used for a submitted job | `GET /jobs/<jobId>` — check `service_name` |
| Request a specific service (if enabled) | Add `?serviceId=<umm_s_concept_id_or_name>` |
| Understand why a request failed | Read the 422 error — it names the unsupported operation combination |
| Understand best-effort spatial/temporal results | Look for the warning message in the job status |
