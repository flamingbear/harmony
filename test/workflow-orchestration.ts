import { expect } from 'chai';
import { getWorkItemsByJobId, WorkItemStatus } from '../app/models/work-item';
import { getWorkflowStepsByJobId } from '../app/models/workflow-steps';
import db from '../app/util/db';
import { Job, JobStatus } from '../app/models/job';
import { hookRedirect } from './helpers/hooks';
import { hookRangesetRequest } from './helpers/ogc-api-coverages';
import hookServersStartStop from './helpers/servers';
import { getWorkForService, hookGetWorkForService, updateWorkItem } from './helpers/work-items';

describe('Workflow chaining for a collection configured for swot reprojection and netcdf-to-zarr', function () {
  const collection = 'C1233800302-EEDTEST';
  hookServersStartStop();

  describe('when requesting to both reproject and reformat for two granules', function () {
    const reprojectAndZarrQuery = {
      maxResults: 2,
      outputCrs: 'EPSG:4326',
      interpolation: 'near',
      scaleExtent: '0,2500000.3,1500000,3300000',
      scaleSize: '1.1,2',
      format: 'application/x-zarr',
      turbo: true,
    };

    hookRangesetRequest('1.0.0', collection, 'all', { query: reprojectAndZarrQuery });
    hookRedirect('joe');

    it('generates a workflow with 3 steps', async function () {
      const job = JSON.parse(this.res.text);
      const workflowSteps = await getWorkflowStepsByJobId(db, job.jobID);

      expect(workflowSteps.length).to.equal(3);
    });

    it('starts with the query-cmr task', async function () {
      const job = JSON.parse(this.res.text);
      const workflowSteps = await getWorkflowStepsByJobId(db, job.jobID);

      expect(workflowSteps[0].serviceID).to.equal('harmonyservices/query-cmr:latest');
    });

    it('then requests reprojection using swot reprojection', async function () {
      const job = JSON.parse(this.res.text);
      const workflowSteps = await getWorkflowStepsByJobId(db, job.jobID);

      expect(workflowSteps[1].serviceID).to.equal('sds/swot-reproject:latest');
    });

    it('then requests reformatting using netcdf-to-zarr', async function () {
      const job = JSON.parse(this.res.text);
      const workflowSteps = await getWorkflowStepsByJobId(db, job.jobID);

      expect(workflowSteps[2].serviceID).to.equal('harmonyservices/netcdf-to-zarr:latest');
    });

    // Verify it only queues a work item for the query-cmr task
    describe('when checking for a swot reproject work item', function () {
      hookGetWorkForService('sds/swot-reproject:latest');

      it('does not find a work item', async function () {
        expect(this.res.status).to.equal(404);
      });
    });

    describe('when checking for a netcdf-to-zarr work item', function () {
      hookGetWorkForService('harmonyservices/netcdf-to-zarr:latest');

      it('does not find a work item', async function () {
        expect(this.res.status).to.equal(404);
      });
    });

    describe('when checking for a query-cmr work item', function () {
      it('finds the item and can complete it', async function () {
        const res = await getWorkForService(this.backend, 'harmonyservices/query-cmr:latest');
        expect(res.status).to.equal(200);
        const workItem = JSON.parse(res.text);
        expect(workItem.serviceID).to.equal('harmonyservices/query-cmr:latest');
        workItem.status = WorkItemStatus.SUCCESSFUL;
        workItem.results = ['test/resources/worker-response-sample/catalog0.json'];
        await updateWorkItem(this.backend, workItem);
      });

      describe('when checking to see if swot-reprojection work is queued', function () {
        it('finds a swot-reprojection service work item and can complete it', async function () {
          const res = await getWorkForService(this.backend, 'sds/swot-reproject:latest');
          expect(res.status).to.equal(200);
          const workItem = JSON.parse(res.text);
          workItem.status = WorkItemStatus.SUCCESSFUL;
          workItem.results = ['test/resources/worker-response-sample/catalog0.json'];
          await updateWorkItem(this.backend, workItem);
          expect(workItem.serviceID).to.equal('sds/swot-reproject:latest');
        });

        describe('when checking to see if netcdf-to-zarr work is queued', function () {
          it('finds a net-cdf-to-zarr service work item and can complete it', async function () {
            const res = await getWorkForService(this.backend, 'harmonyservices/netcdf-to-zarr:latest');
            expect(res.status).to.equal(200);
            const workItem = JSON.parse(res.text);
            workItem.status = WorkItemStatus.SUCCESSFUL;
            workItem.results = ['test/resources/worker-response-sample/catalog0.json'];
            await updateWorkItem(this.backend, workItem);
            expect(workItem.serviceID).to.equal('harmonyservices/netcdf-to-zarr:latest');
          });

          describe('when checking the jobs listing', function () {
            it('marks the job as in progress and 50 percent complete because 1 of 2 granules is complete', async function () {
              const jobs = await Job.forUser(db, 'anonymous');
              const job = jobs.data[0];
              expect(job.status).to.equal('running');
              expect(job.progress).to.equal(50);
            });
          });

          describe('when completing all three steps for the second granule', function () {
            it('wish I could do this in the describe', async function () {
              for await (const service of ['harmonyservices/query-cmr:latest', 'sds/swot-reproject:latest', 'harmonyservices/netcdf-to-zarr:latest']) {
                const res = await getWorkForService(this.backend, service);
                const workItem = JSON.parse(res.text);
                workItem.status = WorkItemStatus.SUCCESSFUL;
                workItem.results = ['test/resources/worker-response-sample/catalog0.json'];
                await updateWorkItem(this.backend, workItem);
              }
            });

            describe('when checking the jobs listing', function () {
              it('marks the job as successful and progress of 100', async function () {
                const jobs = await Job.forUser(db, 'anonymous');
                const job = jobs.data[0];
                expect(job.status).to.equal('successful');
                expect(job.progress).to.equal(100);
              });
            });
          });
        });
      });
    });
  });

  describe('when making a request and the job fails while in progress', function () {
    const reprojectAndZarrQuery = {
      maxResults: 3,
      outputCrs: 'EPSG:4326',
      interpolation: 'near',
      scaleExtent: '0,2500000.3,1500000,3300000',
      scaleSize: '1.1,2',
      format: 'application/x-zarr',
      turbo: true,
    };

    hookRangesetRequest('1.0.0', collection, 'all', { query: reprojectAndZarrQuery });
    hookRedirect('joe');

    before(async function () {
      const res = await getWorkForService(this.backend, 'harmonyservices/query-cmr:latest');
      const workItem = JSON.parse(res.text);
      workItem.status = WorkItemStatus.SUCCESSFUL;
      workItem.results = [
        'test/resources/worker-response-sample/catalog0.json',
        'test/resources/worker-response-sample/catalog1.json',
        'test/resources/worker-response-sample/catalog2.json',
      ];
      await updateWorkItem(this.backend, workItem);
      // since there were multiple query cmr results,
      // multiple work items should be generated for the next step
      const currentWorkItems = (await getWorkItemsByJobId(db, workItem.jobID)).workItems;
      expect(currentWorkItems.length).to.equal(4);
      expect(currentWorkItems.filter((item) => item.status === WorkItemStatus.READY && item.serviceID === 'sds/swot-reproject:latest').length).to.equal(3);
    });

    describe('when the first swot-reprojection service work item fails', function () {
      let firstSwotItem;

      before(async function () {
        const res = await getWorkForService(this.backend, 'sds/swot-reproject:latest');
        firstSwotItem = JSON.parse(res.text);
        firstSwotItem.status = WorkItemStatus.FAILED;
        firstSwotItem.results = [];
        await updateWorkItem(this.backend, firstSwotItem);
      });

      it('fails the job, and all further work items are canceled', async function () {
        // work item failure should trigger job failure
        const job = await Job.byJobID(db, firstSwotItem.jobID);
        expect(job.status === JobStatus.FAILED);
        // job failure should trigger cancellation of any pending work items
        const currentWorkItems = (await getWorkItemsByJobId(db, job.jobID)).workItems;
        expect(currentWorkItems.length).to.equal(4);
        expect(currentWorkItems.filter((item) => item.status === WorkItemStatus.SUCCESSFUL && item.serviceID === 'harmonyservices/query-cmr:latest').length).to.equal(1);
        expect(currentWorkItems.filter((item) => item.status === WorkItemStatus.CANCELED && item.serviceID === 'sds/swot-reproject:latest').length).to.equal(2);
        expect(currentWorkItems.filter((item) => item.status === WorkItemStatus.FAILED && item.serviceID === 'sds/swot-reproject:latest').length).to.equal(1);
      });

      it('does not find any further swot-reproject work', async function () {
        const res = await getWorkForService(this.backend, 'sds/swot-reproject:latest');
        expect(res.status).to.equal(404);
      });

      it('does not allow any further work item updates', async function () {
        firstSwotItem.status = WorkItemStatus.SUCCESSFUL;
        const res = await await updateWorkItem(this.backend, firstSwotItem);
        expect(res.status).to.equal(409);

        const currentWorkItems = (await getWorkItemsByJobId(db, firstSwotItem.jobID)).workItems;
        expect(currentWorkItems.length).to.equal(4);
        expect(currentWorkItems.filter((item) => item.status === WorkItemStatus.SUCCESSFUL && item.serviceID === 'harmonyservices/query-cmr:latest').length).to.equal(1);
        expect(currentWorkItems.filter((item) => item.status === WorkItemStatus.CANCELED && item.serviceID === 'sds/swot-reproject:latest').length).to.equal(2);
        expect(currentWorkItems.filter((item) => item.status === WorkItemStatus.FAILED && item.serviceID === 'sds/swot-reproject:latest').length).to.equal(1);
      });
    });
  });

  describe('when requesting to reformat to zarr, no reprojection', function () {
    const zarrOnlyQuery = {
      maxResults: 2,
      format: 'application/x-zarr',
      turbo: true,
    };

    hookRangesetRequest('1.0.0', collection, 'all', { query: zarrOnlyQuery, username: 'joe' });
    hookRedirect('joe');

    it('generates a workflow with 2 steps', async function () {
      const job = JSON.parse(this.res.text);
      const workflowSteps = await getWorkflowStepsByJobId(db, job.jobID);

      expect(workflowSteps.length).to.equal(2);
    });

    it('starts with the query-cmr task', async function () {
      const job = JSON.parse(this.res.text);
      const workflowSteps = await getWorkflowStepsByJobId(db, job.jobID);

      expect(workflowSteps[0].serviceID).to.equal('harmonyservices/query-cmr:latest');
    });

    it('then requests reformatting using netcdf-to-zarr', async function () {
      const job = JSON.parse(this.res.text);
      const workflowSteps = await getWorkflowStepsByJobId(db, job.jobID);

      expect(workflowSteps[1].serviceID).to.equal('harmonyservices/netcdf-to-zarr:latest');
    });
  });

  describe('when requesting to reproject, but not reformat', function () {
    const reprojectOnlyQuery = {
      maxResults: 2,
      outputCrs: 'EPSG:4326',
      interpolation: 'near',
      scaleExtent: '0,2500000.3,1500000,3300000',
      scaleSize: '1.1,2',
      format: 'application/x-netcdf4',
      turbo: true,
    };

    hookRangesetRequest('1.0.0', collection, 'all', { query: reprojectOnlyQuery });
    hookRedirect('joe');

    it('generates a workflow with 2 steps', async function () {
      const job = JSON.parse(this.res.text);
      const workflowSteps = await getWorkflowStepsByJobId(db, job.jobID);

      expect(workflowSteps.length).to.equal(2);
    });

    it('starts with the query-cmr task', async function () {
      const job = JSON.parse(this.res.text);
      const workflowSteps = await getWorkflowStepsByJobId(db, job.jobID);

      expect(workflowSteps[0].serviceID).to.equal('harmonyservices/query-cmr:latest');
    });

    it('then requests reprojection using swot reprojection', async function () {
      const job = JSON.parse(this.res.text);
      const workflowSteps = await getWorkflowStepsByJobId(db, job.jobID);

      expect(workflowSteps[1].serviceID).to.equal('sds/swot-reproject:latest');
    });
  });
});
