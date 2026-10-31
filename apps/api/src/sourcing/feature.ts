import type { ApiFeature } from '../features.ts';

import { registerSourcingRoutes } from './routes.ts';

/** The household's own sales for sourcing: the sourcing kit. */
export const feature: ApiFeature = { registerRoutes: registerSourcingRoutes };
