import type { AnalysisJobQueue } from '@listora/analysis';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Stands in for the Graphile Worker queue, which so far runs only operation jobs (plan task
 * T-06), as `unscheduledPhotoJobs` does for photos: analyses are created and stay `queued`, and
 * nothing claims they ran. With the queue, `enqueue` adds an `ITEM_ANALYSIS_TASK` job (job key
 * `analysisJobKey`) on the caller's transaction, and the worker registers `runItemAnalysis`.
 */
export function unscheduledAnalysisJobs(logger: FastifyBaseLogger): AnalysisJobQueue {
  return {
    enqueue: (_executor, job) => {
      logger.warn(
        { analysisId: job.analysisId },
        'item analysis is not scheduled: the worker does not run these jobs yet',
      );
      return Promise.resolve();
    },
  };
}
