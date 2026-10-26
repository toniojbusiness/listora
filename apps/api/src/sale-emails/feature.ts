import type { ApiFeature } from '../features.ts';

import { registerSaleEmailRoutes } from './routes.ts';

/** Email sale detection: the forwarding address, its status and setting, the dev email drop. */
export const feature: ApiFeature = { registerRoutes: registerSaleEmailRoutes };
