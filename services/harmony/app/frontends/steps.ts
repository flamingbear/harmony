import { NextFunction, Response } from 'express';
import { ILengthAwarePagination } from 'knex-paginate';

import { sanitizeImage } from '@harmony/util/string';

import { createPublicPermalink } from './service-results';
import HarmonyRequest from '../models/harmony-request';
import WorkItem, {
  queryAll as queryWorkItems, workItemStatusCountsForJob,
} from '../models/work-item';
import {
  COMPLETED_WORK_ITEM_STATUSES, getStacLocation, WorkItemQuery, WorkItemStatus,
} from '../models/work-item-interface';
import WorkflowStep, { getWorkflowStepsByJobId } from '../models/workflow-steps';
import db from '../util/db';
import { isAdminUser } from '../util/edl-api';
import { RequestValidationError } from '../util/errors';
import { getJobIfAllowed } from '../util/job';
import { Link } from '../util/links';
import { keysToLowerCase } from '../util/object';
import { defaultObjectStore } from '../util/object-store';
import { getPagingLinks, parseIntegerParam } from '../util/pagination';
import { parseMultiValueParameter } from '../util/parameter-parsing-helpers';
import { getCatalogItemUrls, readCatalogItems, readItemsAtUrls, StacItem } from '../util/stac';
import { getRequestRoot } from '../util/url';

const DEFAULT_WORKITEMS_PER_PAGE = 50;
const MAX_WORKITEMS_PER_PAGE = 1000;

// Default number of a work item's input items / output catalogs resolved per page,
// navigated with the per-work-item `workItem<id>InputPage` / `workItem<id>OutputPage`
// parameters and overridable via the `wiLimit` query parameter. Bounds the S3 reads
// each resolved page costs.
const CATALOG_PAGE_SIZE = 50;
// Upper bound on `wiLimit`: the largest page of input items / output catalogs that
// may be resolved in a single request. A work item's input catalog can list a huge
// number of items (e.g. an aggregating service), so this caps the per-page read cost.
const MAX_WI_PAGE_SIZE = 100;
const VALID_STATUSES = Object.values(WorkItemStatus);

// Which side of a single work item's files a resolve request is asking for.
type ResolveKind = 'input' | 'output';
const VALID_RESOLVE_KINDS: ResolveKind[] = ['input', 'output'];


interface StepsQueryParams {
  steps?: number[];
  statuses?: WorkItemStatus[];
  workItems?: number[];
  // When set, the request resolves a single work item's input or output files
  // inline (rather than returning the link-only overview).
  resolveFiles?: ResolveKind;
}

interface StepWorkItem {
  id: number;
  status: WorkItemStatus;
  retryCount: number;
  // Overview mode: links back to the steps endpoint that resolve this work item's
  // input / output files (null when the work item has no input / no outputs yet).
  inputFilesUrl?: string | null;
  outputFilesUrl?: string | null;
  // Resolve mode: the requested page of files for the requested kind, plus paging
  // when there is more than one page. Only the requested kind is populated.
  inputFiles?: string[] | null;
  inputFilesPaging?: StepPaging;
  outputFiles?: string[] | null;
  outputFilesPaging?: StepPaging;
}

interface JobStep {
  serviceID: string;
  stepIndex: number;
  workItemCount: number;
  statuses: Partial<Record<WorkItemStatus, number>>;
  workItems: StepWorkItem[];
  paging?: StepPaging;
}

interface StepPaging {
  currentPage: number;
  lastPage: number;
  total: number;
  links: Link[];
}

/**
 * Parse the query parameters used to filter and shape the steps response.
 *
 * @param query - the raw request query string parameters
 * @returns the validated and normalized steps query
 * @throws RequestValidationError - if any parameter is not a valid value
 */
function parseQuery(query: Record<string, unknown>): StepsQueryParams {
  const out: StepsQueryParams = {};

  if (query.step !== undefined) {
    const queryStepsArray = parseMultiValueParameter(query.step as string | string[]);
    out.steps = queryStepsArray.map((v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) {
        throw new RequestValidationError('step must be a positive integer');
      }
      return n;
    });
  }

  if (query.status !== undefined) {
    const queryStatusArray = parseMultiValueParameter(query.status as string | string[]);
    out.statuses = queryStatusArray.map((v) => {
      const s = v as WorkItemStatus;
      if (!VALID_STATUSES.includes(s)) {
        throw new RequestValidationError(`status must be one of: ${VALID_STATUSES.join(', ')}`);
      }
      return s;
    });
  }

  if (query.workitem !== undefined) {
    const queryWorkItemArray = parseMultiValueParameter(query.workitem as string | string[]);
    out.workItems = queryWorkItemArray.map((v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) {
        throw new RequestValidationError('workItem must be a positive integer');
      }
      return n;
    });
  }

  if (query.resolvefiles !== undefined) {
    const kind = query.resolvefiles as ResolveKind;
    if (!VALID_RESOLVE_KINDS.includes(kind)) {
      throw new RequestValidationError(`resolveFiles must be one of: ${VALID_RESOLVE_KINDS.join(', ')}`);
    }
    out.resolveFiles = kind;
  }

  return out;
}

/**
 * Collect every asset href from a list of STAC items.
 *
 * @param items - the STAC items whose asset hrefs should be collected
 * @returns every asset href found across the items
 */
function getAllAssetHrefs(items: StacItem[]): string[] {
  const hrefs: string[] = [];
  for (const item of items) {
    for (const name in item.assets ?? {}) {
      const { href } = item.assets[name];
      if (href) hrefs.push(href);
    }
  }
  return hrefs;
}

/**
 * Read a single STAC output catalog in full (all of its items) and return every
 * asset href it references. A work item's outputs are a list of such catalogs;
 * `resolveOutputFiles` calls this once per catalog on the requested page. Input
 * catalogs, which can list a huge number of items, are instead read a page of
 * items at a time via `resolveInputFiles`.
 *
 * @param catalogUrl - the location of the STAC catalog to read
 * @returns the asset hrefs from the catalog, or an empty array if the catalog
 *   cannot be read (e.g. the service failed before producing it, or the
 *   catalog has no assets)
 */
async function resolveDataHrefs(catalogUrl: string): Promise<string[]> {
  try {
    const items = await readCatalogItems(catalogUrl);
    return getAllAssetHrefs(items);
  } catch {
    return [];
  }
}

// Placeholder used in inputFiles / outputFiles when a STAC asset href cannot
// be turned into a public/valid link.
const PRIVATE_FILE_PLACEHOLDER = '<private file location>';

/**
 * Convert a raw STAC asset href into the public-facing form.
 * S3 URLs under `.../public/` become `<frontendRoot>/service-results/...`
 * HTTPS URLs pass through.
 * User provided S3:// urls are returned for allowed locations.
 *
 * @param href - the raw STAC asset href to convert
 * @param frontendRoot - The root URL to use when producing Harmony permalinks
 * @param destinationBucket - the job's destinationUrl bucket name, or undefined
 *     if the job has no destinationUrl
 * @returns the Harmony permalink result for a signable href; the raw href if it is in
 *   the job's destination bucket; otherwise the PRIVATE_FILE_PLACEHOLDER sentinel
 */
export function safePublicLink(href: string, frontendRoot: string, destinationBucket: string | undefined): string {
  try {
    return createPublicPermalink(href, frontendRoot);
  } catch {
    if (destinationBucket && href.startsWith(`s3://${destinationBucket}/`)) {
      return href;
    }
    return PRIVATE_FILE_PLACEHOLDER;
  }
}

// A single work item's resolved page of files plus its paging (paging is omitted
// when there is only one page).
interface WiResolvedFiles {
  files: string[];
  paging?: StepPaging;
}

// Map of work item id -> its resolved page of files (only populated in resolve mode).
type ResolvedFiles = Map<number, WiResolvedFiles>;

/**
 * Build the link, back to this same steps endpoint, that resolves a single work
 * item's input or output files inline.
 *
 * @param req - the Express request, used for the host and current path
 * @param wiId - the work item id to scope the link to
 * @param kind - whether the link resolves input or output files
 * @returns the absolute URL that resolves that work item's files
 */
function workItemFilesUrl(req: HarmonyRequest, wiId: number, kind: ResolveKind): string {
  const path = req.originalUrl.split('?')[0];
  return `${getRequestRoot(req)}${path}?workitem=${wiId}&resolvefiles=${kind}`;
}

/**
 * Build the paging block for a resolved page of a work item's files, or undefined
 * when the files fit on a single page.
 *
 * @param req - the Express request, used to build the paging links
 * @param pagination - the catalog-level pagination for the work item's files
 * @param pageParamName - the per-work-item page query parameter the links should set
 * @returns the paging block, or undefined when there is only one page
 */
function buildFilesPaging(
  req: HarmonyRequest, pagination: ILengthAwarePagination, pageParamName: string,
): StepPaging | undefined {
  const { currentPage, lastPage, total } = pagination;
  if (lastPage <= 1) return undefined;
  return {
    currentPage, lastPage, total,
    links: getPagingLinks(req, pagination, true, pageParamName, 'wilimit'),
  };
}

/**
 * Sorting function to return the catalogs in the order they are presumed to be
 * generated.
 *
 * @param filename - a `catalog.json` / `catalogN.json` basename
 * @returns the numeric index, or -1 if the filename has none
 */
function catalogIndex(filename: string): number {
  const m = filename.match(/catalog(\d+)\.json$/);
  return m ? Number(m[1]) : -1;
}

/**
 * Determine a completed work item's output catalog file URLs, mirroring
 * service-runner's `_getStacCatalogs` discovery so that every catalog a service
 * writes is found:
 *   - if the work item wrote a `batch-catalogs.json` (query-cmr, and aggregating
 *     services such as batchee/stitchee), use the catalogN.json files it lists;
 *   - otherwise list the `catalog*.json` files in the outputs directory, which
 *     covers both the common single `catalog.json` and services that might write
 *     several `catalogN.json` files without an index.
 * The full ordered list is returned; the caller paginates it (its length is the
 * work item's output catalog total).
 *
 * @param outputDir - the WI's outputs directory URL
 * @returns the ordered output catalog URLs
 */
async function getAllOutputCatalogFilenames(outputDir: string): Promise<string[]> {
  const store = defaultObjectStore();
  const batchCatalogsUrl = `${outputDir}batch-catalogs.json`;

  let filenames: string[];
  if (await store.objectExists(batchCatalogsUrl)) {
    try {
      filenames = await store.getObjectJson(batchCatalogsUrl) as string[];
    } catch {
      return [];
    }
  } else {
    const keys = await store.listObjectKeys(outputDir);
    filenames = keys
      .map((k) => k.split('/').pop())
      .filter((f) => /^catalog\d*\.json$/.test(f))
      .sort((a, b) => catalogIndex(a) - catalogIndex(b));
  }

  return filenames.map((f) => `${outputDir}${f}`);
}

/**
 * Build a catalog-level pagination object for a work item's output catalogs,
 * mirroring the shape knex-paginate produces so getPagingLinks can consume it.
 * The requested page is clamped to the last page when it is beyond the end,
 * matching the per-step paging behavior.
 *
 * @param total - the work item's total number of output catalogs
 * @param requestedPage - the page requested via the work item's page parameter
 * @returns the pagination describing the (clamped) current page
 */
function catalogPagination(total: number, requestedPage: number, perPage: number = CATALOG_PAGE_SIZE): ILengthAwarePagination {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const currentPage = Math.min(requestedPage, lastPage);
  const from = total === 0 ? 0 : (currentPage - 1) * perPage + 1;
  const to = Math.min(currentPage * perPage, total);
  return {
    total, lastPage, perPage, currentPage, from, to,
    prevPage: currentPage > 1 ? currentPage - 1 : null,
    nextPage: currentPage < lastPage ? currentPage + 1 : null,
  };
}

/**
 * Resolve one page of a work item's input files. The work item's single input
 * catalog can reference a huge number of items (e.g. an aggregating service), so
 * the catalog is enumerated once and only the requested page of items is read,
 * keeping the S3 reads bounded by `wiLimit`.
 *
 * @param req - the Express request, used to read the input page / wiLimit params
 * @param wi - the work item whose input catalog should be resolved
 * @param frontendRoot - the root URL to use when producing Harmony permalinks
 * @param destinationBucket - the job's destinationUrl bucket name, or undefined
 * @returns the page of public file links plus paging (paging omitted for one page)
 */
async function resolveInputFiles(
  req: HarmonyRequest, wi: WorkItem, frontendRoot: string, destinationBucket: string | undefined,
): Promise<WiResolvedFiles> {
  if (!wi.stacCatalogLocation) return { files: [] };
  const perPage = parseIntegerParam(req, 'wilimit', CATALOG_PAGE_SIZE, 1, MAX_WI_PAGE_SIZE, true, true);
  const requestedPage = parseIntegerParam(req, `workitem${wi.id}inputpage`, 1, 1);
  try {
    // Enumerate the catalog's item URLs once (one S3 read), then read only the
    // requested page's slice of items.
    const itemUrls = await getCatalogItemUrls(wi.stacCatalogLocation);
    const pagination = catalogPagination(itemUrls.length, requestedPage, perPage);
    const start = (pagination.currentPage - 1) * perPage;
    const pageUrls = itemUrls.slice(start, start + perPage);
    const items = await readItemsAtUrls(wi.stacCatalogLocation, pageUrls);
    const files = getAllAssetHrefs(items).map((h) => safePublicLink(h, frontendRoot, destinationBucket));
    return { files, paging: buildFilesPaging(req, pagination, `workitem${wi.id}inputpage`) };
  } catch {
    return { files: [] };
  }
}

/**
 * Resolve one page of a work item's output files. A work item's outputs are a list
 * of catalog files; only the requested page of those catalogs is read (each fully)
 * so the S3 reads stay bounded by `wiLimit`.
 *
 * @param req - the Express request, used to read the output page / wiLimit params
 * @param wi - the work item whose output catalogs should be resolved
 * @param frontendRoot - the root URL to use when producing Harmony permalinks
 * @param destinationBucket - the job's destinationUrl bucket name, or undefined
 * @returns the page of public file links plus paging (paging omitted for one page)
 */
async function resolveOutputFiles(
  req: HarmonyRequest, wi: WorkItem, frontendRoot: string, destinationBucket: string | undefined,
): Promise<WiResolvedFiles> {
  if (!COMPLETED_WORK_ITEM_STATUSES.includes(wi.status)) return { files: [] };
  const perPage = parseIntegerParam(req, 'wilimit', CATALOG_PAGE_SIZE, 1, MAX_WI_PAGE_SIZE, true, true);
  const outputDir = getStacLocation({ id: wi.id, jobID: wi.jobID });
  const allCatalogUrls = await getAllOutputCatalogFilenames(outputDir);
  const requestedPage = parseIntegerParam(req, `workitem${wi.id}outputpage`, 1, 1);
  const pagination = catalogPagination(allCatalogUrls.length, requestedPage, perPage);
  const start = (pagination.currentPage - 1) * perPage;
  const pageUrls = allCatalogUrls.slice(start, start + perPage);
  const hrefArrays = await Promise.all(pageUrls.map((url) => resolveDataHrefs(url)));
  const files = hrefArrays.flat().map((h) => safePublicLink(h, frontendRoot, destinationBucket));
  return { files, paging: buildFilesPaging(req, pagination, `workitem${wi.id}outputpage`) };
}

/**
 * Resolve the requested kind (input or output) of files for the given work items
 * inline. Only invoked in resolve mode, which is scoped to a single work item, so
 * the S3 reads are bounded to that one work item's requested page.
 *
 * @param req - the Express request
 * @param workItems - the work items to resolve (a single item in resolve mode)
 * @param kind - whether to resolve input or output files
 * @param frontendRoot - the root URL to use when producing Harmony permalinks
 * @param destinationBucket - the job's destinationUrl bucket name, or undefined
 * @returns map of work item id to its resolved page of files
 */
async function resolveSelectedWorkItemFiles(
  req: HarmonyRequest,
  workItems: WorkItem[],
  kind: ResolveKind,
  frontendRoot: string,
  destinationBucket: string | undefined,
): Promise<ResolvedFiles> {
  const startTime = new Date().getTime();
  const resolved: ResolvedFiles = new Map();
  await Promise.all(workItems.map(async (wi) => {
    const result = kind === 'input'
      ? await resolveInputFiles(req, wi, frontendRoot, destinationBucket)
      : await resolveOutputFiles(req, wi, frontendRoot, destinationBucket);
    resolved.set(wi.id, result);
  }));
  const durationMs = new Date().getTime() - startTime;
  req.context.logger.info('Finished steps:resolveSelectedWorkItemFiles', { durationMs });
  return resolved;
}

/**
 * Build the work item portion of the response.
 *
 * In overview mode (no `resolveFiles`) the work item carries `inputFilesUrl` /
 * `outputFilesUrl` links back to this endpoint that resolve its files on demand,
 * doing no S3 reads here: `inputFilesUrl` is null when the work item has no STAC
 * input (e.g. query-cmr step 1) and `outputFilesUrl` is null until the work item
 * completes.
 *
 * In resolve mode the requested kind's files are populated inline from the
 * precomputed `resolved` map, with an `inputFilesPaging` / `outputFilesPaging`
 * block (navigated via the `workItem<id>InputPage` / `workItem<id>OutputPage`
 * parameter) when there is more than one page.
 *
 * @param req - the Express request, used to build links
 * @param wi - the work item to serialize
 * @param q - the parsed steps query (determines overview vs resolve mode)
 * @param resolved - the per-WI resolved files map (resolve mode only)
 * @returns the work item shaped for the steps response
 */
function buildWorkItem(
  req: HarmonyRequest,
  wi: WorkItem,
  q: StepsQueryParams,
  resolved?: ResolvedFiles,
): StepWorkItem {
  const base = { id: wi.id, status: wi.status, retryCount: wi.retryCount };

  if (q.resolveFiles === undefined) {
    return {
      ...base,
      inputFilesUrl: wi.stacCatalogLocation ? workItemFilesUrl(req, wi.id, 'input') : null,
      outputFilesUrl: COMPLETED_WORK_ITEM_STATUSES.includes(wi.status)
        ? workItemFilesUrl(req, wi.id, 'output') : null,
    };
  }

  const { files, paging } = resolved?.get(wi.id) ?? { files: [] };
  if (q.resolveFiles === 'input') {
    return { ...base, inputFiles: files, ...(paging !== undefined && { inputFilesPaging: paging }) };
  }
  return { ...base, outputFiles: files, ...(paging !== undefined && { outputFilesPaging: paging }) };
}


// A workflow step, its page of work items and the pagination info.
interface StepWorkItems {
  step: WorkflowStep;
  workItems: WorkItem[];
  pagination: ILengthAwarePagination;
}

/**
 * Build the full step list from each step's requested page of work items.
 * A step with more than one page of matching work items gets a `paging` block
 * whose links page that step via its own `step<stepIndex>Page` query parameter.
 * When a status/workItem filter is active, steps with no matching work items are
 * omitted.
 *
 * @param req - the Express request, used to build per-step paging links
 * @param stepResults - each workflow step with its page of work items and pagination
 * @param statusCounts - per-step, per-status work item counts for the whole job
 * @param q - the parsed steps query, used to honor the status/workItem filters
 * @param resolved - per-WI resolved files map (resolve mode only)
 * @returns the steps with their work items, status summary, and any paging links
 */
function buildSteps(
  req: HarmonyRequest,
  stepResults: StepWorkItems[],
  statusCounts: Map<number, Partial<Record<WorkItemStatus, number>>>,
  q: StepsQueryParams,
  resolved?: ResolvedFiles,
): JobStep[] {
  const result: JobStep[] = [];
  const filtering = q.statuses !== undefined || q.workItems !== undefined;
  for (const { step, workItems, pagination } of stepResults) {
    // Don't show steps having no matching work items.
    if (filtering && pagination.total === 0) continue;

    const jobStep: JobStep = {
      serviceID: sanitizeImage(step.serviceID),
      stepIndex: step.stepIndex,
      workItemCount: step.workItemCount,
      statuses: statusCounts.get(step.stepIndex) ?? {},
      workItems: workItems.map((wi) => buildWorkItem(req, wi, q, resolved)),
    };
    const { currentPage, lastPage, total } = pagination;
    if (lastPage > 1) {
      jobStep.paging = {
        currentPage,
        lastPage,
        total,
        links: getPagingLinks(req, pagination, true, `step${step.stepIndex}page`),
      };
    }

    result.push(jobStep);
  }

  return result;
}

/**
 * Express.js handler for GET /jobs/:jobID/steps. Returns a JSON document
 * describing the job, its workflow steps, and the inputs/outputs of those
 * steps.
 *
 * @param req - The request sent by the client
 * @param res - The response to send to the client
 * @param next - The next function in the call chain
 * @returns Resolves when the request is complete
 */
export async function getJobSteps(
  req: HarmonyRequest, res: Response, next: NextFunction,
): Promise<void> {
  const startTime = new Date().getTime();
  const { jobID } = req.params;
  try {
    req.query = keysToLowerCase(req.query);
    const q = parseQuery(req.query as Record<string, unknown>);

    const isAdmin = await isAdminUser(req);
    const job = await getJobIfAllowed(jobID, req.user, isAdmin, req.accessToken, true);
    const destinationBucket = job.destination_url?.substring(5).split('/')[0];

    const steps = await getWorkflowStepsByJobId(db, jobID);
    const statusCounts = await workItemStatusCountsForJob(db, jobID);

    const selectedSteps = q.steps !== undefined
      ? steps.filter((s) => q.steps.includes(s.stepIndex))
      : steps;

    // Bound workItems by 'limit' and page each step independently via step<stepIndex>Page parameter.
    const limit = parseIntegerParam(req, 'limit', DEFAULT_WORKITEMS_PER_PAGE, 1, MAX_WORKITEMS_PER_PAGE, true, true);
    const stepResults: StepWorkItems[] = await Promise.all(selectedSteps.map(async (step) => {
      const where: WorkItemQuery['where'] = { jobID, workflowStepIndex: step.stepIndex };
      const whereIn: WorkItemQuery['whereIn'] = {};
      if (q.statuses !== undefined) whereIn.status = { in: true, values: q.statuses };
      if (q.workItems !== undefined) whereIn.id = { in: true, values: q.workItems };
      const page = parseIntegerParam(req, `step${step.stepIndex}page`, 1, 1);
      const query: WorkItemQuery = {
        where, whereIn, orderBy: { field: 'id', value: 'asc' },
      };
      let { workItems, pagination } = await queryWorkItems(db, query, page, limit);
      // reload last page for this step if we're off the end.
      if (pagination.lastPage >= 1 && page > pagination.lastPage) {
        ({ workItems, pagination } = await queryWorkItems(db, query, pagination.lastPage, limit));
      }
      return { step, workItems, pagination };
    }));

    const frontendRoot = getRequestRoot(req);
    const allWorkItems = stepResults.flatMap((r) => r.workItems);

    let resolved: ResolvedFiles | undefined;
    if (q.resolveFiles !== undefined) {
      if (q.workItems === undefined || q.workItems.length !== 1) {
        throw new RequestValidationError('resolveFiles requires exactly one workItem');
      }
      resolved = await resolveSelectedWorkItemFiles(req, allWorkItems, q.resolveFiles, frontendRoot, destinationBucket);
    }

    const jobSteps = buildSteps(req, stepResults, statusCounts, q, resolved);

    const responseBody = {
      jobID: job.jobID,
      serviceName: job.service_name,
      status: job.status,
      progress: job.progress,
      message: job.message,
      username: job.username,
      numInputGranules: job.numInputGranules,
      request: job.request,
      steps: jobSteps,
    };
    const durationMs = new Date().getTime() - startTime;
    req.context.logger.info(`Finished /steps for ${jobID}`, { durationMs });
    res.json(responseBody);
  } catch (e) {
    req.context.logger.error(e);
    next(e);
  }
}
