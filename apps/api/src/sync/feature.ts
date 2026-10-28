import type { ApiFeature } from '../features.ts';

import { registerSyncRoutes } from './routes.ts';

/** Sync: read-only checks of every linked marketplace now, and what each last found. */
export const feature: ApiFeature = { registerRoutes: registerSyncRoutes };
