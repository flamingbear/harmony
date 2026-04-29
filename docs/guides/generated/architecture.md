## Harmony: Architecture Overview for New Developers

**Harmony** is a NASA EOSDIS platform that orchestrates geospatial data processing workflows. It provides a unified API for accessing, subsetting, and transforming Earth science data across multiple NASA data centers (DAACs) in AWS.

---

### Tech Stack

- **Runtime:** Node.js + TypeScript
- **Framework:** Express.js
- **Database:** PostgreSQL (SQLite for tests) via Knex.js
- **Orchestration:** Kubernetes
- **Cloud:** AWS (S3, SQS, ECR)
- **Monorepo:** Lerna (multiple packages under `services/` and `packages/`)
- **Testing:** Mocha + Chai + Sinon, with PollyJS for HTTP recording/replay

---

### Major Services

| Service | Role |
|---|---|
| **harmony** (`services/harmony`) | The main API server. Runs a **frontend** (port 3000) for user-facing REST APIs and a **backend** (port 4000) for receiving work results from service pods. |
| **work-scheduler** | Polls the DB for "ready" work items and dispatches them to the correct service queue (SQS). |
| **service-runner** | Runs as a sidecar in each K8s service pod. Pulls work items from SQS, executes the actual data-processing service, and posts results back to the backend. |
| **work-updater** | Processes work item status updates from queues. |
| **work-failer** | Handles failures, retries, and cascading error logic. |
| **query-cmr** | Queries NASA's Common Metadata Repository to find matching granules. |
| **cron-service** | Background maintenance (job expiration, cleanup, metrics). |

---

### Request Flow

```
User Request (OGC Coverages, OGC EDR, etc.)
       │
       ▼
  Express Middleware Chain (auth → CMR lookup → validation → service selection)
       │
       ▼
  Frontend Handler creates a Job + Workflow Steps + Work Items in the DB
       │
       ▼
  Work-Scheduler picks up ready items → sends to SQS queues
       │
       ▼
  Service-Runner pods pull from SQS → execute processing → post results back
       │
       ▼
  Backend processes results, advances workflow, updates job status
       │
       ▼
  Job completes → results available via STAC catalog / S3 links
```

Jobs follow a state machine: `accepted → running → successful/failed/canceled`

---

### Key Directories

| Path | What's There |
|---|---|
| `services/harmony/app/routers/` | Express route definitions — **start here** to understand the API |
| `services/harmony/app/middleware/` | Auth, CMR integration, parameter validation, service selection |
| `services/harmony/app/frontends/` | API endpoint handlers (OGC Coverages, EDR, Jobs, STAC, Workflow UI) |
| `services/harmony/app/backends/workflow-orchestration/` | Core workflow engine — how work items progress through service chains |
| `services/harmony/app/models/` | Database models (Job, WorkItem, WorkflowSteps, Batch, etc.) |
| `services/harmony/app/util/` | Shared utilities (DB, logging, queues, S3, CMR client, caching) |
| `db/migrations/` | Knex migrations tracking schema evolution (59 at last count) |
| `config/services-*.yml` | Service definitions — which Docker images handle which collections |
| `packages/util/` | Shared `@harmony/util` package |
| `services/harmony/test/` | Test suite with HTTP recordings |

---

### Database

Key tables: **jobs**, **workflow_steps**, **work_items**, **job_links**, **user_work** (fair queueing), **batches**. Schema is managed through Knex migrations in `db/migrations/`.

---

### Common Patterns

1. **Middleware chain** — each middleware enriches the request (auth, CMR data, validation) before the handler runs
2. **Queue-driven processing** — SQS decouples the API from backend processing, enabling horizontal scaling
3. **State machine** — Jobs and work items follow defined status transitions (via `xstate`)
4. **Worker polling loops** — Background services poll DB/queues with graceful shutdown handling

---

### Getting Started

```bash
./bin/create-dotenv           # Set up environment
npm install
./bin/bootstrap-harmony       # Deploy to local K8s
npm run start-dev-fast        # Run locally with hot reload
npm test                      # Run test suite
```

The best entry point for reading code is `services/harmony/app/routers/router.ts` — follow the middleware chain and handlers from there.
