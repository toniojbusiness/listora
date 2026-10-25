import type { ApiFeature } from '../features.ts';

import { registerProfitRoutes } from './routes.ts';

/** The profit dashboard. */
export const feature: ApiFeature = { registerRoutes: registerProfitRoutes };
