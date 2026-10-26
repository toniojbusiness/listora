/**
 * The worker's watch over phone work (docs/features/phone-execution.md), every minute:
 *
 * 1. A check whose phone run lapsed (the app stopped in the middle) waits for the phone again;
 *    its attempt is not counted. An operation step's lapsed run is the engine's to recover (its
 *    job finds it, phone-queue.ts in `@listora/operations`).
 * 2. A call the phone never answered is finished in `automation_run` as canceled.
 * 3. Work that waits gets the phone woken with a background push, at most every
 *    `notifyEveryMs` per account. iOS may not deliver it; the app also runs its work when it
 *    opens, on background app refresh, and overnight while charging, so nothing depends on it.
 */
import { sql } from 'kysely';

import { jsonb, type Db } from '@listora/db';
import { enqueueBackgroundPush } from '@listora/push';
import type { Logger } from '@listora/shared';

export const PHONE_WATCH_TASK = 'phone_work_watch';
export const PHONE_WATCH_SCHEDULE = '* * * * *';

export interface PhoneWatchOptions {
  db: Db;
  logger: Logger;
  /** How soon work that waits is first pushed for, and how often again (default 15 minutes). */
  notifyEveryMs?: number;
  /** How long after its call an unanswered phone call counts as abandoned (default 30 min). */
  abandonedAfterMs?: number;
}

export async function watchPhoneWork(options: PhoneWatchOptions): Promise<void> {
  const { db } = options;
  const log = options.logger.child({ task: PHONE_WATCH_TASK });
  const reset = await db
    .updateTable('phone_work')
    .set({
      claimed_at: null,
      lease_expires_at: null,
      step: null,
      transcript: jsonb([]),
      pending_call: null,
    })
    .where('purpose', '<>', 'operation')
    .where('lease_expires_at', '<=', sql<Date>`now()`)
    .executeTakeFirst();
  if (reset.numUpdatedRows > 0n) {
    log.info({ checks: Number(reset.numUpdatedRows) }, 'lapsed phone runs of checks wait again');
  }

  await db
    .updateTable('automation_run')
    .set({
      finished_at: sql<Date>`now()`,
      outcome: 'canceled',
      error_code: 'phone_stopped',
      failed_step: 'phone',
    })
    .where('host', '=', 'phone')
    .where('finished_at', 'is', null)
    .where(
      'started_at',
      '<',
      sql<Date>`now() - make_interval(secs => ${(options.abandonedAfterMs ?? 30 * 60_000) / 1000})`,
    )
    .execute();

  const every = (options.notifyEveryMs ?? 15 * 60_000) / 1000;
  const due = await db
    .updateTable('phone_work')
    .set({ notified_at: sql<Date>`now()` })
    .where('claimed_at', 'is', null)
    .where('due_at', '<=', sql<Date>`now()`)
    .where((eb) =>
      eb.or([
        eb('notified_at', 'is', null),
        eb('notified_at', '<', sql<Date>`now() - make_interval(secs => ${every})`),
      ]),
    )
    .returning(['account_id'])
    .execute();
  const accounts = [...new Set(due.map((row) => row.account_id))];
  for (const accountId of accounts) {
    await enqueueBackgroundPush(
      db,
      { accountId, reason: 'phone_work' },
      { key: `phone_work:${accountId}` },
    );
  }
  if (accounts.length > 0) log.info({ accounts: accounts.length }, 'woke phones for waiting work');
}
