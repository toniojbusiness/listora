import type { ApiFeature } from '../features.ts';

import { registerBatchRoutes } from './routes.ts';

/** Batch listing: batches of items photographed in one session. */
export const feature: ApiFeature = { registerRoutes: registerBatchRoutes };
