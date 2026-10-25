import type { ApiFeature } from '../features.ts';

import { registerItemRoutes } from './routes.ts';

/** Inventory items. */
export const feature: ApiFeature = { registerRoutes: registerItemRoutes };
