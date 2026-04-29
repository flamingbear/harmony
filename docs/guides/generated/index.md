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
