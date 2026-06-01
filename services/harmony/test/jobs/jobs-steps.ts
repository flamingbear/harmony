import { expect } from 'chai';
import { before, describe, it } from 'mocha';
import request, { Test } from 'supertest';

import { JobStatus } from '../../app/models/job';
import { getStacLocation, WorkItemStatus } from '../../app/models/work-item-interface';
import { serializedFields as workflowStepDbFields } from '../../app/models/workflow-steps';
import { objectStoreForProtocol } from '../../app/util/object-store';
import { auth } from '../helpers/auth';
import { hookTransaction } from '../helpers/db';
import { hookRequest } from '../helpers/hooks';
import { adminUsername, buildJob } from '../helpers/jobs';
import hookServersStartStop from '../helpers/servers';
import { buildWorkItem } from '../helpers/work-items';
import { buildWorkflowStep, validOperation } from '../helpers/workflow-steps';

/**
 * Issue a request to the steps endpoint. Mirrors the helpers/jobs.ts pattern
 * for jobStatus / adminJobStatus so it can be bound via hookRequest.
 */
function jobSteps(app, { jobID, query }: { jobID: string; query?: object }): Test {
  return request(app).get(`/jobs/${jobID}/steps`).query(query || {});
}

/**
 * Issue a request to the admin steps endpoint.
 */
function adminJobSteps(app, { jobID, query }: { jobID: string; query?: object }): Test {
  return request(app).get(`/admin/jobs/${jobID}/steps`).query(query || {});
}

const hookJobSteps = hookRequest.bind(this, jobSteps);
const hookAdminJobSteps = hookRequest.bind(this, adminJobSteps);

let wi2Id: number;

const joeJob = buildJob({
  username: 'joe',
  status: JobStatus.FAILED,
  message: 'Service failed',
  service_name: 'harmony-best-service',
  request: 'https://harmony.example/foo?bar=baz',
});

const runningJob = buildJob({
  username: 'joe',
  status: JobStatus.RUNNING,
  request: 'https://harmony.example/running',
});

// Job exercising the batch-catalogs truncation path: a successful query-cmr WI
// whose batch-catalogs.json lists more catalog files than MAX_BATCH_CATALOGS.
const truncatedJob = buildJob({
  username: 'joe',
  status: JobStatus.SUCCESSFUL,
  service_name: 'harmony-best-service',
  request: 'https://harmony.example/truncated',
});

// Job written to a user-supplied destinationUrl bucket: its output catalog's
// data asset is an s3:// href that createPublicPermalink can't sign (not under
// /public/).
const destBucketJob = buildJob({
  username: 'joe',
  status: JobStatus.SUCCESSFUL,
  service_name: 'harmony-best-service',
  request: 'https://harmony.example/dest',
  destination_url: 's3://user-bucket/out',
});

describe('GET /jobs/:jobID/steps', function () {
  hookServersStartStop({ USE_EDL_CLIENT_APP: true });
  hookTransaction();

  before(async function () {
    await joeJob.save(this.trx);
    // Step 1: query-cmr with a single successful work item
    const step1 = buildWorkflowStep({
      jobID: joeJob.jobID,
      stepIndex: 1,
      serviceID: '123456789012.dkr.ecr.us-west-2.amazonaws.com/harmonyservices/query-cmr:latest',
      workItemCount: 1,
      operation: validOperation,
    });
    await step1.save(this.trx);
    const wi1 = buildWorkItem({
      jobID: joeJob.jobID,
      workflowStepIndex: 1,
      serviceID: 'harmonyservices/query-cmr:latest',
      status: WorkItemStatus.SUCCESSFUL,
      scrollID: 'fake-scroll-key',
    });
    await wi1.save(this.trx);

    // Step 2: subsetter with a failed work item that has an input catalog from step 1
    const step2 = buildWorkflowStep({
      jobID: joeJob.jobID,
      stepIndex: 2,
      serviceID: 'nasa/harmony-opendap-subsetter:1.2.4',
      workItemCount: 1,
      operation: validOperation,
    });
    await step2.save(this.trx);
    const wi2 = buildWorkItem({
      jobID: joeJob.jobID,
      workflowStepIndex: 2,
      serviceID: 'nasa/harmony-opendap-subsetter:1.2.4',
      status: WorkItemStatus.FAILED,
      stacCatalogLocation: `s3://artifacts/${joeJob.jobID}/1/outputs/catalog.json`,
    });
    await wi2.save(this.trx);
    wi2Id = wi2.id;

    // A second job that's still running, with a single READY work item — used
    // to verify that incomplete WIs surface as files: null and that no S3
    // resolution is attempted on them.
    await runningJob.save(this.trx);
    const runningStep = buildWorkflowStep({
      jobID: runningJob.jobID,
      stepIndex: 1,
      serviceID: 'harmonyservices/query-cmr:latest',
      workItemCount: 1,
      operation: validOperation,
    });
    await runningStep.save(this.trx);
    const runningWi = buildWorkItem({
      jobID: runningJob.jobID,
      workflowStepIndex: 1,
      serviceID: 'harmonyservices/query-cmr:latest',
      status: WorkItemStatus.READY,
    });
    await runningWi.save(this.trx);

    // A third job whose query-cmr WI has 105 catalog files listed in
    // batch-catalogs.json — 5 over MAX_BATCH_CATALOGS (100). (The catalog
    // files themselves are not staged.)
    await truncatedJob.save(this.trx);
    const truncatedStep = buildWorkflowStep({
      jobID: truncatedJob.jobID,
      stepIndex: 1,
      serviceID: 'harmonyservices/query-cmr:latest',
      workItemCount: 1,
      operation: validOperation,
    });
    await truncatedStep.save(this.trx);
    const truncatedWi = buildWorkItem({
      jobID: truncatedJob.jobID,
      workflowStepIndex: 1,
      serviceID: 'harmonyservices/query-cmr:latest',
      status: WorkItemStatus.SUCCESSFUL,
      scrollID: 'fake-scroll-key',
    });
    await truncatedWi.save(this.trx);
    const overCapCatalogList = Array.from({ length: 105 }, (_, i) => `catalog${i}.json`);
    const batchUrl = getStacLocation(
      { id: truncatedWi.id, jobID: truncatedJob.jobID },
      'batch-catalogs.json',
    );
    await objectStoreForProtocol('s3').upload(
      JSON.stringify(overCapCatalogList), batchUrl, null, 'application/json',
    );

    // A job with a destinationUrl with a data asset is an s3:// href in
    // the user's destination bucket
    await destBucketJob.save(this.trx);
    const destStep = buildWorkflowStep({
      jobID: destBucketJob.jobID,
      stepIndex: 1,
      serviceID: 'nasa/harmony-opendap-subsetter:1.2.4',
      workItemCount: 1,
      operation: validOperation,
    });
    await destStep.save(this.trx);
    const destWi = buildWorkItem({
      jobID: destBucketJob.jobID,
      workflowStepIndex: 1,
      serviceID: 'nasa/harmony-opendap-subsetter:1.2.4',
      status: WorkItemStatus.SUCCESSFUL,
    });
    await destWi.save(this.trx);
    const s3 = objectStoreForProtocol('s3');
    const stacLoc = (f: string): string =>
      getStacLocation({ id: destWi.id, jobID: destBucketJob.jobID }, f);
    await s3.upload(JSON.stringify({
      stac_version: '1.0.0', id: 'cat', description: 'c',
      links: [{ rel: 'item', href: './item0.json' }],
    }), stacLoc('catalog.json'), null, 'application/json');
    await s3.upload(JSON.stringify({
      stac_version: '1.0.0', id: 'item0', type: 'Feature',
      geometry: null, properties: {}, links: [],
      assets: { data: { href: 's3://user-bucket/out/granule.nc4', roles: ['data'] } },
    }), stacLoc('item0.json'), null, 'application/json');

    await this.trx.commit();
  });

  describe('For a user who is not logged in', function () {
    hookJobSteps({ jobID: joeJob.jobID });
    it('redirects to Earthdata Login', function () {
      expect(this.res.statusCode).to.equal(303);
    });
  });

  describe('For a non-owner who is not admin', function () {
    hookJobSteps({ jobID: joeJob.jobID, username: 'stranger' });
    it('denies access', function () {
      expect(this.res.statusCode).to.equal(403);
    });
  });

  describe('For the owner requesting the default steps response', function () {
    hookJobSteps({ jobID: joeJob.jobID, username: 'joe' });

    it('returns 200 with a steps document for the job', function () {
      expect(this.res.statusCode).to.equal(200);
      const body = JSON.parse(this.res.text);
      expect(body.jobID).to.equal(joeJob.jobID);
      expect(body.status).to.equal('failed');
      expect(body.username).to.equal('joe');
      expect(body.serviceName).to.equal('harmony-best-service');
      expect(body.request).to.equal('https://harmony.example/foo?bar=baz');
    });

    it('includes both workflow steps with expected keys', function () {
      const body = JSON.parse(this.res.text);
      expect(body.steps).to.have.lengthOf(2);
      expect(body.steps[0].stepIndex).to.equal(1);
      expect(body.steps[0].serviceID).to.equal('harmonyservices/query-cmr:latest');
      expect(body.steps[0].workItemCount).to.equal(1);
      expect(body.steps[1].stepIndex).to.equal(2);
      expect(body.steps[1].serviceID).to.equal('nasa/harmony-opendap-subsetter:1.2.4');
      expect(body.steps[1].workItemCount).to.equal(1);
      expect(body.steps[1].workItems).to.have.length(1);
    });

    it('exposes correct step-level state on the response', function () {
      const expectedKeys = ['serviceID', 'stepIndex', 'workItemCount', 'workItems'];
      const unexposedKeys = workflowStepDbFields.filter((f)=> !expectedKeys.includes(f))
      const body = JSON.parse(this.res.text);
      for (const step of body.steps) {
        expect(step).to.not.have.any.keys(...unexposedKeys)
        expect(step).to.have.keys(expectedKeys)
      }
    });

    it('exposes inputFiles / outputFiles fields', function () {
      const body = JSON.parse(this.res.text);
      const wi1 = body.steps[0].workItems[0];
      const wi2 = body.steps[1].workItems[0];
      expect(wi1).to.have.property('inputFiles');
      expect(wi1).to.have.property('outputFiles');
      expect(wi1['inputFiles']).to.be.null;
      expect(wi1['outputFiles']).to.be.an('array');
      expect(wi2).to.have.property('inputFiles');
      expect(wi2['inputFiles']).to.be.an('array');
      expect(wi2).to.have.property('outputFiles');
    });

  });

  describe('Filtering with ?step=', function () {
    hookJobSteps({ jobID: joeJob.jobID, username: 'joe', query: { step: 2 } });
    it('returns only the requested step', function () {
      expect(this.res.statusCode).to.equal(200);
      const body = JSON.parse(this.res.text);
      expect(body.steps).to.have.lengthOf(1);
      expect(body.steps[0].stepIndex).to.equal(2);
    });
  });

  describe('Filtering with ?status=failed', function () {
    hookJobSteps({ jobID: joeJob.jobID, username: 'joe', query: { status: 'failed' } });
    it('keeps only work items in that status', function () {
      expect(this.res.statusCode).to.equal(200);
      const body = JSON.parse(this.res.text);
      for (const step of body.steps) {
        for (const wi of step.workItems) {
          expect(wi.status).to.equal('failed');
        }
      }
      const stepsWithItems = body.steps.filter((s) => s.workItems.length > 0);
      expect(stepsWithItems).to.have.lengthOf(1);
      expect(stepsWithItems[0].stepIndex).to.equal(2);
    });
  });

  describe('Pagination with ?perPage=1', function () {
    hookJobSteps({ jobID: joeJob.jobID, username: 'joe', query: { perPage: 1 } });
    it('returns one work item with pagination metadata indicating more pages', function () {
      expect(this.res.statusCode).to.equal(200);
      const body = JSON.parse(this.res.text);
      expect(body.pagination.perPage).to.equal(1);
      expect(body.pagination.total).to.equal(2);
      expect(body.pagination.lastPage).to.equal(2);
      const totalReturnedWIs = body.steps.reduce((acc, s) => acc + s.workItems.length, 0);
      expect(totalReturnedWIs).to.equal(1);
    });
  });

  describe('For a job whose work item is still incomplete', function () {
    hookJobSteps({ jobID: runningJob.jobID, username: 'joe' });
    it('leaves outputFiles as null and does not attempt resolution', function () {
      expect(this.res.statusCode).to.equal(200);
      const body = JSON.parse(this.res.text);
      const wi = body.steps[0].workItems[0];
      expect(wi.status).to.equal('ready');
      expect(wi.outputFiles).to.equal(null);
      expect(wi.inputFiles).to.equal(null);
    });
  });

  describe('For an admin user fetching another user\'s job via /admin/jobs/:jobID/steps', function () {
    hookAdminJobSteps({ jobID: joeJob.jobID, username: adminUsername });
    it('returns 200 with the job\'s steps', function () {
      expect(this.res.statusCode).to.equal(200);
      const body = JSON.parse(this.res.text);
      expect(body.jobID).to.equal(joeJob.jobID);
      expect(body.steps).to.have.lengthOf(2);
    });
  });

  describe('For a jobID that does not exist', function () {
    hookJobSteps({
      jobID: '00000000-0000-4000-8000-000000000000',
      username: 'joe',
    });
    it('returns 404', function () {
      expect(this.res.statusCode).to.equal(404);
    });
  });

  describe('Filtering with ?step= for an unknown step index', function () {
    hookJobSteps({ jobID: joeJob.jobID, username: 'joe', query: { step: 99 } });
    it('returns 200 with an empty steps array', function () {
      expect(this.res.statusCode).to.equal(200);
      const body = JSON.parse(this.res.text);
      expect(body.steps).to.deep.equal([]);
    });
  });

  describe('Filtering with ?workItem=<id>', function () {
    // Custom before because hookJobSteps captures `query` at describe-load
    // time, but wi2Id is only set by the outer `before` (after save).
    before(async function () {
      this.res = await jobSteps(
        this.frontend,
        { jobID: joeJob.jobID, query: { workItem: wi2Id } },
      ).use(auth({ username: 'joe' }));
    });
    after(function () { delete this.res; });

    it('returns only the requested work item, in its parent step', function () {
      expect(this.res.statusCode).to.equal(200);
      const body = JSON.parse(this.res.text);
      // The workItem filter + drop-empty-when-filtering means only step 2
      // surfaces, with exactly the targeted work item.
      expect(body.steps).to.have.lengthOf(1);
      expect(body.steps[0].stepIndex).to.equal(2);
      expect(body.steps[0].workItems).to.have.lengthOf(1);
      expect(body.steps[0].workItems[0].id).to.equal(wi2Id);
    });
  });

  describe('Pagination — page 2 with ?perPage=1', function () {
    hookJobSteps({ jobID: joeJob.jobID, username: 'joe', query: { perPage: 1, page: 2 } });
    it('returns the second page of work items with currentPage=2', function () {
      expect(this.res.statusCode).to.equal(200);
      const body = JSON.parse(this.res.text);
      expect(body.pagination.currentPage).to.equal(2);
      expect(body.pagination.perPage).to.equal(1);
      expect(body.pagination.total).to.equal(2);
      expect(body.pagination.lastPage).to.equal(2);
      const totalReturnedWIs = body.steps.reduce((acc, s) => acc + s.workItems.length, 0);
      expect(totalReturnedWIs).to.equal(1);
    });
  });

  describe('When batch-catalogs.json exceeds MAX_BATCH_CATALOGS', function () {
    hookJobSteps({ jobID: truncatedJob.jobID, username: 'joe' });

    it('appends a truncation sentinel to outputFiles naming the omitted count', function () {
      expect(this.res.statusCode).to.equal(200);
      const body = JSON.parse(this.res.text);
      const outputFiles = body.steps[0].workItems[0].outputFiles;
      expect(outputFiles).to.be.an('array');
      // Last element [also the only element] is the sentinel; 105 staged - 100 cap = 5 omitted.
      expect(outputFiles[outputFiles.length - 1]).to.equal(
        'Not all files resolved, there are 5 more files not shown (HARMONY-2352)',
      );
    });
  });

  describe('For a job written to a user destinationUrl bucket', function () {
    hookJobSteps({ jobID: destBucketJob.jobID, username: 'joe' });

    it('passes an unsignable s3 href through because it is in the destination bucket', function () {
      expect(this.res.statusCode).to.equal(200);
      const body = JSON.parse(this.res.text);
      const outputFiles = body.steps[0].workItems[0].outputFiles;
      expect(outputFiles).to.deep.equal(['s3://user-bucket/out/granule.nc4']);
    });
  });

  describe('Validation errors', function () {
    describe('?status=bogus', function () {
      hookJobSteps({ jobID: joeJob.jobID, username: 'joe', query: { status: 'bogus' } });
      it('returns 400', function () {
        expect(this.res.statusCode).to.equal(400);
      });
    });

  });
});
