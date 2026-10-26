import type { ApiFeature } from '../features.ts';

import { registerPhoneRoutes } from './routes.ts';

/** The seller's devices, and the marketplace work their iPhone runs (phone-execution.md). */
export const feature: ApiFeature = {
  registerRoutes: (app, context) => {
    registerPhoneRoutes(app, { ...context, phone: context.phone });
  },
};
