import type { ApiFeature } from '../features.ts';

import { registerReportRoutes } from './routes.ts';

/** The Reports screen: the year's report and the CSV exports. */
export const feature: ApiFeature = { registerRoutes: registerReportRoutes };
