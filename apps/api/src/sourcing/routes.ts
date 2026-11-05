import type { SourcingCost, SourcingCostReplace } from '@listora/api-contract';
import { loadFeatureGate } from '@listora/marketplaces';
import {
  BINS_PRICE_PER_POUND_RANGE,
  buildSourcingKit,
  DEFAULT_SOURCING_COST,
  STORE_ITEM_RANGE,
  type SourcingCostSettings,
} from '@listora/sourcing';
import type { FastifyInstance } from 'fastify';

import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { ApiError, validationFailed } from '../errors.ts';
import { loadSourcingCost, saveSourcingCost } from './cost.ts';
import { payoutFeesByMarketplace } from './fees.ts';
import { ownSales, ownSalesMarketplaces, unsoldItems } from './repository.ts';

export interface SourcingRouteDependencies extends RouteDependencies {
  now: () => Date;
}

/**
 * `getSourcingKit`, and where the household sources (`getSourcingCost`, `replaceSourcingCost`),
 * which the scan's call weighs each item's likely cost by.
 *
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

  contractRoute(app, deps, 'getSourcingCost', async ({ tenant, db }) => ({
    status: 200,
    body: costView(await loadSourcingCost(db, tenant)),
  }));

  contractRoute(app, deps, 'replaceSourcingCost', async ({ tenant, db, body }) => {
    // What the household pays where it sources is the account's: only who runs it may change it.
    if (tenant.role === 'member') {
      throw new ApiError('forbidden', "Only the account's owner can change where it sources.");
    }
    const saved = await saveSourcingCost(db, tenant, costSettings(body));
    return { status: 200, body: costView(saved) };
  });
}

/** The request as a setting, its prices held to their bounds. */
function costSettings(body: SourcingCostReplace): SourcingCostSettings {
  const problems: { field: string; message: string }[] = [];
  const cents = (
    field: 'binsPricePerPound' | 'storeItemPrice',
    range: { readonly minCents: number; readonly maxCents: number },
    message: string,
  ): number | undefined => {
    const money = body[field];
    if (money === undefined) return undefined;
    // The contract holds the currency to USD; the route holds the amount to its bounds.
    if (money.amountCents < range.minCents || money.amountCents > range.maxCents) {
      problems.push({ field, message });
      return undefined;
    }
    return money.amountCents;
  };
  const perPound = cents(
    'binsPricePerPound',
    BINS_PRICE_PER_POUND_RANGE,
    'Enter a price per pound from $0.10 to $20.',
  );
  const storeItem = cents('storeItemPrice', STORE_ITEM_RANGE, 'Enter a price from $0 to $1,000.');
  if (problems.length > 0) throw validationFailed(problems);
  return {
    mode: body.mode,
    binsPricePerPoundCents: perPound ?? DEFAULT_SOURCING_COST.binsPricePerPoundCents,
    ...(storeItem === undefined ? {} : { storeItemCents: storeItem }),
  };
}

function costView(saved: { settings: SourcingCostSettings; isDefault: boolean }): SourcingCost {
  const { settings } = saved;
  return {
    mode: settings.mode,
    binsPricePerPound: { amountCents: settings.binsPricePerPoundCents, currency: 'USD' },
    ...(settings.storeItemCents === undefined
      ? {}
      : { storeItemPrice: { amountCents: settings.storeItemCents, currency: 'USD' } }),
    isDefault: saved.isDefault,
  };
}
