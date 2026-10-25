import type { ApiFeature } from '../features.ts';

import { registerPricingRoutes } from './routes.ts';

/** Price suggestions. */
export const feature: ApiFeature = { registerRoutes: registerPricingRoutes };
