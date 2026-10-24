import { addJob, type DbExecutor } from '@listora/db';

/** The job queue task name the worker registers `runItemAnalysis` under. */
export const ITEM_ANALYSIS_TASK = 'item_analysis';

export interface AnalysisJobPayload {
  accountId: string;
  analysisId: string;
}

export function isAnalysisJobPayload(value: unknown): value is AnalysisJobPayload {
  if (typeof value !== 'object' || value === null) return false;
  const { accountId, analysisId } = value as Record<string, unknown>;
  return typeof accountId === 'string' && typeof analysisId === 'string';
}

/** One job per analysis, so adding the job twice never runs (and pays for) it twice at once. */
export function analysisJobKey(analysisId: string): string {
  return `analysis:${analysisId}`;
}

/**
 * Adds an analysis job on the caller's connection, so the job commits or rolls back with the
 * analysis row. `graphileAnalysisJobs` is the production one; tests record jobs instead.
 */
export interface AnalysisJobQueue {
  enqueue(executor: DbExecutor, job: AnalysisJobPayload): Promise<void>;
}

/** The Graphile Worker queue: the worker runs each job with `runItemAnalysis`. */
export const graphileAnalysisJobs: AnalysisJobQueue = {
  enqueue: (executor, job) =>
    addJob(executor, {
      task: ITEM_ANALYSIS_TASK,
      payload: { accountId: job.accountId, analysisId: job.analysisId },
      jobKey: analysisJobKey(job.analysisId),
    }),
};
