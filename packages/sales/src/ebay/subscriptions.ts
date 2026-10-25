/**
 * Keeping eBay's notification subscriptions in place, from the worker
 * (`EbayNotificationSubscriptions` in `@listora/marketplaces` does the eBay calls):
 *
 * - `ebay_notification_setup` (at worker start and every day): the alert email, Listora's
 *   destination, and the application topics (`MARKETPLACE_ACCOUNT_DELETION`, which eBay
 *   requires, and `AUTHORIZATION_REVOCATION`); then one `ebay_seller_subscriptions` job per
 *   connected seller.
 * - `ebay_seller_subscriptions` (also added when a seller connects): `ORDER_CONFIRMATION` and
 *   `LISTING` with that seller's token.
 *
 * Both are idempotent. Outages throw so the queue runs the job again; a refusal that needs a
 * person (no alert email configured, a topic eBay does not let Listora subscribe to) is logged
 * as an error and waits for the next day's run. The poll backstop records sales either way.
 */
import { addJob, type BackgroundJob, type Db } from '@listora/db';
import type {
  DestinationResult,
  EbayNotificationSubscriptions,
  TopicResult,
} from '@listora/marketplaces';
import type { Logger } from '@listora/shared';

import { EbaySyncRetryError, type SellerTokens } from './process.ts';

export const EBAY_NOTIFICATION_SETUP_TASK = 'ebay_notification_setup';
/** 04:23 UTC every day (the worker's scheduled task). */
export const EBAY_NOTIFICATION_SETUP_SCHEDULE = '23 4 * * *';
export const EBAY_SELLER_SUBSCRIPTIONS_TASK = 'ebay_seller_subscriptions';

export interface EbaySellerSubscriptionsPayload {
  connectionId: string;
}

export function isEbaySellerSubscriptionsPayload(
  value: unknown,
): value is EbaySellerSubscriptionsPayload {
  if (typeof value !== 'object' || value === null) return false;
  return typeof (value as Record<string, unknown>)['connectionId'] === 'string';
}

/** The job that subscribes one seller's topics; add it when the seller connects. */
export function ebaySellerSubscriptionsJob(connectionId: string): BackgroundJob {
  const payload: EbaySellerSubscriptionsPayload = { connectionId };
  return {
    task: EBAY_SELLER_SUBSCRIPTIONS_TASK,
    payload: { ...payload },
    jobKey: `ebay-seller-subscriptions:${connectionId}`,
  };
}

/** The setup job; the worker adds it at start (one pending job however many workers start). */
export function ebayNotificationSetupJob(): BackgroundJob {
  return { task: EBAY_NOTIFICATION_SETUP_TASK, payload: {}, jobKey: EBAY_NOTIFICATION_SETUP_TASK };
}

export interface EbaySubscriptionDependencies {
  db: Db;
  subscriptions: EbayNotificationSubscriptions;
  /** The sellers' tokens; without them (no token vault) only the application's topics. */
  tokens: SellerTokens | undefined;
  logger: Logger;
}

export async function runEbayNotificationSetup(
  deps: EbaySubscriptionDependencies,
  signal: AbortSignal,
): Promise<{ destination: DestinationResult['type']; sellers: number }> {
  const destination = await readyDestination(deps, signal);
  if (destination === undefined) return { destination: 'config_required', sellers: 0 };
  const topics = await deps.subscriptions.ensureApplicationTopics(destination, signal);
  report(deps.logger, topics, { scope: 'application' });
  if (deps.tokens === undefined) return { destination: 'ready', sellers: 0 };

  const sellers = await deps.db
    .selectFrom('marketplace_connection')
    .select('id')
    .where('marketplace', '=', 'ebay')
    .where('mode', '=', 'api')
    .where('status', 'in', ['connected', 'degraded'])
    .where('token_ciphertext', 'is not', null)
    .orderBy('id')
    .execute();
  for (const seller of sellers) await addJob(deps.db, ebaySellerSubscriptionsJob(seller.id));
  return { destination: 'ready', sellers: sellers.length };
}

export async function subscribeEbaySeller(
  deps: EbaySubscriptionDependencies,
  payload: EbaySellerSubscriptionsPayload,
  signal: AbortSignal,
): Promise<'subscribed' | 'incomplete' | 'skipped'> {
  const tokens = deps.tokens;
  if (tokens === undefined) return 'skipped';
  const connection = await deps.db
    .selectFrom('marketplace_connection')
    .select('id')
    .where('id', '=', payload.connectionId)
    .where('marketplace', '=', 'ebay')
    .where('mode', '=', 'api')
    .where('status', 'in', ['connected', 'degraded'])
    .executeTakeFirst();
  if (connection === undefined) return 'skipped';
  const destination = await readyDestination(deps, signal);
  if (destination === undefined) return 'skipped';
  for (let attempt = 1; ; attempt += 1) {
    const token = await tokens.accessToken(connection.id, signal);
    if (token.type === 'reauth_required') return 'skipped';
    if (token.type === 'unavailable') {
      throw new EbaySyncRetryError(`the seller's eBay token is unavailable (${token.code})`);
    }
    const topics = await deps.subscriptions.ensureSellerTopics(
      destination,
      token.accessToken,
      signal,
    );
    // A token that stopped working early: refresh once and try again.
    if (attempt === 1 && topics.some((topic) => topic.type === 'token_rejected')) {
      await tokens.invalidate(connection.id, token.accessToken);
      continue;
    }
    report(deps.logger, topics, { scope: 'seller', connectionId: connection.id });
    if (topics.some((topic) => topic.type === 'unavailable' || topic.type === 'token_rejected')) {
      throw new EbaySyncRetryError('eBay could not subscribe the seller now');
    }
    return topics.every((topic) => topic.type === 'subscribed') ? 'subscribed' : 'incomplete';
  }
}

async function readyDestination(
  deps: EbaySubscriptionDependencies,
  signal: AbortSignal,
): Promise<string | undefined> {
  const destination = await deps.subscriptions.ensureDestination(signal);
  switch (destination.type) {
    case 'ready':
      return destination.destinationId;
    case 'unavailable':
      throw new EbaySyncRetryError(`eBay notifications are unavailable (${destination.code})`);
    case 'config_required':
    case 'challenge_failed':
    case 'refused':
      deps.logger.error(
        { event: 'ebay_notification_setup', result: destination.type, code: destination.code },
        `eBay notifications are not set up: ${destination.message}`,
      );
      return undefined;
  }
}

function report(logger: Logger, topics: TopicResult[], context: Record<string, unknown>): void {
  for (const topic of topics) {
    if (topic.type === 'subscribed') continue;
    logger.error(
      {
        event: 'ebay_notification_subscription',
        topic: topic.topicId,
        result: topic.type,
        code: topic.code,
        ...context,
      },
      `eBay did not subscribe ${topic.topicId}: ${topic.message}`,
    );
  }
}
