import type { ConnectionTokens } from '@listora/connections';
import { addJob, type Db } from '@listora/db';
import {
  ApplicationToken,
  EbayNotificationSubscriptions,
  EbayOAuthClient,
  type AdapterLookup,
  type EbayConfig,
} from '@listora/marketplaces';
import {
  isListingResyncPayload,
  LISTING_RESYNC_TASK,
  runListingResync,
  type ScheduledTask,
  type WorkerTask,
} from '@listora/operations';
import {
  EBAY_CONNECTION_POLL_TASK,
  EBAY_NOTIFICATION_SETUP_SCHEDULE,
  EBAY_NOTIFICATION_SETUP_TASK,
  EBAY_NOTIFICATION_TASK,
  EBAY_ORDER_POLL_SCHEDULE,
  EBAY_ORDER_POLL_TASK,
  EBAY_SELLER_SUBSCRIPTIONS_TASK,
  EBAY_USER_DELETION_TASK,
  ebayNotificationSetupJob,
  isEbayConnectionPollPayload,
  isEbayNotificationJobPayload,
  isEbaySellerSubscriptionsPayload,
  isEbayUserDeletionPayload,
  pollEbayConnectionOrders,
  processEbayNotification,
  purgeEbayUser,
  runEbayNotificationSetup,
  scheduleEbayOrderPolls,
  subscribeEbaySeller,
} from '@listora/sales';
import type { Logger } from '@listora/shared';

export interface EbaySyncDependencies {
  db: Db;
  /** Undefined when eBay is not configured. */
  ebay: EbayConfig | undefined;
  /** The connections' tokens; undefined without a token vault (no seller can be read then). */
  tokens: ConnectionTokens | undefined;
  adapters: AdapterLookup;
  logger: Logger;
}

export interface EbaySyncWork {
  tasks: Record<string, WorkerTask>;
  scheduledTasks: ScheduledTask[];
  /** Adds the jobs the worker queues when it starts (the notification setup). */
  start(): Promise<void>;
}

/**
 * The worker's eBay notification and order sync work (docs/ebay-notifications.md): stored
 * notifications, the 5-minute order poll, eBay account deletions, listing read-backs, and
 * keeping the subscriptions in place. Listing read-backs run for every marketplace; the rest
 * needs eBay: the eBay user purge whenever it is configured, the notification setup with
 * `EBAY_NOTIFICATION_*`, and anything that reads a seller's data with the token vault.
 */
export function createEbaySyncWork(deps: EbaySyncDependencies): EbaySyncWork {
  const { db, ebay, tokens, logger } = deps;
  const tasks: Record<string, WorkerTask> = {
    [LISTING_RESYNC_TASK]: async (payload, signal) => {
      if (!isListingResyncPayload(payload)) {
        dropped(logger, LISTING_RESYNC_TASK);
        return;
      }
      await runListingResync({ db, adapters: deps.adapters, logger }, payload, signal);
    },
  };
  const scheduledTasks: ScheduledTask[] = [];
  let start = (): Promise<void> => Promise.resolve();
  if (ebay === undefined) return { tasks, scheduledTasks, start };

  tasks[EBAY_USER_DELETION_TASK] = async (payload) => {
    if (!isEbayUserDeletionPayload(payload)) {
      dropped(logger, EBAY_USER_DELETION_TASK);
      return;
    }
    await purgeEbayUser({ db, logger }, payload);
  };
  if (ebay.notifications !== undefined) {
    const applicationToken = new ApplicationToken(
      new EbayOAuthClient({
        tokenUrl: ebay.endpoints.oauthToken,
        clientId: ebay.clientId,
        clientSecret: ebay.clientSecret,
      }),
    );
    const subscriptions = new EbayNotificationSubscriptions({
      endpoints: ebay.endpoints,
      applicationToken,
      settings: ebay.notifications,
    });
    const setup = { db, subscriptions, tokens, logger };
    if (tokens !== undefined) {
      tasks[EBAY_SELLER_SUBSCRIPTIONS_TASK] = async (payload, signal) => {
        if (!isEbaySellerSubscriptionsPayload(payload)) {
          dropped(logger, EBAY_SELLER_SUBSCRIPTIONS_TASK);
          return;
        }
        await subscribeEbaySeller(setup, payload, signal);
      };
    }
    scheduledTasks.push({
      name: EBAY_NOTIFICATION_SETUP_TASK,
      schedule: EBAY_NOTIFICATION_SETUP_SCHEDULE,
      maxAttempts: 5,
      run: async (signal) => {
        await runEbayNotificationSetup(setup, signal);
      },
    });
    start = async () => {
      await addJob(db, ebayNotificationSetupJob());
    };
  }
  if (tokens !== undefined) {
    const sync = { db, endpoints: ebay.endpoints, tokens, logger };
    tasks[EBAY_NOTIFICATION_TASK] = async (payload, signal) => {
      if (!isEbayNotificationJobPayload(payload)) {
        dropped(logger, EBAY_NOTIFICATION_TASK);
        return;
      }
      await processEbayNotification(sync, payload, signal);
    };
    tasks[EBAY_CONNECTION_POLL_TASK] = async (payload, signal) => {
      if (!isEbayConnectionPollPayload(payload)) {
        dropped(logger, EBAY_CONNECTION_POLL_TASK);
        return;
      }
      await pollEbayConnectionOrders(sync, payload, signal);
    };
    scheduledTasks.push({
      name: EBAY_ORDER_POLL_TASK,
      schedule: EBAY_ORDER_POLL_SCHEDULE,
      // A missed run is covered by the next one, 5 minutes later.
      maxAttempts: 1,
      run: async () => {
        await scheduleEbayOrderPolls(db);
      },
    });
  }

  return { tasks, scheduledTasks, start };
}

function dropped(logger: Logger, task: string): void {
  logger.error({ task }, 'job with an invalid payload; dropping it');
}
