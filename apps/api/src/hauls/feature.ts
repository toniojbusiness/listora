import type { ApiFeature } from '../features.ts';

import { registerHaulRoutes } from './routes.ts';

/** Hauls: items bought together for one price, each costing its share. */
export const feature: ApiFeature = { registerRoutes: registerHaulRoutes };
