import { loadFeatureGate } from '@listora/marketplaces';
import { buildSourcingKit } from '@listora/sourcing';
import type { FastifyInstance } from 'fastify';

import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { payoutFeesByMarketplace } from './fees.ts';
import { ownSales, ownSalesMarketplaces, unsoldItems } from './repository.ts';

export interface SourcingRouteDependencies extends RouteDependencies {
  now: () => Date;
}

/**
 * `getSourcingKit`: the household's own sales grouped for sourcing, from the sales that count
 * for the account (`ownSalesMarketplaces`). Reads only Listora's own records: it never calls a
 * marketplace or AI.
 */
export function registerSourcingRoutes(
  app: FastifyInstance,
  deps: SourcingRouteDependencies,
): void {
  contractRoute(app, deps, 'getSourcingKit', async ({ tenant, db }) => {
    const now = deps.now();
    const gate = await loadFeatureGate(db, tenant.accountId);
    const [sales, unsold, fees] = await Promise.all([
      ownSales(db, tenant, ownSalesMarketplaces(gate), now),
      unsoldItems(db, tenant),
      payoutFeesByMarketplace(db, tenant, now),
    ]);
    // The payouts for the offline call are worked out as the scan's call works them out.
    return { status: 200, body: buildSourcingKit({ sales, unsold, now, fees }) };
  });
}
