/**
 * The push outbox. A notification is added as a job on the caller's connection, so it is sent
 * only if the change it announces commits, and it is sent after the commit, never from inside
 * a transaction. A send that fails runs again with the queue's backoff, a few times: a reminder
 * that arrives an hour late helps nobody, and the app shows the same state anyway.
 */
import { sql } from 'kysely';

import { JOB_QUEUE_SCHEMA, type DbExecutor } from '@listora/db';
import type { Logger } from '@listora/shared';

import { parsePushNotification, type PushNotification } from './notification.ts';
import type { PushSender } from './sender.ts';

/** The worker task that sends one queued notification. */
export const PUSH_TASK = 'push_notification';

/** Graphile's backoff makes six attempts span about ten minutes. */
export const PUSH_JOB_MAX_ATTEMPTS = 6;

/**
 * Queues a notification in the caller's transaction. One pending job per `key`: queueing the
 * same key again before it is sent replaces it, so a retried change never sends twice.
 */
export async function enqueuePush(
  executor: DbExecutor,
  notification: PushNotification,
  options: { key: string },
): Promise<void> {
  const checked = parsePushNotification(notification);
  await sql`
    select ${sql.id(JOB_QUEUE_SCHEMA)}.add_job(
      identifier => ${PUSH_TASK},
      payload => ${JSON.stringify(checked)}::json,
      max_attempts => ${PUSH_JOB_MAX_ATTEMPTS},
      job_key => ${`push:${options.key}`}
    )
  `.execute(executor);
}

/** The `push_notification` job: sends it, or drops a payload that is not a notification. */
export async function deliverPush(
  deps: { sender: PushSender; logger: Pick<Logger, 'error'> },
  payload: unknown,
  signal: AbortSignal,
): Promise<void> {
  let notification: PushNotification;
  try {
    notification = parsePushNotification(payload);
  } catch (error) {
    deps.logger.error({ task: PUSH_TASK, err: error }, 'job with an invalid payload; dropping it');
    return;
  }
  await deps.sender.send(notification, signal);
}
