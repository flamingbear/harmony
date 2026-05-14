import { NextFunction, Response } from 'express';

import HarmonyRequest from '../models/harmony-request';
import { TEXT_LIMIT } from '../models/job';
import WorkItem, { getWorkItemsByJobId } from '../models/work-item';
import { getItemLogsLocation, getStacLocation, WorkItemStatus } from '../models/work-item-interface';
import WorkflowStep, { getWorkflowStepsByJobId } from '../models/workflow-steps';
import { s3UrlForStoredQueryParams } from '../util/cmr';
import db from '../util/db';
import { isAdminUser } from '../util/edl-api';
import env from '../util/env';
import { HttpError, RequestValidationError } from '../util/errors';
import { getJobIfAllowed } from '../util/job';
import { defaultObjectStore } from '../util/object-store';
import { getCatalogLinks, readCatalogItems } from '../util/stac';

const DEFAULT_MAX_EXPANDED = 500;
const VALID_STATUSES: WorkItemStatus[] = [
  WorkItemStatus.READY, WorkItemStatus.QUEUED, WorkItemStatus.RUNNING,
  WorkItemStatus.SUCCESSFUL, WorkItemStatus.FAILED, WorkItemStatus.CANCELED,
  WorkItemStatus.WARNING,
];
const VALID_EXPAND = ['inputs', 'outputs', 'both'] as const;
type ExpandMode = typeof VALID_EXPAND[number];

interface LineageQuery {
  step?: number;
  status?: WorkItemStatus;
  workItem?: number;
  expand?: ExpandMode;
  max: number;
}

interface ResolvedCatalog {
  catalog: string;
  files?: string[];
}

interface LineageWorkItem {
  id: number;
  status: WorkItemStatus;
  retryCount: number;
  startedAt: Date | null;
  duration: number;
  totalItemsSize: number | null;
  messageCategory: string | null;
  input: ResolvedCatalog | null;
  output: ResolvedCatalog;
  logs: string;
}

interface LineageStep {
  stepIndex: number;
  serviceID: string;
  isBatched: boolean;
  hasAggregatedOutput: boolean;
  isComplete: boolean;
  workItemCount: number;
  operation: Record<string, unknown> | null;
  cmr?: {
    endpoint: string;
    calls: { workItemId: number; sessionKey: string; params: unknown }[];
  };
  workItems: LineageWorkItem[];
}

class PayloadTooLargeError extends HttpError {
  constructor(message: string) {
    super(413, message);
  }
}

/**
 * Parse the query parameters used to filter and shape the lineage response.
 * Throws RequestValidationError on any invalid input.
 */
function parseQuery(query: Record<string, unknown>): LineageQuery {
  const out: LineageQuery = { max: DEFAULT_MAX_EXPANDED };

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

  if (query.expand !== undefined) {
    const e = String(query.expand) as ExpandMode;
    if (!VALID_EXPAND.includes(e)) {
      throw new RequestValidationError(`expand must be one of: ${VALID_EXPAND.join(', ')}`);
    }
    out.expand = e;
  }

  if (query.max !== undefined) {
    const n = Number(query.max);
    if (!Number.isInteger(n) || n < 1) {
      throw new RequestValidationError('max must be a positive integer');
    }
    out.max = n;
  }

  return out;
}

/**
 * Parse the workflow step's stored operation JSON and strip the encrypted
 * accessToken before exposing the operation in the response. Returns null if
 * the operation string is empty or cannot be parsed.
 */
function sanitizeOperation(operationJson: string): Record<string, unknown> | null {
  if (!operationJson) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(operationJson);
  } catch {
    return null;
  }
  delete parsed.accessToken;
  return parsed;
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
 * Build the work item portion of the response. When expand is requested, the
 * relevant catalog(s) are read from S3 and inlined as files[].
 */
async function buildWorkItem(
  wi: WorkItem,
  expand: ExpandMode | undefined,
): Promise<LineageWorkItem> {
  const input: ResolvedCatalog | null = wi.stacCatalogLocation
    ? { catalog: wi.stacCatalogLocation }
    : null;
  const output: ResolvedCatalog = {
    catalog: getStacLocation({ id: wi.id, jobID: wi.jobID }, 'catalog.json'),
  };

  if (input && (expand === 'inputs' || expand === 'both')) {
    input.files = await resolveDataHrefs(input.catalog);
  }
  if (expand === 'outputs' || expand === 'both') {
    output.files = await resolveDataHrefs(output.catalog);
  }

  return {
    id: wi.id,
    status: wi.status,
    retryCount: wi.retryCount,
    startedAt: wi.startedAt ?? null,
    duration: wi.duration,
    totalItemsSize: wi.totalItemsSize ?? null,
    messageCategory: wi.message_category ?? null,
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
): Promise<{ workItemId: number; sessionKey: string; params: unknown }[]> {
  const store = defaultObjectStore();
  const calls: { workItemId: number; sessionKey: string; params: unknown }[] = [];
  for (const wi of workItems) {
    if (!wi.scrollID) continue;
    try {
      const params = await store.getObjectJson(s3UrlForStoredQueryParams(wi.scrollID));
      calls.push({ workItemId: wi.id, sessionKey: wi.scrollID, params });
    } catch {
      // The SearchParams object may have been evicted or never written; skip.
    }
  }
  return calls;
}

/**
 * Apply the step/status/workItem filters to the loaded work items.
 */
function filterWorkItems(workItems: WorkItem[], q: LineageQuery): WorkItem[] {
  return workItems.filter((wi) => {
    if (q.step !== undefined && wi.workflowStepIndex !== q.step) return false;
    if (q.status !== undefined && wi.status !== q.status) return false;
    if (q.workItem !== undefined && wi.id !== q.workItem) return false;
    return true;
  });
}

/**
 * Build the full lineage step list, including CMR enrichment for query-cmr
 * steps. Each step's workItems[] is the filtered, expanded subset.
 */
async function buildSteps(
  steps: WorkflowStep[],
  workItems: WorkItem[],
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
      isBatched: step.isBatched,
      hasAggregatedOutput: step.hasAggregatedOutput,
      isComplete: step.is_complete,
      workItemCount: step.workItemCount,
      operation: sanitizeOperation(step.operation),
      workItems: await Promise.all(stepWorkItems.map((wi) => buildWorkItem(wi, q.expand))),
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
 * describing the job, its workflow steps, and the inputs/outputs of every
 * work item. See docs/lineage-endpoint.md for the response shape.
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

    // Load every work item for the job (no DB-level filter; jobs are at most
    // ~500 WIs in practice and the per-WI rows are small). Filtering and
    // expansion happen in memory below.
    const { workItems: allWorkItems } = await getWorkItemsByJobId(db, jobID, 1, Number.MAX_SAFE_INTEGER);
    const filtered = filterWorkItems(allWorkItems, q);

    if (q.expand && filtered.length > q.max) {
      throw new PayloadTooLargeError(
        `expand would resolve ${filtered.length} work items, exceeding max=${q.max}. ` +
        'Narrow with ?step=, ?status=, or ?workItem=, or raise ?max=.',
      );
    }

    const lineageSteps = await buildSteps(steps, filtered, q);

    const requestTruncated = !!job.request && job.request.length === TEXT_LIMIT;
    const lineage = {
      jobID: job.jobID,
      status: job.status,
      progress: job.progress,
      message: job.message,
      username: job.username,
      request: job.request,
      numInputGranules: job.numInputGranules,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      originalRequest: {
        url: job.request,
        method: 'GET',
        body: null as unknown,
        bodyNote: 'POST request bodies are not persisted by Harmony today. '
          + 'When the artifact-bucket follow-up lands, JSON bodies will appear here.',
        truncated: requestTruncated,
      },
      steps: lineageSteps,
    };

    res.json(lineage);
  } catch (e) {
    req.context.logger.error(e);
    next(e);
  }
}
