/**
 * The push notification the first time a connection breaks: when it leaves a working status
 * (`connected`, `degraded`) for one only the seller can fix (`reauth_required`, `revoked`). It is
 * queued in the transaction that records the break, so it goes out only if the break commits,
 * and a connection that is already broken never sends it again until it is reconnected and
 * breaks anew (docs/features/connections.md).
 */
import type { DbExecutor, Marketplace } from '@listora/db';
import { MARKETPLACE_NAMES } from '@listora/marketplaces';
import { enqueuePush, PUSH_BODY_MAX_LENGTH, type PushNotification } from '@listora/push';

/** The app's notification category; tapping it opens the Marketplaces screen. */
export const CONNECTION_BROKEN_CATEGORY = 'connection_needs_attention';

/** Statuses a connection works in; leaving them for another is a break. */
export const WORKING_STATUSES = ['connected', 'degraded'] as const;

export interface BrokenConnection {
  connectionId: string;
  accountId: string;
  marketplace: Marketplace;
  /** User-readable: what happened and what to do, naming the marketplace. */
  message: string;
}

export function connectionBrokenNotification(broken: BrokenConnection): PushNotification {
  return {
    accountId: broken.accountId,
    category: CONNECTION_BROKEN_CATEGORY,
    title: `Reconnect ${MARKETPLACE_NAMES[broken.marketplace]}`,
    body: fitted(broken.message),
    urgency: 'normal',
    threadId: `connection:${broken.marketplace}`,
    data: { marketplace: broken.marketplace },
  };
}

/** Queues the break's notification in `executor`'s transaction; one per break. */
export async function notifyConnectionBroken(
  executor: DbExecutor,
  broken: BrokenConnection,
  brokenAt: Date,
): Promise<void> {
  await enqueuePush(executor, connectionBrokenNotification(broken), {
    key: `connection_broken:${broken.connectionId}:${String(brokenAt.getTime())}`,
  });
}

/** The message as a notification body; a marketplace's own long message is shortened. */
function fitted(message: string): string {
  const text = message.trim();
  if (text === '') return 'Open Listora to see what it needs.';
  return text.length <= PUSH_BODY_MAX_LENGTH
    ? text
    : `${text.slice(0, PUSH_BODY_MAX_LENGTH - 1).trimEnd()}\u2026`;
}
