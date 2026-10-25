import type { ApiFeature } from '../features.ts';

import { registerConnectionRoutes } from './routes.ts';

/** Marketplace connections and their OAuth authorizations. */
export const feature: ApiFeature = {
  registerRoutes: (app, context) => {
    registerConnectionRoutes(app, { ...context, ...context.connections });
  },
};
