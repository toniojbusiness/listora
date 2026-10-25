import type { ApiFeature } from '../features.ts';

import { registerTodayRoutes } from './routes.ts';

/** The Today screen and its morning summary setting. */
export const feature: ApiFeature = { registerRoutes: registerTodayRoutes };
