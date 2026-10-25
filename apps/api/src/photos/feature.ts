import type { ApiFeature } from '../features.ts';

import { registerPhotoRoutes } from './routes.ts';

/** An item's photos. */
export const feature: ApiFeature = { registerRoutes: registerPhotoRoutes };
