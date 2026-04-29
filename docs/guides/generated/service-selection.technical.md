# Service Selection — Technical Reference

## Overview

Service selection is performed by the `chooseService` middleware (`app/middleware/service-selection.ts`) on every request that carries a populated `operation.sources`. The result is stored on `req.context.serviceConfig` and consumed by downstream handlers to instantiate the right `BaseService` subclass.

The key function is `chooseServiceConfig` in `app/models/services/index.ts`.

---

## Phase 1: Config Loading (startup)

At require-time, `index.ts` loads `config/services-uat.yml` or `config/services-prod.yml` depending on the value of `env.cmrEndpoint`. The file is either read from disk or decoded from the `SERVICES_YML` environment variable (base64), which allows Kubernetes to inject it as a ConfigMap.

Each entry in the YAML represents a service chain and declares:

| Field | Purpose |
|---|---|
| `name` | Human-readable identifier (also filterable) |
| `type.name` | `turbo` (SQS/K8s) or `http` (direct HTTP) |
| `umm_s` | CMR UMM-S concept ID that links the service to collections |
| `capabilities` | What operations the chain supports |
| `steps` | Ordered list of Docker images in the pipeline |
| `collections` | Optional hard-coded collection overrides |
| `enabled` | If `false`, excluded from configs at load time |

After parsing, each config is validated (`validateServiceConfig`): services without `all_collections` must have a `umm_s` string, steps must declare only capabilities they advertise, and query-cmr steps must have `is_sequential: true`.

The loaded array is module-level state. A `resetServiceConfigs()` function exists for test resets.

---

## Phase 2: Collection → Service Association (per request)

`addCollectionsToServicesByAssociation(collections)` is called with the CMR collections already resolved by `cmr-collection-reader` middleware.

For each collection in the request, it reads `collection.associations.services` — a list of UMM-S concept IDs that CMR has associated with that collection. Any service config whose `umm_s` value appears in that list gets the collection pushed into its `.collections` array (deduplicated).

This is the primary mechanism. Collections do not normally appear statically in `services.yml`; the YAML only carries the `umm_s` ID, and CMR is the source of truth for which collections are associated.

**Exception**: An env var `<SERVICE_NAME>_COLLECTIONS` (e.g., `MY_SERVICE_COLLECTIONS=C1234-PROVIDER,C5678-OTHER`) can inject collections directly at runtime, bypassing CMR associations. A warning is logged when this path is taken.

---

## Phase 3: Explicit Service Override (`?serviceId=`)

If the query string contains `serviceId` and `env.allowServiceSelection` is `true` (disabled by default), the middleware bypasses Phase 2 entirely and does a direct lookup:

```
configs.find(config => config.umm_s === serviceId || config.name === serviceId)
```

The matched config's `.collections` array is extended with the request's collection IDs. A `RequestValidationError` is thrown if the ID is not found or the feature is disabled.

---

## Phase 4: Capability-Based Filtering (`chooseServiceConfig` → `filterServiceConfigs`)

The candidate list (all configs that now include the request's collections) is passed through a chain of filter functions in a fixed order. Each function either passes the list through unchanged or narrows it to configs that satisfy one capability dimension. Each filter accumulates to a `requestedOperations` string for use in error messages.

The filter chain (`allFilterFns`), in order:

```
filterCollectionMatches          → config.collections includes all request collection IDs
                                   (or config.capabilities.all_collections = true)
filterConcatenationMatches       → capabilities.concatenation     (only if shouldConcatenate)
filterVariableSubsettingMatches  → capabilities.subsetting.variable  (only if variables requested)
filterSpatialSubsettingMatches   → capabilities.subsetting.bbox      (only if bbox present)
filterTemporalSubsettingMatches  → capabilities.subsetting.temporal  (only if temporal present)
filterDimensionSubsettingMatches → capabilities.subsetting.dimension (only if dim subset requested)
filterReprojectionMatches        → capabilities.reprojection          (only if CRS requested)
filterExtendMatches              → capabilities.extend                (only if extendDimensions set)
filterAreaAveragingMatches       → capabilities.averaging.area        (only if average = 'area')
filterTimeAveragingMatches       → capabilities.averaging.time        (only if average = 'time')
filterShapefileSubsettingMatches → capabilities.subsetting.shape      (only if shapefile provided)
filterOutputFormatMatches        → capabilities.output_formats vs. Accept / outputFormat
                                   (runs last — see caveat below)
```

**Output format filter caveat**: The format filter must run last because it resolves the best matching MIME type across the surviving set of services. Running it earlier could eliminate a service that a different accepted MIME type would have permitted.

If any filter reduces the list to zero, it throws `UnsupportedOperation` (HTTP 422) immediately, short-circuiting the rest of the chain.

After all filters, `filterServiceConfigs` calls `selectFormat` once more on the survivors, sets `operation.outputFormat`, and returns `matches[0]` — the first surviving config wins.

---

## Phase 5: Best-Effort Fallback

If `allFilterFns` throws `UnsupportedOperation` and `requiresStrictCapabilitiesMatching` returns `false`, the selection retries with `requiredFilterFns`:

```
requiredFilterFns = [
  filterCollectionMatches,
  filterConcatenationMatches,
  filterVariableSubsettingMatches,
  filterDimensionSubsettingMatches,
  filterReprojectionMatches,
  filterExtendMatches,
  filterAreaAveragingMatches,
  filterTimeAveragingMatches,
  filterOutputFormatMatches,
]
```

Spatial subsetting (`bbox`, `shape`) and temporal subsetting are omitted. The idea: if a user requests spatial clipping + reformatting and no single service does both, Harmony will pick a service that can reformat and attach the warning:

> "Data in output files may extend outside the spatial and temporal bounds you requested."

**`requiresStrictCapabilitiesMatching` logic**: strict matching is used when the request involves *only* spatial/temporal subsetting (no variable subsetting, no reprojection, no reformatting, no concatenation, no dimension subsetting, no extend). In that case, best-effort is not invoked — if no service supports the operation, the request fails.

---

## Phase 6: Service Class Instantiation

The resolved `serviceConfig` is stored on `req.context.serviceConfig`. A downstream handler calls:

```ts
buildService(serviceConfig, operation)
// → new TurboService(serviceConfig, operation)
// or new HttpService(serviceConfig, operation)  (only for harmony/example)
```

The `service_name` field of the resulting `Job` record is set from `serviceConfig.name`.

---

## Key Files

| File | Role |
|---|---|
| `app/middleware/service-selection.ts` | Express middleware: Phase 2 + 3, stores result on context |
| `app/models/services/index.ts` | `chooseServiceConfig`, all filter functions, config loading |
| `app/models/services/base-service.ts` | `ServiceConfig` and `ServiceCapabilities` type definitions |
| `app/models/services/turbo-service.ts` | Kubernetes/SQS execution path (production default) |
| `app/models/services/http-service.ts` | Direct HTTP execution path (test only) |
| `config/services-uat.yml` / `services-prod.yml` | Service chain definitions |
| `app/frontends/capabilities.ts` | `/capabilities` endpoint — exposes this logic to users |
