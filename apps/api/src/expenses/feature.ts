import type { ApiFeature } from '../features.ts';

import { registerExpenseRoutes } from './routes.ts';

/** Expenses for taxes: miles driven, money spent, and the year's mileage rate. */
export const feature: ApiFeature = { registerRoutes: registerExpenseRoutes };
