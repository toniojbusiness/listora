import type { KnownMarketplace } from '@listora/api-contract';
import type { DbExecutor } from '@listora/db';
import {
  calibrateFees,
  feeEstimator,
  feeTableFor,
  ORDER_DATA_MAY_ADJUST_FEES,
} from '@listora/pricing';

import { recentObservedSales } from '../pricing/repository.ts';
import type { Tenant } from '../tenancy.ts';

/**
 * The marketplace's fee estimate for one item, as the thrift scan's call works payouts out: its
 * current fee table, scaled by the account's actual fees there when there are enough and the
 * marketplace's order data may adjust fees.
 */
export async function payoutFees(
  db: DbExecutor,
  tenant: Tenant,
  marketplace: KnownMarketplace,
  now: Date,
): Promise<(priceCents: number) => number> {
  return (await payoutFeesByMarketplace(db, tenant, now))(marketplace);
}

/** `payoutFees` for every marketplace, from one read of the account's recent sales. */
export async function payoutFeesByMarketplace(
  db: DbExecutor,
  tenant: Tenant,
  now: Date,
): Promise<(marketplace: KnownMarketplace) => (priceCents: number) => number> {
  const observed = await recentObservedSales(db, tenant, now);
  return (marketplace) =>
    feeEstimator(
      feeTableFor(marketplace, now),
      ORDER_DATA_MAY_ADJUST_FEES[marketplace]
        ? calibrateFees(marketplace, observed.get(marketplace) ?? [])
        : undefined,
    );
}
