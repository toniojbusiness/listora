import type { ApiFeature } from '../features.ts';

import { registerListingRefreshRoutes } from './routes.ts';

/** Listing refresh: the account's setting and an item's own cadence. */
export const feature: ApiFeature = { registerRoutes: registerListingRefreshRoutes };
