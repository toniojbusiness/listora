import type { ApiFeature } from '../features.ts';

import { registerSourcingRunRoutes } from './routes.ts';

/** Trips to a store, scanning items to buy (docs/features/thrift-scan.md). */
export const feature: ApiFeature = { registerRoutes: registerSourcingRunRoutes };
