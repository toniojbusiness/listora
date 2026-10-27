import type { ApiFeature } from '../features.ts';

import { registerActivityRoutes } from './routes.ts';

/** The activity timeline of items and marketplace actions, and how each sale was found. */
export const feature: ApiFeature = { registerRoutes: registerActivityRoutes };
