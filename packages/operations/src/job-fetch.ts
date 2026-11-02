/**
 * The Postgres pool each Graphile Worker runner uses, with one change to Graphile Worker's job
 * fetch: it checks a job's named queue only for a job of the fetching runner's own tasks.
 *
 * Graphile Worker (0.18) fetches with `... where is_available and run_at <= now() and task_id =
 * any($2) and (job_queue_id is null or job_queue_id in (select id from job_queues where
 * is_available for update skip locked)) ...`. Postgres orders those conditions by cost, and for
 * a runner with many tasks (the worker's other-jobs runner has about 30) or a generic plan of
 * the prepared fetch, it checks the queue before the task: for any due job in a named queue,
 * even another runner's, the subquery locks every free queue for the moment of the fetch. The
 * worker's two runners fetch at the same moments (each new-job notice reaches both; their polls
 * started together), so the operations runner's fetch skipped every listing queue, found
 * nothing, and left a new operation queued until a later poll: 5 s, often 15 s or more
 * (docs/features/performance.md). Postgres keeps the order of the terms inside one condition,
 * so asking for the task again inside the queue term means the subquery runs, and locks, only
 * when this runner could run the job.
 *
 * Remove this when Graphile Worker's fetch checks the task before the queue itself. A fetch
 * whose text no longer has the queue term fails loudly instead of running unchanged.
 */
import pg from 'pg';

import type { Logger } from '@listora/shared';

/** Marks Graphile Worker's job fetch: its one query that filters jobs by the runner's tasks. */
const FETCH_MARKER = 'and task_id = any($2::int[])';
/** The queue term of the fetch: no queue, or a free one locked by this fetch. */
const QUEUE_TERM = '\n      or\n      jobs.job_queue_id in (\n';
/** The same term, reached only for a job of this runner's tasks (`and` binds before `or`). */
const OWN_TASK_QUEUE_TERM =
  '\n      or\n      jobs.task_id = any($2::int[]) and jobs.job_queue_id in (\n';

/** Graphile Worker's job fetch with its queue term limited to the runner's tasks. */
export function ownTaskJobFetch(text: string): string {
  if (!text.includes(FETCH_MARKER)) return text;
  if (!text.includes(QUEUE_TERM)) {
    throw new Error(
      "Graphile Worker's job fetch changed: review packages/operations/src/job-fetch.ts",
    );
  }
  return text.replace(QUEUE_TERM, OWN_TASK_QUEUE_TERM);
}

type Query = (...args: unknown[]) => unknown;

/**
 * A pool for one Graphile Worker runner whose clients send the job fetch with
 * `ownTaskJobFetch`. A fetch it cannot change goes to `fatal` too: Graphile Worker would only
 * log the failed fetch and try again on each poll, running nothing. Graphile Worker installs no
 * error handlers on a pool it is given, so this logs pool and client errors itself; a lost
 * connection is replaced on the next query.
 */
export function createJobQueuePool(
  connectionString: string,
  logger: Logger,
  fatal: (error: Error) => void,
): pg.Pool {
  // Graphile Worker's own pool size (its `maxPoolSize` default).
  const pool = new pg.Pool({ connectionString, max: 10 });
  pool.on('error', (error) => {
    logger.error({ err: error }, 'job queue connection failed while idle');
  });
  pool.on('connect', (client) => {
    client.on('error', (error) => {
      logger.error({ err: error }, 'job queue connection failed');
    });
    const query = client.query.bind(client) as Query;
    const rewrite = (text: string): string => {
      try {
        return ownTaskJobFetch(text);
      } catch (error) {
        fatal(error as Error);
        throw error;
      }
    };
    // Every other query (and pg's own query objects) passes through as it was given.
    const fetchingOwnTasks: Query = (config, ...rest) => {
      if (typeof config === 'string') return query(rewrite(config), ...rest);
      if (!isQueryConfig(config)) return query(config, ...rest);
      const text = rewrite(config.text);
      return query(text === config.text ? config : { ...config, text }, ...rest);
    };
    client.query = fetchingOwnTasks as typeof client.query;
  });
  return pool;
}

function isQueryConfig(value: unknown): value is { text: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { text?: unknown }).text === 'string'
  );
}
