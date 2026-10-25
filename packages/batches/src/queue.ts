import { addJob, type DbExecutor } from '@listora/db';

/** The job queue task name the worker registers `startBatchItemAnalysis` under. */
export const BATCH_ITEM_ANALYSIS_TASK = 'batch_item_analysis';

export interface BatchJobPayload {
  accountId: string;
  batchId: string;
  itemId: string;
}

export function isBatchJobPayload(value: unknown): value is BatchJobPayload {
  if (typeof value !== 'object' || value === null) return false;
  const { accountId, batchId, itemId } = value as Record<string, unknown>;
  return typeof accountId === 'string' && typeof batchId === 'string' && typeof itemId === 'string';
}

/** One pending job per item, so submitting an item twice never starts two jobs for it. */
export function batchJobKey(itemId: string): string {
  return `batch-item-analysis:${itemId}`;
}

/**
 * Adds a batch item's job on the caller's connection, so it commits or rolls back with the
 * submit that needs it; `runAt` delays it (the job checks again while photos process).
 * `graphileBatchJobs` is the production one; tests record jobs instead.
 */
export interface BatchJobQueue {
  enqueue(executor: DbExecutor, job: BatchJobPayload, runAt?: Date): Promise<void>;
}

/** The Graphile Worker queue: the worker runs each job with `startBatchItemAnalysis`. */
export const graphileBatchJobs: BatchJobQueue = {
  enqueue: (executor, job, runAt) =>
    addJob(executor, {
      task: BATCH_ITEM_ANALYSIS_TASK,
      payload: { accountId: job.accountId, batchId: job.batchId, itemId: job.itemId },
      jobKey: batchJobKey(job.itemId),
      ...(runAt === undefined ? {} : { runAt }),
    }),
};
