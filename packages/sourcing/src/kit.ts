/**
 * The sourcing kit (`GET /v1/sourcing/kit`): the household's own sales grouped by brand, then
 * brand and category, then brand, category, and size, so the iPhone can look a tag's brand up at
 * the store with no signal (docs/features/thrift-scan.md). Pure: the API loads the sales that
 * count and the unsold items.
 */
import {
  knownMarketplaceValues,
  type KnownMarketplace,
  type OwnSalesBucket,
  type OwnSalesOnMarketplace,
  type SourcingKit,
} from '@listora/api-contract';
import { estimateFeesCents, feeTableFor, OWN_SALES_MAY_MODEL_PRICES } from '@listora/pricing';

import { brandKey } from './brand.ts';
import { OWN_HISTORY_WINDOW_DAYS, type OwnSale } from './own-history.ts';
import { sizeBucket } from './size.ts';
import { medianCents, quartiles } from './stats.ts';

/** The kit's format (`SourcingKit.version`). Bump it when a client must read it differently. */
export const SOURCING_KIT_VERSION = 1;
/** The most groups a kit holds (`SourcingKit.buckets` `maxItems`). */
export const MAX_KIT_BUCKETS = 2000;
const MAX_BRAND_LENGTH = 120;

/** An item of the account in inventory and not sold. */
export interface UnsoldItem {
  readonly brand: string | null;
  readonly category: string | null;
  readonly sizeLabel: string | null;
}

export interface SourcingKitInput {
  /** The sales that count: standing, from the window, on marketplaces whose history is on. */
  readonly sales: readonly OwnSale[];
  readonly unsold: readonly UnsoldItem[];
  readonly now: Date;
}

type Level = 'brand' | 'category' | 'size';
const LEVEL_RANK: Readonly<Record<Level, number>> = { brand: 0, category: 1, size: 2 };

interface Group {
  readonly key: string;
  readonly level: Level;
  readonly brandKey: string;
  readonly category: string | null;
  readonly sizeBucket: string | null;
  readonly sales: Map<KnownMarketplace, number[]>;
  soldCount: number;
  unsoldCount: number;
}

export function buildSourcingKit(input: SourcingKitInput): SourcingKit {
  const groups = new Map<string, Group>();
  const spellings = new Map<string, Map<string, number>>();

  for (const sale of input.sales) {
    const key = brandKey(sale.brand);
    if (key === undefined || sale.brand === null) continue;
    const spelling = sale.brand.trim().replace(/\s+/g, ' ').slice(0, MAX_BRAND_LENGTH);
    const counts = spellings.get(key) ?? new Map<string, number>();
    counts.set(spelling, (counts.get(spelling) ?? 0) + 1);
    spellings.set(key, counts);
    for (const place of groupsOf(key, sale.category, sizeBucket(sale.sizeLabel))) {
      const group = groups.get(place.key) ?? newGroup(place);
      groups.set(place.key, group);
      const prices = group.sales.get(sale.marketplace) ?? [];
      prices.push(sale.salePriceCents);
      group.sales.set(sale.marketplace, prices);
      group.soldCount += 1;
    }
  }

  // Unsold items count only in groups that sold: the kit is the household's sales.
  for (const item of input.unsold) {
    const key = brandKey(item.brand);
    if (key === undefined) continue;
    for (const place of groupsOf(key, item.category, sizeBucket(item.sizeLabel))) {
      const group = groups.get(place.key);
      if (group) group.unsoldCount += 1;
    }
  }

  const kept = [...groups.values()]
    .sort(
      (a, b) =>
        LEVEL_RANK[a.level] - LEVEL_RANK[b.level] ||
        b.soldCount - a.soldCount ||
        compare(a.key, b.key),
    )
    .slice(0, MAX_KIT_BUCKETS)
    .sort(
      (a, b) =>
        compare(a.brandKey, b.brandKey) ||
        compare(a.category ?? '', b.category ?? '') ||
        compare(a.sizeBucket ?? '', b.sizeBucket ?? ''),
    );

  return {
    version: SOURCING_KIT_VERSION,
    generatedAt: input.now.toISOString(),
    windowDays: OWN_HISTORY_WINDOW_DAYS,
    buckets: kept.map((group) => bucketView(group, spellings.get(group.brandKey), input.now)),
  };
}

interface Place {
  key: string;
  level: Level;
  brandKey: string;
  category: string | null;
  sizeBucket: string | null;
}

/** The groups an item falls in: its brand's, its category's, and its size's in that category. */
function groupsOf(key: string, category: string | null, size: string | null): Place[] {
  const places: Place[] = [
    { key, level: 'brand', brandKey: key, category: null, sizeBucket: null },
  ];
  if (category === null) return places;
  const categoryKey = `${key}\u0000${category}`;
  places.push({ key: categoryKey, level: 'category', brandKey: key, category, sizeBucket: null });
  if (size !== null) {
    places.push({
      key: `${categoryKey}\u0000${size}`,
      level: 'size',
      brandKey: key,
      category,
      sizeBucket: size,
    });
  }
  return places;
}

function newGroup(place: Place): Group {
  return { ...place, sales: new Map(), soldCount: 0, unsoldCount: 0 };
}

function bucketView(
  group: Group,
  spellings: ReadonlyMap<string, number> | undefined,
  now: Date,
): OwnSalesBucket {
  return {
    brand: mostCommon(spellings) ?? group.brandKey,
    brandKey: group.brandKey,
    ...(group.category === null ? {} : { category: group.category }),
    ...(group.sizeBucket === null ? {} : { sizeBucket: group.sizeBucket }),
    unsoldCount: group.unsoldCount,
    marketplaces: knownMarketplaceValues.flatMap((marketplace) => {
      const prices = group.sales.get(marketplace);
      return prices === undefined ? [] : [marketplaceView(marketplace, prices, now)];
    }),
  };
}

function marketplaceView(
  marketplace: KnownMarketplace,
  prices: readonly number[],
  now: Date,
): OwnSalesOnMarketplace {
  const stats = quartiles(prices);
  if (stats === undefined) throw new Error('a group lists only marketplaces it sold on');
  const table = feeTableFor(marketplace, now);
  const payouts = prices.map((price) => Math.max(0, price - estimateFeesCents(table, price)));
  const usd = (amountCents: number) => ({ amountCents, currency: 'USD' as const });
  return {
    marketplace,
    soldCount: stats.count,
    low: usd(stats.lowCents),
    median: usd(stats.medianCents),
    high: usd(stats.highCents),
    medianPayout: usd(medianCents(payouts) ?? 0),
    feeTableVersion: table.version,
    displayOnly: !OWN_SALES_MAY_MODEL_PRICES[marketplace],
  };
}

/** The spelling most sales use; a tie goes to the one that sorts first, so the kit is stable. */
function mostCommon(counts: ReadonlyMap<string, number> | undefined): string | undefined {
  let best: [string, number] | undefined;
  for (const entry of counts ?? []) {
    if (!best || entry[1] > best[1] || (entry[1] === best[1] && compare(entry[0], best[0]) < 0)) {
      best = entry;
    }
  }
  return best?.[0];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
