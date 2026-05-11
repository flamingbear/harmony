# Generated Guides — Index

These are AI-generated companion guides to the Harmony codebase. They focus on
mental models and cross-cutting concepts that aren't obvious from reading any
single file. They are a complement to, not a replacement for, the source code
and the hand-written docs in `docs/guides/`.

For canonical details (env vars, exact column types, current migration count),
defer to the code: `services/harmony/env-defaults`, `db/migrations/`, and
`config/services-*.yml`.

---

## Documents

### [`architecture.md`](architecture.md)
Orientation for a developer who has never seen the repo before. Covers the
tech stack, the seven services in the monorepo, the end-to-end request flow
from HTTP request to STAC output, and where to start reading code. Best
single-page overview; read this first.

### [`database-schema.md`](database-schema.md)
Reference for the eight workflow tables (`jobs`, `workflow_steps`,
`work_items`, `user_work`, `job_links`, `job_messages`, `batches`, plus the
labels and deployments tables). For each table, lists columns, the state
machine where applicable, and which services read or write it. Includes the
fair-queue algorithm executed against `user_work`. Use this when you need to
reason about a query or a migration.

### [`frontend.md`](frontend.md)
Express and middleware primer aimed at developers new to Node.js web stacks.
Walks through the request lifecycle, the middleware chain in
`app/middleware/`, the route map for the workflow UI, and the Mustache
template system. Read alongside `app/routers/router.ts`.

### [`work-updater.md`](work-updater.md)
Deep dive on the work-updater service — the authoritative writer of
work-item and job final state. Covers the SQS queues and message schema,
the per-job DB-transactional update path, the retry/failure branches
(including the unconditional `query-cmr` failure rule), and the
`createNextWorkItems` fan-out logic for aggregating vs. non-aggregating
next steps.

### [`work-failer.md`](work-failer.md)
Deep dive on the work-failer service — the periodic scanner that
synthesises failure updates for work items stuck in `RUNNING`/`QUEUED`
past a per-(job, service) timeout. Covers the doubled-max-duration
heuristic, the service-specific defaults (`casper`/`concise` at 15 min),
the update-queue backpressure throttle, and why the failer hands its
updates to the same `handleBatchWorkItemUpdatesWithJobId` entry point
that the work-updater uses.

### [`work-scheduler.md`](work-scheduler.md)
Deep dive on the work-scheduler service — the bridge from the database
to the per-service SQS queues. Covers the scheduler-queue input,
backpressure against the update queue, the two-regime `numItemsToQueue`
formula (starvation vs. steady-state, plus the `query-cmr` fast-path
coefficient), the Fisher-Yates job-list shuffle that lets multiple
scheduler replicas coexist, and the LRU-cached pod-count lookups.

### [`service-runner.md`](service-runner.md)
Deep dive on the service-runner — the manager container that runs in
every backend service pod. Covers the manager/worker container split,
the WORKING/TERMINATING file handshake with the K8s PreStop hook, the
`runServiceFromPull` (`kubectl exec`) vs. `runQueryCmrFromPull` (local
HTTP) split, the 100 KB inline-vs-file operation cutoff, the 137-as-OOM
mapping, and how STAC catalogs and `error.json` are pulled back from
S3 to populate the work-item update.

### [`service-selection.user-guide.md`](service-selection.user-guide.md)
End-user-facing guide. How to call `/capabilities`, how Harmony picks a
service for your request, when "best effort" applies, how to verify which
service ran your job, and the meaning of the common 422 errors. Written
for someone making API requests, not someone modifying the code.

### [`service-selection.technical.md`](service-selection.technical.md)
Implementation reference for the same logic. Walks through the six phases
(config load, collection association, explicit override, capability
filtering, best-effort fallback, instantiation) and lists each filter
function in `chooseServiceConfig` in the order it runs. Read this before
modifying `app/middleware/service-selection.ts` or
`app/models/services/index.ts`.

### [`services-yml.md`](services-yml.md)
Reference for `config/services-uat.yml` and `config/services-prod.yml` — the
service-chain registry that drives selection, workflow construction, and the
`/capabilities` endpoint. Documents every entry-level and step-level field
(against `ServiceConfig` / `ServiceStep` in `base-service.ts`), the
`!Env`/`SERVICES_YML` loading mechanics, the startup validator's rules, and a
checklist for adding a new chain.
