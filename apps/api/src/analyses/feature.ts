import type { ApiFeature } from '../features.ts';

import { registerAnalysisRoutes } from './routes.ts';

/** AI analysis of an item's photos. */
export const feature: ApiFeature = { registerRoutes: registerAnalysisRoutes };
