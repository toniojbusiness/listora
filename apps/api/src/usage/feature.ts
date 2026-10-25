import type { ApiFeature } from '../features.ts';

import { registerUsageRoutes } from './routes.ts';

/** The plan's quota use. */
export const feature: ApiFeature = { registerRoutes: registerUsageRoutes };
