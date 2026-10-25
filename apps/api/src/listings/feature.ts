import type { ApiFeature } from '../features.ts';

import { registerListingRoutes } from './routes.ts';

/** An item's marketplace listings and shared-listing links. */
export const feature: ApiFeature = { registerRoutes: registerListingRoutes };
