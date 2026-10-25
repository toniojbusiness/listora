/**
 * Runs the operation engine on Graphile Worker: the job runner, the liveness session, and the
 * periodic recovery of stopped workers' jobs (recovery.ts). The other background jobs the
 * worker is given (`tasks`) and the host's scheduled tasks run on a second runner with its own,
 * smaller pool and its own liveness session, so slow AI calls and image work never hold the
 * slots an urgent delist needs. `apps/worker` starts it; tests start it in process with a short
 * retry schedule.
 *
 * The browser runner (`apps/runner`) starts it in the `automation` role: one runner that takes
 * only automated operation steps (`AUTOMATION_OPERATION_TASK`) and its own `tasks` (sale checks),
 * one job at a time, so a browser session never waits behind another while its deadline runs.
 * It runs no scheduled tasks and no queue maintenance; the always-on worker does those.
 */
import { EventEmitter } from 'node:events';

import { run, type JobHelpers, type TaskList, type WorkerEvents } from 'graphile-worker';

import { createJobQueueLogger, JOB_QUEUE_SCHEMA, type Db } from '@listora/db';
import type { AdapterLookup } from '@listora/marketplaces';
import type { Logger } from '@listora/shared';

import { runOperationStep, type StepDependencies } from './executor.ts';
import {
  AUTOMATION_OPERATION_TASK,
  isOperationJobPayload,
  OPERATION_TASK,
  type OperationTask,
} from './jobs.ts';
import { MAINTENANCE_CRONTAB, MAINTENANCE_TASK, runJobQueueMaintenance } from './maintenance.ts';
import { DEFAULT_RETRY_POLICY, queuePollIntervalMs, type RetryPolicy } from './policy.ts';
import { reapStoppedWorkers, WorkerLiveness } from './recovery.ts';

/**
 * A background job other than an operation step, given its payload as added. It throws only
 * when the job should run again later (an outage); outcomes the user sees go on its own row.
 */
export type WorkerTask = (payload: unknown, signal: AbortSignal) => Promise<void>;

/**
 * A recurring job on Graphile Worker's cron, which runs it once per due time across all
 * workers. The host process supplies these (`apps/worker` schedules the AI spend check).
 */
export interface ScheduledTask {
  /** The Graphile Worker task name (lowercase letters, digits, underscores). */
  readonly name: string;
  /** The five crontab time fields, in UTC, such as `7 * * * *` for minute 7 of every hour. */
  readonly schedule: string;
  /** Attempts per due time before Graphile gives up on it (default 1: the next run retries). */
  readonly maxAttempts?: number;
  readonly run: (signal: AbortSignal) => Promise<void>;
}

export interface OperationWorkerOptions {
  /**
   * `worker` (default): operation steps, with automated ones handed to the browser runner.
   * `automation`: the browser runner, which takes only automated steps and `tasks`, one at a time.
   */
  role?: 'worker' | 'automation';
  /** The database for the job queue's own connections and the liveness session. */
  connectionString: string;
  /** The engine's database handle (operations, listings, history). */
  db: Db;
  adapters: AdapterLookup;
  logger: Logger;
  /** Other jobs this worker runs (photo processing, item analysis), by task name. */
  tasks?: Readonly<Record<string, WorkerTask>>;
  /** Operation steps run at the same time (default 5). */
  concurrency?: number;
  /** `tasks` jobs run at the same time, apart from the operation steps (default 2). */
  taskConcurrency?: number;
  policy?: RetryPolicy;
  /** Deadline for one marketplace call (default 60 s). */
  callTimeoutMs?: number;
  /** How often the queue looks for scheduled jobs that became due (`queuePollIntervalMs`). */
  pollIntervalMs?: number;
  /** How often to release stopped workers' jobs (default 5 s). */
  recoveryIntervalMs?: number;
  /** A lock younger than this is never released (default 5 s). */
  recoveryGraceMs?: number;
  /** Recheck interval for an operation waiting behind an older one (default 5 min). */
  blockedRecheckMs?: number;
  /** Recurring jobs, run on the same runner as `tasks`. Not in the `automation` role. */
  scheduledTasks?: readonly ScheduledTask[];
  /**
   * Graphile crontab lines that schedule `tasks` (one job per tick across all workers). Not in
   * the `automation` role.
   */
  crontab?: readonly string[];
  /** A worker handed an automated step to the browser runner (see executor.ts). */
  onAutomationHandover?: () => void;
  /**
   * The worker can no longer run safely (its liveness session or the job runner failed). The
   * process must exit at once; other workers then recover its jobs.
   */
  onFatalError: (error: Error) => void;
}

export interface OperationWorker {
  /** The Graphile Worker pool id that this worker's operation job locks carry. */
  readonly poolId: string;
  /** The pool id of the runner that runs `tasks` and `scheduledTasks`, when there are any. */
  readonly taskPoolId: string | undefined;
  /** Stops taking jobs, lets running steps finish (or aborts them), and closes the session. */
  stop(): Promise<void>;
}

export async function startOperationWorker(
  options: OperationWorkerOptions,
): Promise<OperationWorker> {
  const { logger } = options;
  const role = options.role ?? 'worker';
  const tasks = options.tasks ?? {};
  for (const name of RESERVED_TASKS) {
    if (Object.hasOwn(tasks, name)) throw new Error(`task ${name} is the worker's own`);
  }
  const scheduledTasks = options.scheduledTasks ?? [];
  validScheduledTasks(scheduledTasks, tasks);
  const crontab = [
    ...scheduledTasks.map(
      (task) => `${task.schedule} ${task.name} ?max=${String(task.maxAttempts ?? 1)}`,
    ),
    ...(options.crontab ?? []),
  ];
  if (role === 'automation' && crontab.length > 0) {
    throw new Error('the browser runner runs no scheduled tasks; the worker schedules its work');
  }
  const deps: StepDependencies = {
    db: options.db,
    adapters: options.adapters,
    logger,
    policy: options.policy ?? DEFAULT_RETRY_POLICY,
    callTimeoutMs: options.callTimeoutMs ?? 60_000,
    blockedRecheckMs: options.blockedRecheckMs ?? 5 * 60_000,
    runsAutomation: role === 'automation',
    ...(options.onAutomationHandover === undefined
      ? {}
      : { onAutomationHandover: options.onAutomationHandover }),
  };
  let stopping = false;
  const fatal = (error: Error): void => {
    if (!stopping) options.onFatalError(error);
  };
  const runnerOptions = {
    connectionString: options.connectionString,
    logger,
    pollIntervalMs: options.pollIntervalMs ?? queuePollIntervalMs(deps.policy),
    fatal,
    isStopping: () => stopping,
  };

  const operationStep =
    (task: OperationTask): JobHandler =>
    async (payload, helpers) => {
      if (!isOperationJobPayload(payload)) {
        helpers.logger.error(`${task} job with an invalid payload; dropping it`);
        return;
      }
      await runOperationStep(deps, payload, helpers.abortSignal);
    };
  const taskHandlers = Object.entries(tasks).map(([name, task]): [string, JobHandler] => [
    name,
    (payload, helpers) => task(payload, helpers.abortSignal),
  ]);

  const operations =
    role === 'automation'
      ? await startRunner(
          { ...runnerOptions, concurrency: options.concurrency ?? 1 },
          Object.fromEntries([
            [AUTOMATION_OPERATION_TASK, operationStep(AUTOMATION_OPERATION_TASK)],
            ...taskHandlers,
          ]),
        )
      : await startRunner(
          { ...runnerOptions, concurrency: options.concurrency ?? 5, crontab: MAINTENANCE_CRONTAB },
          {
            [OPERATION_TASK]: operationStep(OPERATION_TASK),
            [MAINTENANCE_TASK]: async () => {
              await runJobQueueMaintenance(options.connectionString, logger);
            },
          },
        );
  let background: StartedRunner | undefined;
  if (role === 'worker' && (taskHandlers.length > 0 || crontab.length > 0)) {
    try {
      background = await startRunner(
        {
          ...runnerOptions,
          concurrency: options.taskConcurrency ?? 2,
          ...(crontab.length === 0 ? {} : { crontab: crontab.join('\n') }),
        },
        Object.fromEntries([
          ...taskHandlers,
          ...scheduledTasks.map((task): [string, JobHandler] => [
            task.name,
            (_payload, helpers) => task.run(helpers.abortSignal),
          ]),
        ]),
      );
    } catch (error) {
      stopping = true;
      await operations.stop();
      throw error;
    }
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
    poolId: operations.poolId,
    taskPoolId: background?.poolId,
    async stop() {
      stopping = true;
      clearInterval(recovery);
      await recovering;
      const stopped = await Promise.allSettled([operations.stop(), background?.stop()]);
      const failed = stopped.find((result) => result.status === 'rejected');
      if (failed !== undefined) throw failed.reason;
    },
  };
}

type JobHandler = (payload: unknown, helpers: JobHelpers) => Promise<void>;

interface StartedRunner {
  readonly poolId: string;
  stop(): Promise<void>;
}

/**
 * One Graphile Worker runner for `handlers` with its own liveness session. It takes only jobs
 * of its own tasks, and no job starts before other workers can see that this runner is alive.
 */
async function startRunner(
  options: {
    connectionString: string;
    logger: Logger;
    concurrency: number;
    pollIntervalMs: number;
    crontab?: string;
    fatal: (error: Error) => void;
    isStopping: () => boolean;
  },
  handlers: Readonly<Record<string, JobHandler>>,
): Promise<StartedRunner> {
  const { fatal } = options;
  let stopped = false;
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

  const taskList: TaskList = Object.fromEntries(
    Object.entries(handlers).map(([name, handler]): [string, TaskList[string]] => [
      name,
      async (payload, helpers) => {
        await registered;
        await handler(payload, helpers);
      },
    ]),
  );

  let runner;
  try {
    runner = await run({
      connectionString: options.connectionString,
      schema: JOB_QUEUE_SCHEMA,
      concurrency: options.concurrency,
      pollInterval: options.pollIntervalMs,
      noHandleSignals: true,
      logger: createJobQueueLogger(options.logger),
      events,
      taskList,
      ...(options.crontab === undefined ? {} : { crontab: options.crontab }),
    });
  } catch (error) {
    await liveness.close();
    throw error;
  }
  runner.promise.then(
    () => {
      if (!stopped && !options.isStopping()) {
        fatal(new Error('the job runner stopped unexpectedly'));
      }
    },
    (error: unknown) => {
      fatal(error instanceof Error ? error : new Error(String(error)));
    },
  );

  let poolId: string;
  try {
    poolId = await registered;
  } catch (error) {
    stopped = true;
    await runner.stop();
    await liveness.close();
    throw error;
  }
  return {
    poolId,
    async stop() {
      stopped = true;
      try {
        await runner.stop();
      } finally {
        await liveness.close();
      }
    },
  };
}

const RESERVED_TASKS: ReadonlySet<string> = new Set([
  OPERATION_TASK,
  AUTOMATION_OPERATION_TASK,
  MAINTENANCE_TASK,
]);

function validScheduledTasks(
  tasks: readonly ScheduledTask[],
  others: Readonly<Record<string, WorkerTask>>,
): void {
  const names = new Set<string>();
  for (const task of tasks) {
    if (!/^[a-z][a-z0-9_]*$/.test(task.name)) {
      throw new RangeError(`scheduled task name ${JSON.stringify(task.name)} is not valid`);
    }
    if (RESERVED_TASKS.has(task.name) || Object.hasOwn(others, task.name) || names.has(task.name)) {
      throw new RangeError(`scheduled task name ${task.name} is already taken`);
    }
    names.add(task.name);
    if (!/^\S+( \S+){4}$/.test(task.schedule)) {
      throw new RangeError(`scheduled task ${task.name} needs five crontab time fields`);
    }
    const attempts = task.maxAttempts ?? 1;
    if (!Number.isInteger(attempts) || attempts < 1) {
      throw new RangeError(`scheduled task ${task.name} needs a positive maxAttempts`);
    }
  }
}
