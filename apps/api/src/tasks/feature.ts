import type { ApiFeature } from '../features.ts';

import { registerTaskRoutes } from './routes.ts';

/** The task inbox: assisted steps the user does in a marketplace's app, and their confirmation. */
export const feature: ApiFeature = { registerRoutes: registerTaskRoutes };
