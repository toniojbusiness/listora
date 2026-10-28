import type { ApiFeature } from '../features.ts';

import { registerOfferRoutes } from './routes.ts';

/** Offers: when each marketplace's offers were read, an offer, its quote, and the seller's answer. */
export const feature: ApiFeature = { registerRoutes: registerOfferRoutes };
