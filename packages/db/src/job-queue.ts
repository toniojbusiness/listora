/**
 * The job queue's schema. Listora runs Graphile Worker on the same Postgres database, in its
 * own `graphile_worker` schema, so a job can be enqueued in the same transaction as the row it
 * works on (docs/architecture.md section 6). Graphile Worker owns and versions that schema;
 * `npm run db:migrate` installs or upgrades it after Listora's own migrations, before any
 * process enqueues a job.
 */
import { Logger as JobQueueLogger, runMigrations, type LogFunctionFactory } from 'graphile-worker';

import type { Logger } from '@listora/shared';

/** Postgres schema that holds the job queue's tables and functions. */
export const JOB_QUEUE_SCHEMA = 'graphile_worker';

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
