import type { ApiFeature } from '../features.ts';

import { registerAccountRoutes } from './routes.ts';

/** The signed-in person's account (`deleteAccount`). */
export const feature: ApiFeature = { registerRoutes: registerAccountRoutes };
