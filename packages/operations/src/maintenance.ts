/**
 * Daily job queue housekeeping. Every listing gets its own named queue (`listing:<id>`), so
 * queues that no longer have jobs are deleted once a day, along with jobs Graphile retired
 * after a crash (see jobs.ts). Graphile Worker's cron runs it once per day across all workers.
 */
import { makeWorkerUtils } from 'graphile-worker';

import { createJobQueueLogger, JOB_QUEUE_SCHEMA } from '@listora/db';
import type { Logger } from '@listora/shared';

export const MAINTENANCE_TASK = 'job_queue_maintenance';

/** 04:17 UTC every day, a quiet hour for US sellers. */
export const MAINTENANCE_CRONTAB = `17 4 * * * ${MAINTENANCE_TASK}`;

export async function runJobQueueMaintenance(
  connectionString: string,
  logger: Logger,
): Promise<void> {
  const utils = await makeWorkerUtils({
    connectionString,
    schema: JOB_QUEUE_SCHEMA,
    logger: createJobQueueLogger(logger),
  });
  try {
    await utils.cleanup({ tasks: ['GC_JOB_QUEUES', 'DELETE_PERMAFAILED_JOBS'] });
  } finally {
    await utils.release();
  }
}
