/**
 * The worker's side of browser automation (decision D1), run every minute as a scheduled task:
 *
 * 1. adds the job of every sale check that is due (sale-checks/schedule.ts);
 * 2. starts the browser runner when automated work waits and no runner is alive (an automated
 *    operation step the worker handed over, a sale check, or the check of a session the seller
 *    just linked);
 * 3. keeps the run history short: screenshots go after `SCREENSHOT_RETENTION_DAYS`, run
 *    records after `RUN_RETENTION_DAYS`.
 *
 * A handed-over step also starts the runner at once (`nudge`), without waiting for the minute.
 */
import { sql } from 'kysely';

import type { Db } from '@listora/db';
import type { AdapterLookup, ConnectionRef } from '@listora/marketplaces';
import { AUTOMATION_OPERATION_TASK } from '@listora/operations';
import type { Logger } from '@listora/shared';
import type { ObjectStorage } from '@listora/storage';

import { browserRunnerAlive, type RunnerLauncher } from './launcher.ts';
import { SCREENSHOT_RETENTION_DAYS } from './runner/screenshots.ts';
import { readsOrders } from './sale-checks/job.ts';
import {
  dueSaleChecks,
  enqueueSaleCheck,
  SALE_CHECK_TASK,
  scheduleSaleCheck,
  type ScheduledCheck,
} from './sale-checks/schedule.ts';
import { SESSION_CHECK_TASK } from './session-checks/schedule.ts';

/** The worker's scheduled task, every minute. */
export const AUTOMATION_DISPATCH_TASK = 'automation_dispatch';
export const AUTOMATION_DISPATCH_SCHEDULE = '* * * * *';

/** Run records are kept this long (the rate limit needs a day; the rest is for support). */
export const RUN_RETENTION_DAYS = 90;
const PRUNE_BATCH = 200;

/** The job queue tasks only the browser runner takes. */
export const RUNNER_TASKS = [
  AUTOMATION_OPERATION_TASK,
  SALE_CHECK_TASK,
  SESSION_CHECK_TASK,
] as const;

export interface DispatcherOptions {
  db: Db;
  launcher: RunnerLauncher;
  storage: ObjectStorage;
  logger: Logger;
  /** The worker's adapters: a check is queued only where an adapter can read the orders. */
  adapters: AdapterLookup;
  /** How far a check that no adapter can run is put off (the longest sale-check interval). */
  deferUnsupportedMs: number;
}

export class AutomationDispatcher {
  readonly #options: DispatcherOptions;
  readonly #log: Logger;
  #nudging: Promise<void> | null = null;

  constructor(options: DispatcherOptions) {
    this.#options = options;
    this.#log = options.logger.child({ task: AUTOMATION_DISPATCH_TASK });
  }

  /** One round of the scheduled task. */
  async dispatch(): Promise<void> {
    const { db } = this.#options;
    const due = await dueSaleChecks(db);
    let added = 0;
    for (const check of due) {
      const connection = await connectionRef(db, check);
      if (connection === undefined) continue;
      if (!readsOrders(this.#options.adapters(check.marketplace), connection)) {
        // Nothing can check this marketplace's sales yet: put it off rather than start a runner.
        await scheduleSaleCheck(db, {
          ...check,
          at: new Date(Date.now() + this.#options.deferUnsupportedMs),
          reason: 'retry',
        });
        continue;
      }
      if (await enqueueSaleCheck(db, check)) added += 1;
    }
    if (added > 0) this.#log.info({ added }, 'sale checks due');
    await this.#startRunnerIfNeeded();
    await this.#prune();
  }

  /** Starts the runner now if work waits for it (after a handover); never throws. */
  nudge(): void {
    if (this.#nudging !== null) return;
    this.#nudging = this.#startRunnerIfNeeded()
      .catch((error: unknown) => {
        this.#log.error({ err: error }, 'could not check whether the browser runner is needed');
      })
      .finally(() => {
        this.#nudging = null;
      });
  }

  async #startRunnerIfNeeded(): Promise<void> {
    const { db, launcher } = this.#options;
    if (!(await runnerWorkWaiting(db)) || (await browserRunnerAlive(db))) return;
    await launcher.ensureRunning();
  }

  async #prune(): Promise<void> {
    const { db, storage } = this.#options;
    const old = await db
      .selectFrom('automation_run')
      .select(['account_id', 'id', 'screenshot_key'])
      .where('screenshot_key', 'is not', null)
      .where(
        'started_at',
        '<',
        sql<Date>`now() - make_interval(days => ${SCREENSHOT_RETENTION_DAYS})`,
      )
      .limit(PRUNE_BATCH)
      .execute();
    for (const run of old) {
      if (run.screenshot_key !== null) await storage.delete(run.screenshot_key);
      await db
        .updateTable('automation_run')
        .set({ screenshot_key: null })
        .where('account_id', '=', run.account_id)
        .where('id', '=', run.id)
        .execute();
    }
    await sql`
      delete from automation_run where id in (
        select id from automation_run
        where screenshot_key is null
          and started_at < now() - make_interval(days => ${RUN_RETENTION_DAYS})
        limit ${PRUNE_BATCH}
      )
    `.execute(db);
  }
}

async function connectionRef(db: Db, check: ScheduledCheck): Promise<ConnectionRef | undefined> {
  return db
    .selectFrom('marketplace_connection')
    .select(['id', 'mode', 'status'])
    .where('account_id', '=', check.accountId)
    .where('id', '=', check.connectionId)
    .executeTakeFirst();
}

/** Whether a job only the runner takes is due and not yet running. */
export async function runnerWorkWaiting(db: Db): Promise<boolean> {
  const { rows } = await sql<{ waiting: boolean }>`
    select exists (
      select 1 from graphile_worker.jobs
      where task_identifier = any(${[...RUNNER_TASKS]}::text[])
        and run_at <= now() and locked_at is null
        and attempts < max_attempts
    ) as waiting
  `.execute(db);
  return rows[0]?.waiting === true;
}

/** Whether the runner has anything to do: a job of its own due now or running. */
export async function runnerWorkPending(db: Db): Promise<boolean> {
  const { rows } = await sql<{ pending: boolean }>`
    select exists (
      select 1 from graphile_worker.jobs
      where task_identifier = any(${[...RUNNER_TASKS]}::text[])
        and (locked_at is not null or (run_at <= now() and attempts < max_attempts))
    ) as pending
  `.execute(db);
  return rows[0]?.pending === true;
}
