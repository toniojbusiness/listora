/**
 * Runs the operation engine on Graphile Worker: the job runner, the liveness session, and the
 * periodic recovery of stopped workers' jobs (recovery.ts). The same runner takes the other
 * background jobs the worker is given (`tasks`), with the same liveness and recovery.
 * `apps/worker` starts it; tests start it in process with a short retry schedule.
 */
import { EventEmitter } from 'node:events';

import { run, type Runner, type TaskList, type WorkerEvents } from 'graphile-worker';

import { createJobQueueLogger, JOB_QUEUE_SCHEMA, type Db } from '@listora/db';
import type { AdapterLookup } from '@listora/marketplaces';
import type { Logger } from '@listora/shared';

import { runOperationStep, type StepDependencies } from './executor.ts';
import { isOperationJobPayload, OPERATION_TASK } from './jobs.ts';
import { MAINTENANCE_CRONTAB, MAINTENANCE_TASK, runJobQueueMaintenance } from './maintenance.ts';
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from './policy.ts';
import { reapStoppedWorkers, WorkerLiveness } from './recovery.ts';

/**
 * A background job other than an operation step, given its payload as added. It throws only
 * when the job should run again later (an outage); outcomes the user sees go on its own row.
 */
export type WorkerTask = (payload: unknown, signal: AbortSignal) => Promise<void>;

export interface OperationWorkerOptions {
  /** The database for the job queue's own connections and the liveness session. */
  connectionString: string;
  /** The engine's database handle (operations, listings, history). */
  db: Db;
  adapters: AdapterLookup;
  logger: Logger;
  /** Other jobs this worker runs (photo processing, item analysis), by task name. */
  tasks?: Readonly<Record<string, WorkerTask>>;
  /** Jobs run at the same time, operation steps and `tasks` together (default 5). */
  concurrency?: number;
  policy?: RetryPolicy;
  /** Deadline for one marketplace call (default 60 s). */
  callTimeoutMs?: number;
  /** How often the queue looks for scheduled jobs that became due (default 2 s). */
  pollIntervalMs?: number;
  /** How often to release stopped workers' jobs (default 5 s). */
  recoveryIntervalMs?: number;
  /** A lock younger than this is never released (default 5 s). */
  recoveryGraceMs?: number;
  /** Recheck interval for an operation waiting behind an older one (default 5 min). */
  blockedRecheckMs?: number;
  /**
   * The worker can no longer run safely (its liveness session or the job runner failed). The
   * process must exit at once; other workers then recover its jobs.
   */
  onFatalError: (error: Error) => void;
}

export interface OperationWorker {
  /** The Graphile Worker pool id that this worker's job locks carry. */
  readonly poolId: string;
  /** Stops taking jobs, lets running steps finish (or aborts them), and closes the session. */
  stop(): Promise<void>;
}

export async function startOperationWorker(
  options: OperationWorkerOptions,
): Promise<OperationWorker> {
  const { logger } = options;
  const tasks = options.tasks ?? {};
  for (const name of [OPERATION_TASK, MAINTENANCE_TASK]) {
    if (Object.hasOwn(tasks, name)) throw new Error(`task ${name} is the worker's own`);
  }
  const deps: StepDependencies = {
    db: options.db,
    adapters: options.adapters,
    logger,
    policy: options.policy ?? DEFAULT_RETRY_POLICY,
    callTimeoutMs: options.callTimeoutMs ?? 60_000,
    blockedRecheckMs: options.blockedRecheckMs ?? 5 * 60_000,
  };
  let stopping = false;
  const fatal = (error: Error): void => {
    if (!stopping) options.onFatalError(error);
  };

  const liveness = await WorkerLiveness.open(options.connectionString, fatal);
  let markRegistered: (poolId: string) => void = () => undefined;
  let failRegistration: (error: Error) => void = () => undefined;
  const registered = new Promise<string>((resolve, reject) => {
    markRegistered = resolve;
    failRegistration = reject;
  });
  // Awaited below and by every job; this only keeps an early failure from going unhandled.
  registered.catch(() => undefined);
  const events = new EventEmitter() as WorkerEvents;
  events.on('pool:create', ({ workerPool }) => {
    liveness.register(workerPool.id).then(
      () => {
        markRegistered(workerPool.id);
      },
      (error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        failRegistration(failure);
        fatal(failure);
      },
    );
  });

  const taskList: TaskList = {
    ...Object.fromEntries(
      Object.entries(tasks).map(([name, task]): [string, TaskList[string]] => [
        name,
        async (payload, helpers) => {
          // Like operation steps: no job runs before other workers can see this one is alive.
          await registered;
          await task(payload, helpers.abortSignal);
        },
      ]),
    ),
    [OPERATION_TASK]: async (payload, helpers) => {
      if (!isOperationJobPayload(payload)) {
        helpers.logger.error('operation job with an invalid payload; dropping it');
        return;
      }
      // No step runs before other workers can see that this worker is alive.
      await registered;
      await runOperationStep(deps, payload, helpers.abortSignal);
    },
    [MAINTENANCE_TASK]: async () => {
      await runJobQueueMaintenance(options.connectionString, logger);
    },
  };

  let runner: Runner;
  try {
    runner = await run({
      connectionString: options.connectionString,
      schema: JOB_QUEUE_SCHEMA,
      concurrency: options.concurrency ?? 5,
      pollInterval: options.pollIntervalMs ?? 2_000,
      noHandleSignals: true,
      logger: createJobQueueLogger(logger),
      events,
      taskList,
      crontab: MAINTENANCE_CRONTAB,
    });
  } catch (error) {
    await liveness.close();
    throw error;
  }
  runner.promise.then(
    () => {
      if (!stopping) fatal(new Error('the job runner stopped unexpectedly'));
    },
    (error: unknown) => {
      fatal(error instanceof Error ? error : new Error(String(error)));
    },
  );

  let poolId: string;
  try {
    poolId = await registered;
  } catch (error) {
    stopping = true;
    await runner.stop();
    await liveness.close();
    throw error;
  }

  const graceMs = options.recoveryGraceMs ?? 5_000;
  let recovering: Promise<void> = Promise.resolve();
  const recover = async (): Promise<void> => {
    try {
      const released = await reapStoppedWorkers(options.db, graceMs);
      if (released.length > 0) {
        logger.warn({ poolIds: released }, 'released jobs of stopped workers');
      }
    } catch (error) {
      logger.error({ err: error }, 'releasing jobs of stopped workers failed');
    }
  };
  await recover();
  const recovery = setInterval(() => {
    recovering = recover();
  }, options.recoveryIntervalMs ?? 5_000);

  return {
    poolId,
    async stop() {
      stopping = true;
      clearInterval(recovery);
      try {
        await recovering;
        await runner.stop();
      } finally {
        await liveness.close();
      }
    },
  };
}
