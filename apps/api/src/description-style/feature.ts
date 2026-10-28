import type { ApiFeature } from '../features.ts';

import { registerDescriptionStyleRoutes } from './routes.ts';

/** The account's description style in Settings (`getDescriptionStyle`, `replaceDescriptionStyle`). */
export const feature: ApiFeature = { registerRoutes: registerDescriptionStyleRoutes };
