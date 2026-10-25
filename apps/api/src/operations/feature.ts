import type { ApiFeature } from '../features.ts';

import { registerOperationRoutes } from './routes.ts';

/** Marketplace operations, their history, Retry, and Cancel. */
export const feature: ApiFeature = { registerRoutes: registerOperationRoutes };
