import type { ApiFeature } from '../features.ts';

import { registerVoiceRoutes } from './routes.ts';

/** Spoken corrections on the review screen that the app could not parse itself. */
export const feature: ApiFeature = { registerRoutes: registerVoiceRoutes };
