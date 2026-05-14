import { expect } from 'chai';
import { before, describe, it } from 'mocha';
import request, { Test } from 'supertest';

import { JobStatus } from '../../app/models/job';
import { WorkItemStatus } from '../../app/models/work-item-interface';
import { hookTransaction } from '../helpers/db';
import { hookRequest } from '../helpers/hooks';
import { buildJob } from '../helpers/jobs';
import hookServersStartStop from '../helpers/servers';
import { buildWorkItem } from '../helpers/work-items';
import { buildWorkflowStep, validOperation } from '../helpers/workflow-steps';

/**
 * Issue a request to the lineage endpoint. Mirrors the helpers/jobs.ts pattern
 * for jobStatus / adminJobStatus so it can be bound via hookRequest.
 */
function jobLineage(app, { jobID, query }: { jobID: string; query?: object }): Test {
  return request(app).get(`/jobs/${jobID}/lineage`).query(query || {});
}

const hookJobLineage = hookRequest.bind(this, jobLineage);

const ownerJob = buildJob({
  username: 'joe',
  status: JobStatus.FAILED,
  message: 'Service failed',
  request: 'https://harmony.example/foo?bar=baz',
});

describe('GET /jobs/:jobID/lineage', function () {
  hookServersStartStop({ USE_EDL_CLIENT_APP: true });
  hookTransaction();

  before(async function () {
    await ownerJob.save(this.trx);
    // Step 1: query-cmr with a single successful work item (scrollID indicates query-cmr)
    const step1 = buildWorkflowStep({
      jobID: ownerJob.jobID,
      stepIndex: 1,
      serviceID: 'harmonyservices/query-cmr:latest',
      workItemCount: 1,
      operation: validOperation,
    });
    await step1.save(this.trx);
    const wi1 = buildWorkItem({
      jobID: ownerJob.jobID,
      workflowStepIndex: 1,
      serviceID: 'harmonyservices/query-cmr:latest',
      status: WorkItemStatus.SUCCESSFUL,
      scrollID: 'fake-scroll-key',
    });
    await wi1.save(this.trx);

    // Step 2: subsetter with a failed work item that has an input catalog from step 1
    const step2 = buildWorkflowStep({
      jobID: ownerJob.jobID,
      stepIndex: 2,
      serviceID: 'nasa/harmony-opendap-subsetter:1.2.4',
      workItemCount: 1,
      operation: validOperation,
    });
    await step2.save(this.trx);
    const wi2 = buildWorkItem({
      jobID: ownerJob.jobID,
      workflowStepIndex: 2,
      serviceID: 'nasa/harmony-opendap-subsetter:1.2.4',
      status: WorkItemStatus.FAILED,
      stacCatalogLocation: `s3://artifacts/${ownerJob.jobID}/1/outputs/catalog.json`,
    });
    await wi2.save(this.trx);
    await this.trx.commit();
  });

  describe('For a user who is not logged in', function () {
    hookJobLineage({ jobID: ownerJob.jobID });
    it('redirects to Earthdata Login', function () {
      expect(this.res.statusCode).to.equal(303);
    });
  });

  describe('For a non-owner who is not admin', function () {
    hookJobLineage({ jobID: ownerJob.jobID, username: 'stranger' });
    it('denies access', function () {
      expect([403, 404]).to.include(this.res.statusCode);
    });
  });

  describe('For the owner requesting the default lineage', function () {
    hookJobLineage({ jobID: ownerJob.jobID, username: 'joe' });

    it('returns 200 with a lineage document for the job', function () {
      expect(this.res.statusCode).to.equal(200);
      const body = JSON.parse(this.res.text);
      expect(body.jobID).to.equal(ownerJob.jobID);
      expect(body.status).to.equal('failed');
      expect(body.username).to.equal('joe');
      expect(body.originalRequest.url).to.equal('https://harmony.example/foo?bar=baz');
      expect(body.originalRequest.body).to.be.null;
      expect(body.originalRequest.truncated).to.equal(false);
    });

    it('includes both workflow steps with serviceID, stepIndex, and flags', function () {
      const body = JSON.parse(this.res.text);
      expect(body.steps).to.have.lengthOf(2);
      expect(body.steps[0].stepIndex).to.equal(1);
      expect(body.steps[0].serviceID).to.equal('harmonyservices/query-cmr:latest');
      expect(body.steps[1].stepIndex).to.equal(2);
      expect(body.steps[1].serviceID).to.equal('nasa/harmony-opendap-subsetter:1.2.4');
      expect(body.steps[0]).to.include.keys('isBatched', 'hasAggregatedOutput', 'isComplete');
    });

    it('strips accessToken from every step.operation', function () {
      const body = JSON.parse(this.res.text);
      for (const step of body.steps) {
        expect(step.operation).to.be.an('object');
        expect(step.operation).to.not.have.property('accessToken');
      }
    });

    it('includes work items with deterministic output catalog and logs S3 paths', function () {
      const body = JSON.parse(this.res.text);
      const wi1 = body.steps[0].workItems[0];
      const wi2 = body.steps[1].workItems[0];
      expect(wi1.output.catalog).to.match(new RegExp(`^s3://.*/${ownerJob.jobID}/${wi1.id}/outputs/catalog\\.json$`));
      expect(wi1.logs).to.match(new RegExp(`^s3://.*/${ownerJob.jobID}/${wi1.id}/logs\\.json$`));
      expect(wi2.input.catalog).to.equal(`s3://artifacts/${ownerJob.jobID}/1/outputs/catalog.json`);
      expect(wi2.status).to.equal('failed');
    });

    it('attaches a cmr block (with endpoint) to the query-cmr step', function () {
      const body = JSON.parse(this.res.text);
      expect(body.steps[0].cmr).to.be.an('object');
      expect(body.steps[0].cmr.endpoint).to.be.a('string');
      // calls[] may be empty when the SearchParams S3 object is absent in tests
      expect(body.steps[0].cmr.calls).to.be.an('array');
    });

    it('does not attach a cmr block to non-query-cmr steps', function () {
      const body = JSON.parse(this.res.text);
      expect(body.steps[1]).to.not.have.property('cmr');
    });
  });

  describe('Filtering with ?step=', function () {
    hookJobLineage({ jobID: ownerJob.jobID, username: 'joe', query: { step: 2 } });
    it('returns only the requested step', function () {
      expect(this.res.statusCode).to.equal(200);
      const body = JSON.parse(this.res.text);
      expect(body.steps).to.have.lengthOf(1);
      expect(body.steps[0].stepIndex).to.equal(2);
    });
  });

  describe('Filtering with ?status=failed', function () {
    hookJobLineage({ jobID: ownerJob.jobID, username: 'joe', query: { status: 'failed' } });
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

  describe('Validation errors', function () {
    describe('?status=bogus', function () {
      hookJobLineage({ jobID: ownerJob.jobID, username: 'joe', query: { status: 'bogus' } });
      it('returns 400', function () {
        expect(this.res.statusCode).to.equal(400);
      });
    });

    describe('?expand=both with max smaller than the filtered set', function () {
      hookJobLineage({ jobID: ownerJob.jobID, username: 'joe', query: { expand: 'both', max: 1 } });
      it('returns 413', function () {
        expect(this.res.statusCode).to.equal(413);
      });
    });
  });
});
