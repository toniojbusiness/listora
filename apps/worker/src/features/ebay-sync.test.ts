import { describe, expect, it } from 'vitest';

import type { ConnectionTokens } from '@listora/connections';
import type { Db } from '@listora/db';
import { loadEbayConfig } from '@listora/marketplaces';
import { createLogger } from '@listora/shared';

import { createEbaySyncWork } from './ebay-sync.ts';

const logger = createLogger({ service: 'test', level: 'silent' });
const db = {} as Db;
const tokens = {} as ConnectionTokens;
const adapters = () => undefined;

describe('createEbaySyncWork', () => {
  it('runs listing resyncs everywhere, and eBay work only as far as it is configured', () => {
    const none = createEbaySyncWork({ db, ebay: undefined, tokens, adapters, logger });
    expect(Object.keys(none.tasks)).toEqual(['listing_resync']);
    expect(none.scheduledTasks).toEqual([]);

    const ebay = loadEbayConfig({ EBAY_ENV: 'fake' });
    const noVault = createEbaySyncWork({ db, ebay, tokens: undefined, adapters, logger });
    expect(Object.keys(noVault.tasks).sort()).toEqual(['ebay_user_deletion', 'listing_resync']);

    const polling = createEbaySyncWork({ db, ebay, tokens, adapters, logger });
    expect(Object.keys(polling.tasks).sort()).toEqual([
      'ebay_connection_order_poll',
      'ebay_notification',
      'ebay_user_deletion',
      'listing_resync',
    ]);
    expect(polling.scheduledTasks.map((task) => [task.name, task.schedule])).toEqual([
      ['ebay_order_poll', '*/5 * * * *'],
    ]);

    const notifying = createEbaySyncWork({
      db,
      ebay: loadEbayConfig({
        EBAY_ENV: 'fake',
        EBAY_NOTIFICATION_ENDPOINT: 'http://127.0.0.1:3000/webhooks/ebay',
        EBAY_NOTIFICATION_VERIFICATION_TOKEN: 'listora-dev-only-verification-token-not-a-secret',
      }),
      tokens,
      adapters,
      logger,
    });
    expect(Object.keys(notifying.tasks)).toContain('ebay_seller_subscriptions');
    expect(notifying.scheduledTasks.map((task) => task.name)).toEqual([
      'ebay_notification_setup',
      'ebay_order_poll',
    ]);
    // Without a vault, only the application's own subscriptions can be kept.
    const appOnly = createEbaySyncWork({
      db,
      ebay: loadEbayConfig({
        EBAY_ENV: 'fake',
        EBAY_NOTIFICATION_ENDPOINT: 'http://127.0.0.1:3000/webhooks/ebay',
        EBAY_NOTIFICATION_VERIFICATION_TOKEN: 'listora-dev-only-verification-token-not-a-secret',
      }),
      tokens: undefined,
      adapters,
      logger,
    });
    expect(Object.keys(appOnly.tasks)).not.toContain('ebay_seller_subscriptions');
    expect(appOnly.scheduledTasks.map((task) => task.name)).toEqual(['ebay_notification_setup']);
  });
});
