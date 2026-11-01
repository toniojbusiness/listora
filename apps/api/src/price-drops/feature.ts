import type { ApiFeature } from '../features.ts';

import { registerPriceDropRoutes } from './routes.ts';

/** Smart price drops: the seller's rules and each live listing's planned drop. */
export const feature: ApiFeature = { registerRoutes: registerPriceDropRoutes };
