import type { ApiFeature } from '../features.ts';

import { registerMarketplaceSessionRoutes } from './routes.ts';

/** Linking Poshmark, Mercari, Depop, and eBay by signing in, and each session's check. */
export const feature: ApiFeature = {
  registerRoutes: (app, context) => {
    registerMarketplaceSessionRoutes(app, { ...context, ...context.marketplaceSessions });
  },
};
