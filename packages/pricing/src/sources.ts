/**
 * Which data may be called what, and which data may feed a computed price. These rules come
 * from the marketplace terms (docs/features/pricing.md) and are the only place that
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
 * The marketplace whose listing context a source's data is bound to: its snapshots must name
 * that marketplace, so clients show them only on that marketplace's listing. Depop's
 * acceptable use policy allows Pricing Inspiration only in the context of that Depop listing.
 */
export const SOLD_DATA_LISTING_CONTEXT: Readonly<
  Partial<Record<RealSoldDataSource, KnownMarketplace>>
> = {
  depop_inspiration: 'depop',
  ebay_mi: 'ebay',
};

/**
 * Whether a marketplace's order data (its actual fees) may adjust the fee estimate behind a
 * floor. eBay-sourced fee data (including the account's own fees from the eBay Finances API)
 * stays out of eBay floor computation until a legal review of the eBay API License Agreement
 * (red flag RF3) says otherwise: the licence forbids using eBay content "to suggest or model
 * prices for items listed on eBay Site" without eBay's written consent. Until then eBay floors
 * use the published fee table only. When that review clears it, set `ebay` to true; nothing
 * else needs to change.
 */
export const ORDER_DATA_MAY_ADJUST_FEES: Readonly<Record<KnownMarketplace, boolean>> = {
  ebay: false,
  depop: true,
  poshmark: true,
  mercari: true,
};
