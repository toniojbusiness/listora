import type { ApiFeature } from '../features.ts';

import { registerScanRoutes } from './routes.ts';

/** Items scanned at the store, and the ones the seller keeps (docs/features/thrift-scan.md). */
export const feature: ApiFeature = { registerRoutes: registerScanRoutes };
