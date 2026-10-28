import type { ApiFeature } from '../features.ts';

import { registerPackCheckRoutes } from './routes.ts';

/** Pack check: the to-ship list, label reads, scans, packing, and the package photo. */
export const feature: ApiFeature = { registerRoutes: registerPackCheckRoutes };
