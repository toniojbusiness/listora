import type { ApiFeature } from '../features.ts';

import { registerUploadRoutes } from './routes.ts';

/** Upload sessions. */
export const feature: ApiFeature = { registerRoutes: registerUploadRoutes };
