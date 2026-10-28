import type { ApiFeature } from '../features.ts';

import { registerItemChangeRoutes } from './changes.ts';
import { registerItemRoutes } from './routes.ts';

/** Inventory items, and the item screen's wait for a change. */
export const feature: ApiFeature = {
  registerRoutes: (app, context) => {
    registerItemRoutes(app, context);
    registerItemChangeRoutes(app, context);
  },
};
