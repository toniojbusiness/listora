/**
 * Which data may be called what, and which data may feed a computed price. These rules come
 * from the marketplace terms (docs/architecture.md section 5) and are the only place that
 * decides them.
 */
import type { KnownMarketplace, KnownSoldDataSource } from '@listora/api-contract';

/** Sources of real sold data: the only data the words "sold" and "comps" may describe. */
export const REAL_SOLD_DATA_SOURCES = [
  'depop_inspiration',
  'ebay_mi',
  'own_history',
] as const satisfies readonly KnownSoldDataSource[];
export type RealSoldDataSource = (typeof REAL_SOLD_DATA_SOURCES)[number];

/** Every `pricing_snapshot.source`: the real sold data sources plus the AI estimate. */
export const PRICING_SNAPSHOT_SOURCES = [...REAL_SOLD_DATA_SOURCES, 'ai_estimate'] as const;
export type PricingSnapshotSource = (typeof PRICING_SNAPSHOT_SOURCES)[number];

export function isRealSoldDataSource(source: string): source is RealSoldDataSource {
  return (REAL_SOLD_DATA_SOURCES as readonly string[]).includes(source);
}

/**
 * Whether a marketplace's order data (its actual fees) may adjust the fee estimate behind a
 * floor. The eBay API License Agreement forbids using eBay content "to suggest or model prices
 * for items listed on eBay Site" without eBay's written consent, so eBay order data never
 * feeds a computed price; eBay floors use the published fee table only. Flip this only with
 * that written consent in hand.
 */
export const ORDER_DATA_MAY_ADJUST_FEES: Readonly<Record<KnownMarketplace, boolean>> = {
  ebay: false,
  depop: true,
  poshmark: true,
  mercari: true,
};
