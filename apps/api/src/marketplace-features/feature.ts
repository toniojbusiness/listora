import type { ApiFeature } from '../features.ts';

import { registerMarketplaceFeatureRoutes } from './routes.ts';

/** Marketplace features: what the app shows of each marketplace, those verified live. */
export const feature: ApiFeature = { registerRoutes: registerMarketplaceFeatureRoutes };
