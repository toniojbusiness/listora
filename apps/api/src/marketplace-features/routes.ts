import { MARKETPLACES } from '@listora/db';
import { verifiedFeatures } from '@listora/marketplaces';
import type { FastifyInstance } from 'fastify';

import { contractRoute, type RouteDependencies } from '../contract/routes.ts';

/**
 * Each marketplace's features that passed a live end-to-end test
 * (docs/features/verified-features.md): the app shows only these, and the server runs only
 * their checks. The same for every account.
 */
export function registerMarketplaceFeatureRoutes(
  app: FastifyInstance,
  deps: RouteDependencies,
): void {
  contractRoute(app, deps, 'listMarketplaceFeatures', () =>
    Promise.resolve({
      status: 200,
      body: {
        data: MARKETPLACES.map((marketplace) => ({
          marketplace,
          features: verifiedFeatures(marketplace),
        })),
      },
    }),
  );
}
