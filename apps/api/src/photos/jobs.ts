import type { PhotoJobQueue } from '@listora/photos';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Stands in for the Graphile Worker queue until the operation engine (plan task T-06) brings
 * it: photos are attached and stay `processing`, and nothing claims they were processed. With
 * the queue, `enqueue` adds a `PHOTO_PROCESSING_TASK` job (job key `photoJobKey`) on the
 * caller's transaction, and the worker registers `processPhoto` for that task.
 */
export function unscheduledPhotoJobs(logger: FastifyBaseLogger): PhotoJobQueue {
  return {
    enqueue: (_executor, job) => {
      logger.warn(
        { photoId: job.photoId },
        'photo processing is not scheduled: the job queue arrives with plan task T-06',
      );
      return Promise.resolve();
    },
  };
}
