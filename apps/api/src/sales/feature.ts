import type { ApiFeature } from '../features.ts';

import { registerSaleRoutes } from './routes.ts';

/** The sales feed, with each sale's delist runs and double-sale incidents. */
export const feature: ApiFeature = { registerRoutes: registerSaleRoutes };
