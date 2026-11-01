import type { ApiFeature } from '../features.ts';

import { registerStorageLocationRoutes } from './routes.ts';

/** Storage bins: where items are kept, such as B-12 (docs/features/storage-bins.md). */
export const feature: ApiFeature = { registerRoutes: registerStorageLocationRoutes };
