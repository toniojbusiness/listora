import type { ApiFeature } from '../features.ts';

import { registerImportRoutes } from './routes.ts';

/** Importing the seller's existing listings from a linked marketplace. */
export const feature: ApiFeature = { registerRoutes: registerImportRoutes };
