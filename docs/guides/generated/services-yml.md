# `services-*.yml` — Service Chain Configuration

## What this file is

`config/services-uat.yml` and `config/services-prod.yml` declare every backend
service chain Harmony knows about. Each entry binds a CMR UMM-S record to an
ordered pipeline of Docker images and tells the service-selection logic which
operations the chain can satisfy. Adding a new backend service means adding an
entry here.

The active file is selected at startup based on `env.cmrEndpoint`: a UAT
endpoint loads `services-uat.yml`, anything else loads `services-prod.yml`
(`app/models/services/index.ts:89-94`). Alternatively, the file contents can be
supplied base64-encoded via the `SERVICES_YML` env var, which is how a
Kubernetes ConfigMap injects it.

`!Env ${VAR}` substitution is applied on load, so most image tags and
auth-related env vars are resolved from the surrounding pod environment rather
than being hardcoded in the YAML.

---

## Top-level structure

```yaml
x-turbo-config: &default-turbo-config        # YAML anchor — reused in each service
  name: turbo
  params: &default-turbo-params
    env: &default-turbo-env
      ...

https://cmr.uat.earthdata.nasa.gov:          # CMR endpoint key — must match env.cmrEndpoint
  - name: harmony/download
    ...
  - name: asdc/casper
    ...
```

The single top-level key is the CMR endpoint URL. Its value is an array of
service-chain entries. Order matters when more than one entry advertises the
same `umm_s`-collection association: the first wins.

The `x-turbo-config` block at the top of each file is a YAML-anchor convention
(unrecognized by the loader) used to share boilerplate `env` blocks. The `<<:
*default-turbo-config` merge keys in each service entry expand it.

---

## Entry fields

Authoritative type: `ServiceConfig<T>` in
`app/models/services/base-service.ts:74`.

### Identity

| Field | Type | Notes |
|---|---|---|
| `name` | string | Human-readable identifier; used for `service_name` on jobs and as a `?serviceId=` value |
| `description` | string | Surfaced via the `/capabilities` endpoint |
| `data_operation_version` | string | Version of the `DataOperation` schema sent to the service (e.g. `'0.22.0'`) |
| `umm_s` | string | CMR UMM-S concept ID. **Required** unless `capabilities.all_collections: true`. Validated at startup |
| `enabled` | bool/string | `false` (or `"false"`) excludes the entry at load time |

### Collection binding

Collections are normally not listed in this file — they are discovered
dynamically by reading `collection.associations.services` from CMR and
matching against `umm_s`. The exception:

- An env var named `<NAME>_COLLECTIONS` (with `name` upper-cased and `-`/`/`
  replaced by `_`) injects collection IDs at runtime. A warning is logged when
  this path is taken. This is mainly used for testing.
- `capabilities.all_collections: true` declares a chain that matches every
  collection (e.g. `harmony/download`).

A `collections:` array can also appear inline, but per the validator it may
only be used to attach `granule_limit` or `variables` overrides — *not* to
establish associations.

### Capabilities

```yaml
capabilities:
  subsetting:
    bbox: true
    shape: true
    temporal: true
    variable: true
    multiple_variable: true
    dimension: true
  reprojection: true
  concatenation: true
  concatenate_by_default: true
  averaging:
    time: true
    area: true
  extend: true
  default_extend_dimensions: ['lon']
  output_formats:
    - application/x-netcdf4
    - image/tiff
  all_collections: true
```

These flags are what `chooseServiceConfig` filters against
(see `service-selection.technical.md`). If a request asks for an operation that
isn't listed here, the chain is eliminated. The output-format filter accepts
the MIME types listed in `output_formats`.

### Execution policy

| Field | Type | Default | Effect |
|---|---|---|---|
| `type.name` | `turbo` \| `http` | required | `turbo` means K8s pods + SQS (production); `http` is direct-HTTP and only used for the built-in example service |
| `type.params.env` | object | `{}` | Env vars passed into the service pod |
| `maximum_sync_granules` | int | env default | Cap for sync responses; `-1` disables sync entirely (force async); `0` means the chain only runs async |
| `default_sync` | bool | unset | If true, requests default to sync mode |
| `has_granule_limit` | bool | true | If false, bypasses the global granule-count cap |
| `granule_limit` | int | unset | Per-chain granule cap |
| `concurrency` | int | unset | Maximum concurrent invocations (rate-limit hint) |
| `validate_variables` | bool | true | If false, skip variable validation against UMM-Var |
| `external_validation_url` | string | unset | URL to POST the operation to for service-specific validation |
| `message` | string | unset | Custom warning attached to job output |

### Steps (the actual pipeline)

```yaml
steps:
  - image: !Env ${QUERY_CMR_IMAGE}
    is_sequential: true
  - image: !Env ${PODAAC_L2_SUBSETTER_IMAGE}
    operations: ['variableSubset', 'spatialSubset']
    conditional:
      exists: ['variableSubset', 'spatialSubset']
  - image: !Env ${PODAAC_CONCISE_IMAGE}
    always_wait_for_prior_step: true
    is_batched: true
    max_batch_inputs: 100
    max_batch_size_in_bytes: 10000000000
    operations: ['concatenate']
    conditional:
      exists: ['concatenate']
```

Authoritative type: `ServiceStep` in `base-service.ts:47`.

| Field | Type | Effect |
|---|---|---|
| `image` | string | Docker image to run for this step. Almost always `!Env ${SOMETHING_IMAGE}` |
| `is_sequential` | bool | Step processes items one at a time. **Required for `query-cmr`** — enforced by the validator |
| `is_batched` | bool | Step aggregates groups of inputs into single invocations |
| `max_batch_inputs` | int | Max input count per batch invocation. Validator rejects non-positive integers |
| `max_batch_size_in_bytes` | int | Max combined input size per batch invocation |
| `always_wait_for_prior_step` | bool | Don't start until *all* prior-step items finish (enables full aggregation) |
| `operations` | string[] | Which operations from the `DataOperation` this step performs. Each value must correspond to a flag in the chain's `capabilities` — the validator catches mismatches. Known values: `concatenate`, `dimensionSubset`, `extend`, `reformat`, `reproject`, `shapefileSubset`, `spatialSubset`, `temporalSubset`, `variableSubset` |
| `conditional` | object | Skip the step unless the request matches |
| `conditional.exists` | string[] | Step runs if *any* listed operation is present in the request |
| `conditional.format` | string[] | Step runs only if the requested output format is listed |
| `conditional.umm_c.native_format` | string[] | Step runs only if the collection's UMM-C native format is listed |
| `extra_args` | object | Free-form key/value extra params merged into the step invocation |

Step requirement is computed per request by `stepRequired`
(`base-service.ts:188`). The combination of `conditional.exists`,
`conditional.format`, and `conditional.umm_c` is AND-ed: if any is set, all
must match for the step to run.

---

## Validation at startup

Each entry passes through `validateServiceConfig`
(`app/models/services/index.ts:206`) at require-time. Failures throw and crash
the process, so misconfiguration cannot be silent. The checks:

1. Either `umm_s` is a non-empty string **or** `capabilities.all_collections`
   is true. Otherwise: `There must be one and only one umm_s record configured...`
2. Inline `collections` entries may only set `granule_limit` or `variables` —
   not establish associations. Otherwise: `Collections cannot be configured for
   harmony service ..., use umm_s instead.`
3. `max_batch_inputs`, when present, must be a positive integer.
4. Every value in a step's `operations` must map to a `true` flag in the
   chain's `capabilities`. (E.g. a step listing `'concatenate'` requires
   `capabilities.concatenation: true`.)
5. `query-cmr` steps must declare `is_sequential: true`. Enforced by a regex
   on the image name.

---

## How the rest of Harmony consumes this file

| Consumer | What it reads |
|---|---|
| `chooseServiceConfig` (service-selection middleware) | Every field in `capabilities`; collections list (after CMR association); output formats |
| `BaseService` constructor / `TurboService` | `type.params`, `steps`, `default_sync`, `maximum_sync_granules`, `concurrency` |
| `WorkflowStep` row creation | `steps[i].image` → `serviceID`; step flags → `is_batched`, `is_sequential`, `always_wait_for_prior_step`, `maxBatchInputs`, `maxBatchSizeInBytes` |
| `/capabilities` frontend | Renders the per-collection view of capabilities |
| Job model | `name` → `service_name` column |

---

## Adding a new service chain

1. Append a new entry under the CMR endpoint key in **both** `services-uat.yml`
   and `services-prod.yml` (UAT first, prod when promoted).
2. Set `umm_s` to the chain's published UMM-S concept ID. Confirm CMR has the
   chain associated with the target collections.
3. Declare every operation the chain supports in `capabilities` — anything
   omitted will cause the chain to be filtered out for requests that need it.
4. List the Docker images in `steps`, in pipeline order. The first step is
   almost always `${QUERY_CMR_IMAGE}` with `is_sequential: true`. Add
   `conditional` blocks to skip work when the request doesn't need a given
   step.
5. If a step aggregates, set `always_wait_for_prior_step: true` and either
   `is_batched: true` (with `max_batch_inputs` / `max_batch_size_in_bytes`) or
   leave it as a non-batched aggregator.
6. Provide a `${NAME}_IMAGE` env var in the deployment so `!Env` resolves.
7. Restart Harmony. The startup validator will reject any inconsistency before
   the server begins serving traffic.

---

## Key files

| File | Role |
|---|---|
| `config/services-uat.yml` | Active config for UAT (CMR UAT endpoint) |
| `config/services-prod.yml` | Active config for production |
| `services/harmony/app/models/services/base-service.ts` | `ServiceConfig`, `ServiceStep`, `ServiceCapabilities` types; `stepRequired` |
| `services/harmony/app/models/services/index.ts` | `loadServiceConfigs`, `validateServiceConfig`, `chooseServiceConfig`, all filter functions |
| `services/harmony/app/middleware/service-selection.ts` | Per-request middleware that resolves a config and stashes it on `req.context` |
| `services/harmony/app/frontends/capabilities.ts` | Exposes the loaded config via `/capabilities` |
