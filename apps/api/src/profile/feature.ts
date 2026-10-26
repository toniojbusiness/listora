import type { ApiFeature } from '../features.ts';

import { registerProfileRoutes } from './routes.ts';

/** The signed-in person's profile in Settings (`getProfile`, `replaceProfile`). */
export const feature: ApiFeature = { registerRoutes: registerProfileRoutes };
