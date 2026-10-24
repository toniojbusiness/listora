/**
 * The job queue's schema. Listora runs Graphile Worker on the same Postgres database, in its
 * own `graphile_worker` schema, so a job can be enqueued in the same transaction as the row it
 * works on (docs/architecture.md section 6). Graphile Worker owns and versions that schema;
 * `npm run db:migrate` installs or upgrades it after Listora's own migrations, before any
 * process enqueues a job.
 */
import { Logger as JobQueueLogger, runMigrations, type LogFunctionFactory } from 'graphile-worker';
import { sql } from 'kysely';

import type { Logger } from '@listora/shared';

import type { DbExecutor } from './database.ts';

/** Postgres schema that holds the job queue's tables and functions. */
export const JOB_QUEUE_SCHEMA = 'graphile_worker';

/**
 * Graphile retries a job whose handler throws (a database or storage outage, a bug) with its
 * own backoff, capped near six hours. The maximum smallint means a job is never dropped while
 * the row it works on still waits for it.
 */
export const JOB_MAX_ATTEMPTS = 32_767;

export interface BackgroundJob {
  /** The task name the worker runs the job with. */
  readonly task: string;
  readonly payload: Readonly<Record<string, string>>;
  /** One pending job per key: adding the job again replaces the pending one. */
  readonly jobKey: string;
}

/**
 * Adds a job on the caller's connection, so it commits or rolls back together with the row
 * that needs it. The worker runs it as soon as it commits.
 */
export async function addJob(executor: DbExecutor, job: BackgroundJob): Promise<void> {
  await sql`
    select ${sql.id(JOB_QUEUE_SCHEMA)}.add_job(
      identifier => ${job.task},
      payload => ${JSON.stringify(job.payload)}::json,
      max_attempts => ${JOB_MAX_ATTEMPTS},
      job_key => ${job.jobKey}
    )
  `.execute(executor);
}

/**
 * Routes Graphile Worker's log messages into a Listora structured logger. Graphile logs every
 * completed job at info; the operation engine logs each step itself, so Graphile's info lines
 * are kept at debug, and its warnings and errors keep their level.
 */
export function createJobQueueLogger(logger: Logger): JobQueueLogger {
  const factory: LogFunctionFactory = (scope) => {
    const scoped = logger.child({ jobQueue: scope });
    return (level, message, meta) => {
      switch (level) {
        case 'error':
          scoped.error(meta, message);
          return;
        case 'warning':
          scoped.warn(meta, message);
          return;
        case 'info':
        case 'debug':
          scoped.debug(meta, message);
          return;
      }
    };
  };
  return new JobQueueLogger(factory);
}

export interface JobQueueMigrationOptions {
  connectionString: string;
  logger: Logger;
}

/** Installs or upgrades the job queue schema. Safe to run concurrently and repeatedly. */
export async function migrateJobQueue(options: JobQueueMigrationOptions): Promise<void> {
  await runMigrations({
    connectionString: options.connectionString,
    schema: JOB_QUEUE_SCHEMA,
    logger: createJobQueueLogger(options.logger),
  });
}
