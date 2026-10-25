import type { ApiFeature } from '../features.ts';

import { registerListingActionRoutes } from './actions.ts';
import { registerListingRoutes } from './routes.ts';

/** An item's marketplace listings, the actions on them, and shared-listing links. */
export const feature: ApiFeature = {
  registerRoutes: (app, context) => {
    registerListingRoutes(app, context);
    registerListingActionRoutes(app, context);
  },
};
