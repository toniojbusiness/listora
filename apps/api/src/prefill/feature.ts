import type { ApiFeature } from '../features.ts';

import { registerPrefillRoutes } from './routes.ts';

/** What each marketplace's sell form will get for an item, and the review's questions. */
export const feature: ApiFeature = { registerRoutes: registerPrefillRoutes };
