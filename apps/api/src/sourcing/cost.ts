/**
 * Where the household sources (docs/features/thrift-scan.md, "What it costs"): the account's
 * own setting, else Listora's default (the bins at $1.99 a pound). Filters on the tenant's
 * account.
 */
import type { DbExecutor } from '@listora/db';
import { DEFAULT_SOURCING_COST, type SourcingCostSettings } from '@listora/sourcing';

import type { Tenant } from '../tenancy.ts';

/** The account's setting, or the default when it never saved one (`isDefault`). */
export async function loadSourcingCost(
  db: DbExecutor,
  tenant: Tenant,
): Promise<{ settings: SourcingCostSettings; isDefault: boolean }> {
  const row = await db
    .selectFrom('sourcing_cost')
    .select(['mode', 'bins_price_per_pound_cents', 'store_item_cents'])
    .where('account_id', '=', tenant.accountId)
    .executeTakeFirst();
  if (row === undefined) return { settings: DEFAULT_SOURCING_COST, isDefault: true };
  return {
    settings: {
      mode: row.mode,
      binsPricePerPoundCents: row.bins_price_per_pound_cents,
      ...(row.store_item_cents === null ? {} : { storeItemCents: row.store_item_cents }),
    },
    isDefault: false,
  };
}

/** Saves the setting; the default unchanged removes the account's row, so it gets updates. */
export async function saveSourcingCost(
  db: DbExecutor,
  tenant: Tenant,
  settings: SourcingCostSettings,
): Promise<{ settings: SourcingCostSettings; isDefault: boolean }> {
  if (isDefaultSetting(settings)) {
    await db.deleteFrom('sourcing_cost').where('account_id', '=', tenant.accountId).execute();
    return { settings: DEFAULT_SOURCING_COST, isDefault: true };
  }
  const values = {
    mode: settings.mode,
    bins_price_per_pound_cents: settings.binsPricePerPoundCents,
    store_item_cents: settings.storeItemCents ?? null,
  };
  await db
    .insertInto('sourcing_cost')
    .values({ account_id: tenant.accountId, ...values })
    .onConflict((conflict) => conflict.column('account_id').doUpdateSet(values))
    .execute();
  return { settings, isDefault: false };
}

function isDefaultSetting(settings: SourcingCostSettings): boolean {
  return (
    settings.mode === DEFAULT_SOURCING_COST.mode &&
    settings.binsPricePerPoundCents === DEFAULT_SOURCING_COST.binsPricePerPoundCents &&
    settings.storeItemCents === undefined
  );
}
