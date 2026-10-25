/**
 * A push notification to everyone signed in to an account (docs/features/push.md). It carries
 * only what the lock screen shows and the ids the app opens when it is tapped: never tokens,
 * buyer data, or anything else a lock screen must not show.
 */

/** How the device presents it: `time_sensitive` breaks through Focus (APNs interruption level). */
export const PUSH_URGENCIES = ['normal', 'time_sensitive'] as const;
export type PushUrgency = (typeof PUSH_URGENCIES)[number];

export const PUSH_TITLE_MAX_LENGTH = 120;
export const PUSH_BODY_MAX_LENGTH = 500;

export interface PushNotification {
  accountId: string;
  /** What it is about, such as `item_sold` (the app's notification category, APNs `category`). */
  category: string;
  title: string;
  body: string;
  urgency: PushUrgency;
  /** Groups related notifications on the device, such as one item's (APNs `thread-id`). */
  threadId: string | null;
  /** Ids the app opens when the notification is tapped, such as `itemId`. */
  data: Readonly<Record<string, string>>;
}

export class InvalidPushNotificationError extends Error {
  constructor(message: string) {
    super(`Invalid push notification: ${message}`);
    this.name = 'InvalidPushNotificationError';
  }
}

const CATEGORY = /^[a-z][a-z0-9_]{0,63}$/;
const DATA_KEY = /^[a-zA-Z][a-zA-Z0-9]{0,63}$/;

/**
 * Checks a notification, also one read back from a job's JSON payload. A title or body longer
 * than the limit is an error rather than cut, so a caller's mistake is found in tests.
 */
export function parsePushNotification(value: unknown): PushNotification {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidPushNotificationError('expected an object');
  }
  const record = value as Record<string, unknown>;
  const { accountId, category, title, body, urgency, threadId, data } = record;
  if (typeof accountId !== 'string' || accountId === '') {
    throw new InvalidPushNotificationError('accountId is required');
  }
  if (typeof category !== 'string' || !CATEGORY.test(category)) {
    throw new InvalidPushNotificationError('category must be a snake_case name');
  }
  if (typeof title !== 'string' || title === '' || title.length > PUSH_TITLE_MAX_LENGTH) {
    throw new InvalidPushNotificationError(
      `title must have 1 to ${String(PUSH_TITLE_MAX_LENGTH)} characters`,
    );
  }
  if (typeof body !== 'string' || body === '' || body.length > PUSH_BODY_MAX_LENGTH) {
    throw new InvalidPushNotificationError(
      `body must have 1 to ${String(PUSH_BODY_MAX_LENGTH)} characters`,
    );
  }
  const knownUrgency = PUSH_URGENCIES.find((candidate) => candidate === urgency);
  if (knownUrgency === undefined) {
    throw new InvalidPushNotificationError(`urgency must be one of ${PUSH_URGENCIES.join(', ')}`);
  }
  if (threadId !== null && (typeof threadId !== 'string' || threadId === '')) {
    throw new InvalidPushNotificationError('threadId must be a non-empty string or null');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new InvalidPushNotificationError('data must be an object');
  }
  const entries = Object.entries(data as Record<string, unknown>);
  for (const [key, entry] of entries) {
    if (!DATA_KEY.test(key) || typeof entry !== 'string') {
      throw new InvalidPushNotificationError('data must map camelCase keys to strings');
    }
  }
  return {
    accountId,
    category,
    title,
    body,
    urgency: knownUrgency,
    threadId,
    data: Object.fromEntries(entries) as Record<string, string>,
  };
}
