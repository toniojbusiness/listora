/**
 * The operation's job in Graphile Worker. Jobs are added with the queue's SQL functions on the
 * caller's own connection, so a job is committed or rolled back together with the operation
 * change that needs it.
 *
 * - Every step is scheduled as `marketplace_operation`, which the always-on worker runs. A step
 *   whose mode is `automation` needs a browser, so the worker hands it over as
 *   `marketplace_operation_automation`, which only the browser runner takes (executor.ts).
 *
 * - One job key per operation (`operation:<id>`): adding the job again replaces the pending one,
 *   so an operation never has two pending jobs. If its job is running, Graphile retires the
 *   running job's key and adds a new job for the next step.
 * - One named queue per listing (`listing:<id>`): Graphile runs at most one job of a queue at a
 *   time, so two operations on the same listing never run at once.
 */
import { sql } from 'kysely';

import type { DbExecutor } from '@listora/db';

/** The Graphile Worker task that runs one step of an operation (executor.ts). */
export const OPERATION_TASK = 'marketplace_operation';

/** The same step, handed to the browser runner because it acts in a browser session. */
export const AUTOMATION_OPERATION_TASK = 'marketplace_operation_automation';

export type OperationTask = typeof OPERATION_TASK | typeof AUTOMATION_OPERATION_TASK;

/**
 * Graphile retries a job whose handler throws (a database outage, a bug) with its own backoff,
 * capped near six hours. Marketplace failures never throw; they are handled by the engine's own
 * schedule. The maximum smallint means an operation's job is never dropped while it is stuck.
 */
export const OPERATION_JOB_MAX_ATTEMPTS = 32_767;

/** Graphile runs lower numbers first: delists after a sale go ahead of routine changes. */
export const OPERATION_PRIORITY = { normal: 0, urgent: -10 } as const;

export interface OperationJobPayload {
  accountId: string;
  operationId: string;
}

export function operationJobKey(operationId: string): string {
  return `operation:${operationId}`;
}

export function listingQueueName(listingId: string): string {
  return `listing:${listingId}`;
}

export function isOperationJobPayload(value: unknown): value is OperationJobPayload {
  if (typeof value !== 'object' || value === null) return false;
  const { accountId, operationId } = value as Record<string, unknown>;
  return typeof accountId === 'string' && typeof operationId === 'string';
}

export interface ScheduleOptions {
  accountId: string;
  operationId: string;
  listingId: string;
  priority: number;
  /** When the job runs; `null` runs it now. */
  runAt: Date | null;
  /** Which process runs it (default: the worker). */
  task?: OperationTask;
}

/** Adds (or replaces) the operation's job. */
export async function scheduleOperationJob(
  executor: DbExecutor,
  options: ScheduleOptions,
): Promise<void> {
  const payload: OperationJobPayload = {
    accountId: options.accountId,
    operationId: options.operationId,
  };
  await sql`
    select graphile_worker.add_job(
      identifier => ${options.task ?? OPERATION_TASK},
      payload => ${JSON.stringify(payload)}::json,
      queue_name => ${listingQueueName(options.listingId)},
      run_at => ${options.runAt}::timestamptz,
      max_attempts => ${OPERATION_JOB_MAX_ATTEMPTS},
      job_key => ${operationJobKey(options.operationId)},
      priority => ${options.priority},
      job_key_mode => 'replace'
    )
  `.execute(executor);
}

/** Removes the operation's pending job, if it has one that is not running. */
export async function removeOperationJob(executor: DbExecutor, operationId: string): Promise<void> {
  await sql`select graphile_worker.remove_job(${operationJobKey(operationId)})`.execute(executor);
}
