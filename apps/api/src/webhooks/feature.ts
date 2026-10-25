import type { ApiFeature } from '../features.ts';
import { registerEbayWebhookRoutes } from './ebay.ts';

/** Marketplace webhooks: eBay's notification endpoint, when eBay notifications are configured. */
export const feature: ApiFeature = {
  registerRoutes: (app, context) => {
    if (context.ebayWebhook !== undefined) {
      registerEbayWebhookRoutes(app, { db: context.db, ...context.ebayWebhook });
    }
  },
};
