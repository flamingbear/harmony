import { NextFunction, Response } from 'express';

import HarmonyRequest from '../models/harmony-request';
import { TEXT_LIMIT } from '../models/job';
import WorkItem, { queryAll as queryWorkItems } from '../models/work-item';
import {
  COMPLETED_WORK_ITEM_STATUSES, getStacLocation, WorkItemQuery, WorkItemStatus,
} from '../models/work-item-interface';
import WorkflowStep, { getWorkflowStepsByJobId } from '../models/workflow-steps';
import { sanitizeImage } from '@harmony/util/string';

import { createPublicPermalink } from './service-results';
import { s3UrlForStoredQueryParams } from '../util/cmr';
import db from '../util/db';
import { isAdminUser } from '../util/edl-api';
import env from '../util/env';
import { RequestValidationError } from '../util/errors';
import { getJobIfAllowed } from '../util/job';
import { defaultObjectStore } from '../util/object-store';
import { getCatalogLinks, readCatalogItems } from '../util/stac';
import { getRequestRoot } from '../util/url';

const DEFAULT_PER_PAGE = 100;
const MAX_PER_PAGE = 1000;
const VALID_STATUSES = Object.values(WorkItemStatus);

// List of fields presented to the user surfaced from the parsed DataOperation.
const OPERATION_PUBLIC_FIELDS = [
  'sources', 'format', 'subset', 'extendDimensions', 'temporal',
  'concatenate', 'average', 'pixelSubset', 'extraArgs',
] as const;

// query parameters for the steps endpoint
interface StepsQuery {
  step?: number;
  status?: WorkItemStatus;
  workItem?: number;
  page: number;
  perPage: number;
}

interface StepWorkItem {
  id: number;
  status: WorkItemStatus;
  retryCount: number;
  inputFiles: string[] | null;
  outputFiles: string[] | null;
}

interface JobStep {
  serviceID: string;
  stepIndex: number;
  workItemCount: number;
  cmr?: {
    endpoint: string;
    calls: { workItemId: number; params: unknown }[];
  };
  workItems: StepWorkItem[];
}

/**
 * Parse the query parameters used to filter and shape the steps response.
 *
 * @param query - the raw request query string parameters
 * @returns the validated and normalized steps query
 * @throws RequestValidationError - if any parameter is not a valid value
 */
function parseQuery(query: Record<string, unknown>): StepsQuery {
  const out: StepsQuery = { page: 1, perPage: DEFAULT_PER_PAGE };

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
 * Parse a workflow step's operation JSON and pare it down to the
 * curated list of fields to show the user.
 *
 * @param operationJson - the serialized DataOperation from a workflow step
 * @returns the operation pared to just OPERATION_PUBLIC_FIELDS, or null if the
 *   JSON is empty or cannot be parsed
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
 * Read a STAC catalog and return the resolved data hrefs it references.
 *
 * @param catalogUrl - the location of the STAC catalog to read
 * @returns the data hrefs from the catalog, or an empty array if the catalog
 *   cannot be read (e.g. the service failed before producing it, or the
 *   catalog has no data assets)
 */
async function resolveDataHrefs(catalogUrl: string): Promise<string[]> {
  try {
    const items = await readCatalogItems(catalogUrl);
    return getCatalogLinks(items);
  } catch {
    return [];
  }
}

// Placeholder used in inputFiles / outputFiles when a STAC asset href cannot
// be turned into a public link.
// TODO [MHS, 05/21/2026] I don't think this will ever be used, should I keep
// it?.  I was thinking it would be for the artifact buckets originally, but
// only the catalogs are behind private locations.
const PRIVATE_FILE_PLACEHOLDER = '<private file location>';

/**
 * Convert a raw STAC asset href into the public-facing form Harmony uses
 * for job links. S3 URLs under `/public/` become `<root>/service-results/...`
 * permalinks (which pre-sign on follow); HTTPS URLs pass through.
 *
 * @param href - the raw STAC asset href to convert
 * @param frontendRoot - The root URL to use when producing Harmony permalinks
 * @returns the public-facing link, or the PRIVATE_FILE_PLACEHOLDER sentinel if
 *   the href cannot be signed (e.g. an S3 URL outside `/public/`)
 */
function safePublicLink(href: string, frontendRoot: string): string {
  try {
    return createPublicPermalink(href, frontendRoot);
  } catch {
    return PRIVATE_FILE_PLACEHOLDER;
  }
}

interface ResolvedCatalogs {
  // public-facing data hrefs per catalog file URL (input catalogs + each
  // catalog file within a WI's outputs directory)
  catalogHrefs: Map<string, string[]>;
  // for each completed WI, the list of catalog file URLs that make up its
  // outputs (enumerated via getStacCatalogs). Absence from this map means
  // the WI was incomplete and outputs should surface as null.
  wiOutputCatalogs: Map<number, string[]>;
}

/**
 * Read query-cmr's `batch-catalogs.json` (the JSON array of catalog filenames
 * it writes alongside its catalogN.json output catalogs) and return absolute
 * URLs to each. Returns [] when the file isn't readable — e.g. the query-cmr
 * WI failed before writing it, or produced no granules.
 *
 * Only meaningful for query-cmr WIs; regular services write a top-level
 * `catalog.json` instead of `batch-catalogs.json`.
 *
 * @param outputDir - the WI's outputs directory URL
 * @returns absolute URLs to each catalogN.json file
 */
async function readBatchCatalogs(outputDir: string): Promise<string[]> {
  try {
    const filenames = await defaultObjectStore().getObjectJson(
      `${outputDir}batch-catalogs.json`,
    ) as string[];
    return filenames.map((f) => `${outputDir}${f}`);
  } catch {
    return [];
  }
}

/**
 * For every completed work item, determine its output catalog file URLs, then
 * resolve each unique catalog URL (inputs + outputs) to public-facing data
 * hrefs in parallel.
 *
 * @param workItems - the page of work items whose catalogs should be resolved
 * @param frontendRoot - the root URL to use when producing Harmony permalinks
 * @returns the per-catalog hrefs map and per-WI output catalog list (see
 *   ResolvedCatalogs)
 */
async function resolveAllCatalogs(
  workItems: WorkItem[],
  frontendRoot: string,
): Promise<ResolvedCatalogs> {
  const completed = workItems.filter((wi) => COMPLETED_WORK_ITEM_STATUSES.includes(wi.status));

  // Determine each completed WI's output catalog file URLs.
  //   - query-cmr WIs (wi.scrollID is set) write multiple catalogN.json files
  //     indexed by batch-catalogs.json, with no top-level catalog.json.
  //   - All other services write a single top-level catalog.json that fans
  //     out to items via rel=item links.
  const wiOutputCatalogs = new Map<number, string[]>();
  await Promise.all(completed.map(async (wi) => {
    if (wi.scrollID) {
      const outputDir = getStacLocation({ id: wi.id, jobID: wi.jobID });
      wiOutputCatalogs.set(wi.id, await readBatchCatalogs(outputDir));
    } else {
      wiOutputCatalogs.set(wi.id, [getStacLocation({ id: wi.id, jobID: wi.jobID }, 'catalog.json')]);
    }
  }));

  // Collect every unique catalog file URL we need to read: each completed WI's
  // input (stacCatalogLocation) plus every catalog file in its outputs.
  // Dedupe handles the step N output ≡ step N+1 input overlap.
  const allUrls = new Set<string>();
  for (const wi of completed) {
    if (wi.stacCatalogLocation) allUrls.add(wi.stacCatalogLocation);
    for (const url of wiOutputCatalogs.get(wi.id) ?? []) allUrls.add(url);
  }

  const catalogHrefs = new Map<string, string[]>();
  await Promise.all(Array.from(allUrls).map(async (url) => {
    const rawHrefs = await resolveDataHrefs(url);
    catalogHrefs.set(url, rawHrefs.map((h) => safePublicLink(h, frontendRoot)));
  }));

  return { catalogHrefs, wiOutputCatalogs };
}

/**
 * Build the work item portion of the response. inputFiles / outputFiles are
 * populated from the precomputed `resolved` maps; a WI absent from
 * `wiOutputCatalogs` (because it was incomplete when resolveAllCatalogs ran)
 * surfaces as `outputFiles: null`. WIs that never have a STAC input (e.g.
 * query-cmr step 1) always report `inputFiles: null`.
 *
 * @param wi - the work item to serialize
 * @param resolved - the catalog hrefs map + per-WI output catalog list
 * @returns the work item shaped for the steps response
 */
function buildWorkItem(
  wi: WorkItem,
  resolved: ResolvedCatalogs,
): StepWorkItem {
  const { catalogHrefs, wiOutputCatalogs } = resolved;
  const outputCatalogs = wiOutputCatalogs.get(wi.id);
  const outputFiles = outputCatalogs === undefined
    ? null
    : outputCatalogs.flatMap((url) => catalogHrefs.get(url) ?? []);
  return {
    id: wi.id,
    status: wi.status,
    retryCount: wi.retryCount,
    inputFiles: wi.stacCatalogLocation
      ? (catalogHrefs.get(wi.stacCatalogLocation) ?? null)
      : null,
    outputFiles,
  };
}

/**
 * For the work items belonging to a query-cmr step, fetch each stored CMR
 * query (one per scrollID) from S3 and return them inlined. Failures are
 * silent: if a SearchParams object is missing, that call is omitted.
 *
 * @param workItems - the query-cmr work items whose stored queries to fetch
 * @returns the resolved CMR queries, one entry per work item with a readable
 *   SearchParams object
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
 * Build the full step list. The workItems passed in are already
 * the filtered, paginated set; this function groups them under their parent
 * step. Steps whose stepIndex was filtered out by ?step= are omitted.
 *
 * @param workflowSteps - all workflow steps for the job
 * @param workItems - the filtered, paginated page of work items to group
 * @param resolved - resolved-catalog data from resolveAllCatalogs
 * @param q - the parsed steps query, used to honor the ?step= filter
 * @returns the steps with their work items and any CMR call details
 */
async function buildSteps(
  workflowSteps: WorkflowStep[],
  workItems: WorkItem[],
  resolved: ResolvedCatalogs,
  q: StepsQuery,
): Promise<JobStep[]> {

  // group the workitems by their stepindex (one for each service in the chain)
  const byStepIndex = new Map<number, WorkItem[]>();
   for (const wi of workItems) {
    const arr = byStepIndex.get(wi.workflowStepIndex) ?? [];
    arr.push(wi);
    byStepIndex.set(wi.workflowStepIndex, arr);
  }

  const result: JobStep[] = [];
  const filtering = q.status !== undefined || q.workItem !== undefined;
  for (const step of workflowSteps) {
    if (q.step !== undefined && step.stepIndex !== q.step) continue;
    const stepWorkItems = byStepIndex.get(step.stepIndex) ?? [];
    // Don't show steps with no workitems
    if (filtering && stepWorkItems.length === 0) continue;

    const jobStep: JobStep = {
      serviceID: sanitizeImage(step.serviceID),
      stepIndex: step.stepIndex,
      workItemCount: step.workItemCount,
      workItems: stepWorkItems.map((wi) => buildWorkItem(wi, resolved)),
    };

    const cmrWorkItems = stepWorkItems.filter((wi) => wi.scrollID);
    if (cmrWorkItems.length > 0) {
      jobStep.cmr = {
        endpoint: env.cmrEndpoint,
        calls: await buildCmrCalls(cmrWorkItems),
      };
    }

    result.push(jobStep);
  }

  return result;
}

/**
 * Express.js handler for GET /jobs/:jobID/steps. Returns a JSON document
 * describing the job, its workflow steps, and the inputs/outputs
 *
 * @param req - The request sent by the client
 * @param res - The response to send to the client
 * @param next - The next function in the call chain
 * @returns Resolves when the request is complete
 */
export async function getJobSteps(
  req: HarmonyRequest, res: Response, next: NextFunction,
): Promise<void> {
  const { jobID } = req.params;
  try {
    const q = parseQuery(req.query as Record<string, unknown>);

    const isAdmin = await isAdminUser(req);
    const job = await getJobIfAllowed(jobID, req.user, isAdmin, req.accessToken, true);

    const steps = await getWorkflowStepsByJobId(db, jobID);

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

    const frontendRoot = getRequestRoot(req);
    const resolvedCatalogs = await resolveAllCatalogs(workItems, frontendRoot);
    const jobSteps = await buildSteps(steps, workItems, resolvedCatalogs, q);

    const firstOperationStep = steps.find((s) => s.stepIndex === 1) ?? steps[0];
    const operation = firstOperationStep
      ? pickPublicOperationFields(firstOperationStep.operation)
      : null;

    const requestTruncated = !!job.request && job.request.length === TEXT_LIMIT;
    const responseBody = {
      jobID: job.jobID,
      status: job.status,
      progress: job.progress,
      message: job.message,
      username: job.username,
      numInputGranules: job.numInputGranules,
      request: {
        url: job.request,
        method: 'GET',
        // body: tbd,
        truncated: requestTruncated,
      },
      operation,
      steps: jobSteps,
      pagination: {
        currentPage: pagination.currentPage,
        perPage: pagination.perPage,
        total: pagination.total,
        lastPage: pagination.lastPage,
      },
    };

    res.json(responseBody);
  } catch (e) {
    req.context.logger.error(e);
    next(e);
  }
}
