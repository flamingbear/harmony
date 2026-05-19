import { NextFunction, Response } from 'express';

import HarmonyRequest from '../models/harmony-request';
import { TEXT_LIMIT } from '../models/job';
import WorkItem, { queryAll as queryWorkItems } from '../models/work-item';
import {
  COMPLETED_WORK_ITEM_STATUSES, getItemLogsLocation, getStacLocation,
  WorkItemQuery, WorkItemStatus,
} from '../models/work-item-interface';
import WorkflowStep, { getWorkflowStepsByJobId } from '../models/workflow-steps';
import { s3UrlForStoredQueryParams } from '../util/cmr';
import db from '../util/db';
import { isAdminUser } from '../util/edl-api';
import env from '../util/env';
import { RequestValidationError } from '../util/errors';
import { getJobIfAllowed } from '../util/job';
import { defaultObjectStore } from '../util/object-store';
import { getCatalogLinks, readCatalogItems } from '../util/stac';

const DEFAULT_PER_PAGE = 100;
const MAX_PER_PAGE = 1000;
// Derived from the enum so new statuses are picked up automatically. Safe for
// string enums (Object.values returns just the value strings, not the names).
const VALID_STATUSES = Object.values(WorkItemStatus);
// Allow-list of user-facing fields surfaced from the parsed DataOperation.
// Internal fields (accessToken, callback, stagingLocation, user, client, version,
// requestId, isSynchronous, $schema) are intentionally excluded. An allow-list
// avoids leaking newly added internal fields when the operation schema evolves.
const OPERATION_PUBLIC_FIELDS = [
  'sources', 'format', 'subset', 'extendDimensions', 'temporal',
  'concatenate', 'average', 'pixelSubset', 'extraArgs',
] as const;

interface LineageQuery {
  step?: number;
  status?: WorkItemStatus;
  workItem?: number;
  page: number;
  perPage: number;
}

interface ResolvedCatalog {
  catalog: string;
  // null  = the owning WI hasn't completed yet (no catalog to read).
  // []    = the WI completed but the catalog had no data assets (e.g. failed
  //         WI whose output catalog is missing, or a catalog with no items).
  // [...] = resolved data hrefs from the STAC catalog.
  files: string[] | null;
}

interface LineageWorkItem {
  id: number;
  status: WorkItemStatus;
  retryCount: number;
  startedAt: Date | null;
  input: ResolvedCatalog | null;
  output: ResolvedCatalog;
  logs: string;
}

interface LineageStep {
  stepIndex: number;
  serviceID: string;
  workItemCount: number;
  cmr?: {
    endpoint: string;
    calls: { workItemId: number; params: unknown }[];
  };
  workItems: LineageWorkItem[];
}

/**
 * Parse the query parameters used to filter and shape the lineage response.
 * Throws RequestValidationError on any invalid input.
 */
function parseQuery(query: Record<string, unknown>): LineageQuery {
  const out: LineageQuery = { page: 1, perPage: DEFAULT_PER_PAGE };

  if (query.step !== undefined) {
    const n = Number(query.step);
    if (!Number.isInteger(n) || n < 1) {
      throw new RequestValidationError('step must be a positive integer');
    }
    out.step = n;
  }

  if (query.status !== undefined) {
    const s = String(query.status) as WorkItemStatus;
    if (!VALID_STATUSES.includes(s)) {
      throw new RequestValidationError(`status must be one of: ${VALID_STATUSES.join(', ')}`);
    }
    out.status = s;
  }

  if (query.workItem !== undefined) {
    const n = Number(query.workItem);
    if (!Number.isInteger(n) || n < 1) {
      throw new RequestValidationError('workItem must be a positive integer');
    }
    out.workItem = n;
  }

  if (query.page !== undefined) {
    const n = Number(query.page);
    if (!Number.isInteger(n) || n < 1) {
      throw new RequestValidationError('page must be a positive integer');
    }
    out.page = n;
  }

  if (query.perPage !== undefined) {
    const n = Number(query.perPage);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PER_PAGE) {
      throw new RequestValidationError(`perPage must be a positive integer no greater than ${MAX_PER_PAGE}`);
    }
    out.perPage = n;
  }

  return out;
}

/**
 * Parse a workflow step's stored operation JSON and project it down to the
 * curated allow-list of user-facing fields. Returns null if the JSON cannot
 * be parsed. The allow-list ensures internal fields (accessToken, callback,
 * stagingLocation, etc.) are never leaked, even if the operation schema gains
 * new fields in the future.
 */
function pickPublicOperationFields(
  operationJson: string,
): Record<string, unknown> | null {
  if (!operationJson) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(operationJson);
  } catch {
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const key of OPERATION_PUBLIC_FIELDS) {
    if (parsed[key] !== undefined) out[key] = parsed[key];
  }
  return out;
}

/**
 * Read the input STAC catalog for a work item and return the resolved data
 * hrefs. Returns an empty array if the catalog cannot be read (e.g. the
 * service failed before producing it, or the catalog has no data assets).
 */
async function resolveDataHrefs(catalogUrl: string): Promise<string[]> {
  try {
    const items = await readCatalogItems(catalogUrl);
    return getCatalogLinks(items);
  } catch {
    return [];
  }
}

/**
 * Resolve every unique catalog URL referenced by completed work items in
 * parallel. Only WIs in COMPLETED_WORK_ITEM_STATUSES contribute URLs;
 * incomplete WIs reliably have no catalog yet, so attempting to read theirs
 * would be wasted 404s. Because step N's output catalog is byte-identical
 * to step N+1's input catalog, the Set-based dedupe ensures each unique
 * catalog is fetched exactly once across the whole page.
 *
 * Returns a map from catalog URL to its data hrefs (empty array when the
 * catalog is missing or has no data assets). Catalog URLs NOT in the map
 * belong to incomplete WIs; the handler treats those as `files: null`.
 */
async function resolveAllCatalogs(
  workItems: WorkItem[],
): Promise<Map<string, string[]>> {
  const urls = new Set<string>();
  for (const wi of workItems) {
    if (!COMPLETED_WORK_ITEM_STATUSES.includes(wi.status)) continue;
    if (wi.stacCatalogLocation) urls.add(wi.stacCatalogLocation);
    urls.add(getStacLocation({ id: wi.id, jobID: wi.jobID }, 'catalog.json'));
  }
  const entries = await Promise.all(
    Array.from(urls).map(async (url) => [url, await resolveDataHrefs(url)] as const),
  );
  return new Map(entries);
}

/**
 * Build the work item portion of the response. files[] is populated from
 * the precomputed `resolved` map; URLs missing from the map (because the
 * WI was incomplete when resolveAllCatalogs ran) surface as `files: null`.
 */
function buildWorkItem(
  wi: WorkItem,
  resolved: Map<string, string[]>,
): LineageWorkItem {
  const outputCatalog = getStacLocation({ id: wi.id, jobID: wi.jobID }, 'catalog.json');
  const input: ResolvedCatalog | null = wi.stacCatalogLocation
    ? {
      catalog: wi.stacCatalogLocation,
      files: resolved.get(wi.stacCatalogLocation) ?? null,
    }
    : null;
  const output: ResolvedCatalog = {
    catalog: outputCatalog,
    files: resolved.get(outputCatalog) ?? null,
  };

  return {
    id: wi.id,
    status: wi.status,
    retryCount: wi.retryCount,
    startedAt: wi.startedAt ?? null,
    input,
    output,
    logs: getItemLogsLocation({ id: wi.id, jobID: wi.jobID }),
  };
}

/**
 * For the work items belonging to a query-cmr step, fetch each stored CMR
 * query (one per scrollID) from S3 and return them inlined. Failures are
 * silent: if a SearchParams object is missing, that call is omitted.
 */
async function buildCmrCalls(
  workItems: WorkItem[],
): Promise<{ workItemId: number; params: unknown }[]> {
  const store = defaultObjectStore();
  const calls: { workItemId: number; params: unknown }[] = [];
  for (const wi of workItems) {
    if (!wi.scrollID) continue;
    try {
      const params = await store.getObjectJson(s3UrlForStoredQueryParams(wi.scrollID));
      calls.push({ workItemId: wi.id, params });
    } catch {
      // The SearchParams object may have been evicted or never written; skip.
    }
  }
  return calls;
}

/**
 * Build the full lineage step list. The workItems passed in are already
 * the filtered, paginated set; this function groups them under their parent
 * step. Steps whose stepIndex was filtered out by ?step= are omitted.
 */
async function buildSteps(
  steps: WorkflowStep[],
  workItems: WorkItem[],
  resolved: Map<string, string[]>,
  q: LineageQuery,
): Promise<LineageStep[]> {
  const byStep = new Map<number, WorkItem[]>();
  for (const wi of workItems) {
    const arr = byStep.get(wi.workflowStepIndex) ?? [];
    arr.push(wi);
    byStep.set(wi.workflowStepIndex, arr);
  }

  const result: LineageStep[] = [];
  for (const step of steps) {
    if (q.step !== undefined && step.stepIndex !== q.step) continue;
    const stepWorkItems = byStep.get(step.stepIndex) ?? [];

    const lineageStep: LineageStep = {
      stepIndex: step.stepIndex,
      serviceID: step.serviceID,
      workItemCount: step.workItemCount,
      workItems: stepWorkItems.map((wi) => buildWorkItem(wi, resolved)),
    };

    const cmrWorkItems = stepWorkItems.filter((wi) => wi.scrollID);
    if (cmrWorkItems.length > 0) {
      lineageStep.cmr = {
        endpoint: env.cmrEndpoint,
        calls: await buildCmrCalls(cmrWorkItems),
      };
    }

    result.push(lineageStep);
  }

  return result;
}

/**
 * Express handler for GET /jobs/:jobID/lineage. Returns a JSON document
 * describing the job, its workflow steps, and the inputs/outputs of the
 * filtered + paginated work items. See docs/lineage-endpoint.md for the
 * response shape.
 */
export async function getJobLineage(
  req: HarmonyRequest, res: Response, next: NextFunction,
): Promise<void> {
  const { jobID } = req.params;
  try {
    const q = parseQuery(req.query as Record<string, unknown>);

    const isAdmin = await isAdminUser(req);
    const job = await getJobIfAllowed(jobID, req.user, isAdmin, req.accessToken, true);

    const steps = await getWorkflowStepsByJobId(db, jobID);

    // Push every filter into the SQL WHERE clause so a million-WI job never
    // round-trips a million rows. queryAll paginates with isLengthAware so
    // we get total counts for pagination metadata.
    const workItemQuery: WorkItemQuery = {
      where: { jobID },
      orderBy: { field: 'id', value: 'asc' },
    };
    if (q.step !== undefined) workItemQuery.where.workflowStepIndex = q.step;
    if (q.status !== undefined) workItemQuery.where.status = q.status;
    if (q.workItem !== undefined) workItemQuery.where.id = q.workItem;

    const { workItems, pagination } = await queryWorkItems(
      db, workItemQuery, q.page, q.perPage,
    );

    const resolvedCatalogs = await resolveAllCatalogs(workItems);
    const lineageSteps = await buildSteps(steps, workItems, resolvedCatalogs, q);

    // The DataOperation is largely the same across steps (it gets passed
    // step-to-step with minor mutations); surface it once at the response
    // root using the first step as the canonical "what was asked of Harmony"
    // view, projected down to user-facing fields.
    const canonicalOperationStep = steps.find((s) => s.stepIndex === 1) ?? steps[0];
    const operation = canonicalOperationStep
      ? pickPublicOperationFields(canonicalOperationStep.operation)
      : null;

    const requestTruncated = !!job.request && job.request.length === TEXT_LIMIT;
    const lineage = {
      jobID: job.jobID,
      status: job.status,
      progress: job.progress,
      message: job.message,
      username: job.username,
      numInputGranules: job.numInputGranules,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      request: {
        url: job.request,
        method: 'GET',
        body: null as unknown,
        bodyNote: 'POST request bodies are not yet persisted by Harmony.',
        truncated: requestTruncated,
      },
      operation,
      steps: lineageSteps,
      pagination: {
        currentPage: pagination.currentPage,
        perPage: pagination.perPage,
        total: pagination.total,
        lastPage: pagination.lastPage,
      },
    };

    res.json(lineage);
  } catch (e) {
    req.context.logger.error(e);
    next(e);
  }
}
