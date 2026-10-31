/**
 * The item price screen's "Your sales": the household's own sales of similar items, per
 * marketplace, as `own_history` sold data (docs/features/thrift-scan.md). Computed from the
 * sales on every pricing read and never stored, so it is always current. Shown, never used to
 * set a tier (docs/features/pricing.md).
 */
import type { DbExecutor, InventoryItem } from '@listora/db';
import { MARKETPLACE_NAMES, type FeatureGate } from '@listora/marketplaces';
import type { SoldDataSnapshot } from '@listora/pricing';
import { OWN_HISTORY_WINDOW_DAYS, ownHistoryFor } from '@listora/sourcing';

import type { Tenant } from '../tenancy.ts';
import { ownSales, ownSalesMarketplaces } from './repository.ts';

/** The brand as the label names it; longer ones are cut so the label stays short. */
const LABEL_BRAND_LENGTH = 40;

export async function ownHistorySoldData(
  db: DbExecutor,
  tenant: Tenant,
  item: InventoryItem,
  gate: FeatureGate,
  now: Date,
): Promise<SoldDataSnapshot[]> {
  const brand = (item.brand ?? '').trim().replace(/\s+/g, ' ');
  if (brand === '') return [];
  const sales = await ownSales(db, tenant, ownSalesMarketplaces(gate), now);
  const history = ownHistoryFor({ itemId: item.id, brand, category: item.category }, sales);
  const usd = (amountCents: number) => ({ amountCents, currency: 'USD' as const });
  return history.map(({ marketplace, stats }) => ({
    source: 'own_history',
    payload: {
      label: ownHistoryLabel(brand, MARKETPLACE_NAMES[marketplace]),
      sampleSize: stats.count,
      low: usd(stats.lowCents),
      median: usd(stats.medianCents),
      high: usd(stats.highCents),
    },
    fetchedAt: now,
  }));
}

/** "Your sales of similar Lululemon items on Depop (last 365 days)". */
export function ownHistoryLabel(brand: string, marketplaceName: string): string {
  const name = brand.slice(0, LABEL_BRAND_LENGTH).trim();
  return `Your sales of similar ${name} items on ${marketplaceName} (last ${String(OWN_HISTORY_WINDOW_DAYS)} days)`;
}
