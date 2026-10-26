/**
 * Background pushes: no alert, only a nudge that wakes the app in the background (APNs
 * `content-available`, push type `background`) so it runs work that waits for the phone
 * (docs/features/phone-execution.md). iOS delivers them at its own pace and may drop them, so
 * nothing depends on one: the app also runs that work when it opens, on background app
 * refresh, and overnight while the phone charges. Queued like notifications (outbox.ts).
 */
import { sql } from 'kysely';

import { JOB_QUEUE_SCHEMA, type DbExecutor } from '@listora/db';
import type { Logger } from '@listora/shared';

import type { PushSender } from './sender.ts';

export interface BackgroundPush {
  accountId: string;
  /** Why the app is woken, such as `phone_work` (snake_case). */
  reason: string;
}

/** The worker task that sends one queued background push. */
export const BACKGROUND_PUSH_TASK = 'push_background';

const REASON = /^[a-z][a-z0-9_]{0,63}$/;

export function parseBackgroundPush(value: unknown): BackgroundPush {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid background push: expected an object');
  }
  const { accountId, reason } = value as Record<string, unknown>;
  if (typeof accountId !== 'string' || accountId === '') {
    throw new Error('Invalid background push: accountId is required');
  }
  if (typeof reason !== 'string' || !REASON.test(reason)) {
    throw new Error('Invalid background push: reason must be a snake_case name');
  }
  return { accountId, reason };
}

/**
 * Queues a background push in the caller's transaction; one pending push per `key`, and a
 * failed send is tried only twice more (a late nudge is worth little).
 */
export async function enqueueBackgroundPush(
  executor: DbExecutor,
  push: BackgroundPush,
  options: { key: string },
): Promise<void> {
  const checked = parseBackgroundPush(push);
  await sql`
    select ${sql.id(JOB_QUEUE_SCHEMA)}.add_job(
      identifier => ${BACKGROUND_PUSH_TASK},
      payload => ${JSON.stringify(checked)}::json,
      max_attempts => 3,
      job_key => ${`push_background:${options.key}`}
    )
  `.execute(executor);
}

/** The `push_background` job. */
export async function deliverBackgroundPush(
  deps: { sender: PushSender; logger: Pick<Logger, 'error'> },
  payload: unknown,
  signal: AbortSignal,
): Promise<void> {
  let push: BackgroundPush;
  try {
    push = parseBackgroundPush(payload);
  } catch (error) {
    deps.logger.error(
      { task: BACKGROUND_PUSH_TASK, err: error },
      'job with an invalid payload; dropping it',
    );
    return;
  }
  await deps.sender.sendBackground(push, signal);
}
