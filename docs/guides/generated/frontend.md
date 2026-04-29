## Frontend Deep Dive

### What is Express?

Express is a **traffic controller for the web server**. When someone visits a URL like `/workflow-ui`, Express figures out:

1. Who is this person? (authentication)
2. Are they allowed here? (authorization)
3. What do they want? (routing)
4. What should we send back? (response)

Express is built on a simple idea: **functions get called in sequence, each one can modify the request/response, then pass control to the next**.

---

### What is Middleware?

Middleware is a **function that runs between the request arriving and the response going out**. Each middleware function gets three things:

```typescript
function myMiddleware(req, res, next) {
  // req  = the incoming request (URL, headers, cookies, body)
  // res  = the outgoing response (what we send back)
  // next = a function to call when you're done — passes to the next middleware
}
```

Think of it like an **assembly line**:

```
HTTP Request → [Log it] → [Check auth] → [Parse params] → [Handle it] → HTTP Response
```

- If a step calls `next()`, the assembly line continues.
- If a step calls `res.send()`, the line stops and the response goes out.
- If a step calls `next(error)`, it jumps straight to the error handler.

---

### The Request Lifecycle

Here's what happens when you visit `/workflow-ui`:

**Step 1 — `server.ts`:** First-pass middleware runs on every single request:
```
addRequestId     → stamps a unique UUID on the request (for log tracking)
addRequestLogger → attaches a Winston logger to this specific request
```

**Step 2 — `routers/router.ts`:** The central hub. Auth middleware runs first for most routes:
```
cookie-parser          → reads cookies to find the session/token
EDL OAuth authorizer   → checks the user is logged in via NASA Earthdata Login
permission-groups      → checks if they're in admin or core groups
```

**Step 3 — Route matching:** Express matches the URL to a specific route handler:
```typescript
router.get('/workflow-ui', ...middleware..., workflow.getJobs);
```

**Step 4 — Handler runs:** The frontend file (in `app/frontends/`) queries the database, then renders a Mustache template (HTML) or returns JSON.

---

### Route Map

| URL Pattern | Handler | What it does |
|---|---|---|
| `/` | `landing-page.ts` | NASA Harmony landing page |
| `/jobs` | `jobs.ts` | JSON API for jobs |
| `/workflow-ui` | `workflow-ui.ts:getJobs` | Browser UI — jobs list |
| `/workflow-ui/:jobID` | `workflow-ui.ts:getJob` | Single job details |
| `/workflow-ui/:jobID/work-items` | `workflow-ui.ts:getWorkItemsTable` | Work items in a job |
| `/workflow-ui/:jobID/work-items/:id` | `workflow-ui.ts:getWorkItemTableRow` | Single work item row (AJAX) |
| `/workflow-ui/:jobID/links` | `workflow-ui.ts:getJobLinks` | Available state-change actions |
| `/workflow-ui/:jobID/:id/retry` | `workflow-ui.ts:retry` | Retry a failed work item |
| `/admin/workflow-ui` | same handlers | Admin version (sees all users' jobs) |
| `/:collection/wms` | `wms.ts` | WMS map service |
| `/ogc-api-coverages/...` | science handlers | OGC data access API |
| `/ogc-api-edr/...` | science handlers | OGC EDR data access API |
| `/admin/request-metrics` | `request-metrics.ts` | Request statistics |
| `/service-image-tag` | `service-image-tags.ts` | Service container management |
| `/logs/:jobID/:id` | `workflow-ui.ts:getWorkItemLogs` | Work item logs (admin only) |
| `/health` | `health.ts` | Health check |
| `/docs/api` | Swagger UI | OGC Coverages API documentation |
| `/docs/edr-api` | Swagger UI | OGC EDR API documentation |

---

### Middleware Stack (in order)

All middleware files live in `app/middleware/`.

| Order | Middleware | Purpose |
|---|---|---|
| 1 | `addRequestId` | Stamps a unique UUID on every request |
| 2 | `addRequestLogger` | Attaches a Winston logger to the request |
| 3 | `cookie-parser` | Reads cookies to find session/token |
| 4 | `earthdata-login-oauth-authorizer.ts` | OAuth flow with NASA Earthdata Login |
| 5 | `earthdata-login-token-authorizer.ts` | Token-based auth validation |
| 6 | `permission-groups.ts` | Checks admin/core group membership |
| 7 | `cmr-collection-reader.ts` | Parses collection IDs from the URL |
| 8 | `cmr-granule-locator.ts` | Queries CMR for granule metadata |
| 9 | `parameter-validation.ts` | Validates params against OpenAPI spec |
| 10 | `shapefile-upload.ts` | Handles multipart form data for shapefiles |
| 11 | `shapefile-converter.ts` | Converts shapefiles to GeoJSON |
| 12 | `service-selection.ts` | Chooses the right backend service |
| 13 | `error-handler.ts` | Catches all errors, formats as JSON or HTML |

Not every middleware runs on every route — `shapefile-upload` / `shapefile-converter` only run on routes that accept a shapefile, and `cmr-granule-locator` only runs on routes that operate on granules. The order above reflects the order in which middleware that *does* run is composed.

Once middleware finishes, the data-access routes (WMS, OGC Coverages, OGC EDR) hand off to a route handler — `serviceInvoker` (`app/backends/service-invoker.ts`) — which does the actual job creation and submission. It is registered with the route, not as middleware, even though it sits at the end of the same logical chain.

---

### Key Source Files

| File | Role |
|---|---|
| `app/server.ts` | Boots both servers |
| `app/routers/router.ts` | All route definitions |
| `app/routers/backend-router.ts` | Backend service callback routes |
| `app/frontends/workflow-ui.ts` | Main UI handler (jobs, work items) |
| `app/frontends/jobs.ts` | JSON jobs API |
| `app/middleware/` | All middleware functions |
| `app/views/workflow-ui/` | Mustache HTML templates |
| `public/js/workflow-ui/` | Browser-side JavaScript |
| `public/css/workflow-ui/` | Stylesheets |

---

### The Template System (Mustache)

HTML pages use Mustache templates (files ending in `.mustache.html`). This is a fill-in-the-blanks system:

```html
<!-- Template -->
<p>Hello, {{username}}!</p>

<!-- After rendering with { username: 'Alice' } -->
<p>Hello, Alice!</p>
```

The server builds a data object and passes it to the template engine (`mustache-express`), which merges them and sends HTML to the browser.

Key template files:
- `app/views/workflow-ui/jobs/index.mustache.html` — jobs listing page
- `app/views/workflow-ui/job/index.mustache.html` — single job detail page
- `app/views/workflow-ui/job/work-items-table.mustache.html` — work items table
- `app/views/workflow-ui/jobs/jobs-table.mustache.html` — jobs table rows (for pagination)

---

### Key Functions in `workflow-ui.ts`

| Function | Lines | What it does |
|---|---|---|
| `getJobs()` | ~347–424 | Renders the jobs list with filters/pagination |
| `getJob()` | ~434–467 | Renders a single job's detail page |
| `getJobLinks()` | ~477–494 | Returns available actions (pause, resume, cancel) |
| `getWorkItemsTable()` | ~591–649 | Renders work items table with pagination |
| `getWorkItemTableRow()` | ~659–688 | Renders a single work item row (AJAX updates) |
| `getJobsTable()` | ~698–759 | Renders job table rows for pagination |
| `getWorkItemLogs()` | ~769–788 | Returns work item logs from S3 (admin only) |
| `retry()` | ~797–825 | Requeues a failed work item |
| `redirectWithoutTrailingSlash()` | ~836–845 | Middleware: strips trailing slashes |

---

### Mental Model

> Express is like a **pipe** with **filters** (middleware) attached. Each request flows through all the filters in order. Most filters just check/modify something and pass it along. The last stop is the route handler that actually builds the response.
>
> If something goes wrong anywhere in the pipe, the error jumps straight to `error-handler.ts`, bypassing everything else.
