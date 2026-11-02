/**
 * The scan's call (docs/features/thrift-scan.md): from the AI's read, the household's own sales
 * like the item and their trend, the retail price (off a tag, or from the web research), what
 * the web says such items resell for, and each marketplace's comparisons (eBay's sold listings
 * among them). Made when the read lands, and again when the web
 * research comes in.
 */
import type { ScanRetail, ScanTrend } from '@listora/api-contract';
import type { ScanResearch, ThriftScan } from '@listora/analysis';
import type { DbExecutor } from '@listora/db';
import { loadFeatureGate } from '@listora/marketplaces';
import { OWN_SALES_MAY_MODEL_PRICES } from '@listora/pricing';
import {
  DEFAULT_SCAN_CALL_SETTINGS,
  priceCalibration,
  salesTrend,
  scanCall,
  scanOwnHistory,
  snapBrand,
  unsoldLikeIt,
  type OwnSale,
  type ScanCallInput,
} from '@listora/sourcing';

import { payoutFees } from '../sourcing/fees.ts';
import { ownSales, ownSalesMarketplaces, unsoldItems } from '../sourcing/repository.ts';
import { marketInputs, type StoredComparison } from './comparisons.ts';
import type { Tenant } from '../tenancy.ts';
import type { ScanCallDetail } from './repository.ts';
import { callDetail } from './views.ts';

const usd = (amountCents: number) => ({ amountCents, currency: 'USD' as const });

export async function assessScan(
  db: DbExecutor,
  tenant: Tenant,
  read: ThriftScan,
  research: ScanResearch | undefined,
  now: Date,
  comparisons: readonly StoredComparison[] = [],
  /** The household's own sales (`scanSales`), when the caller already has them. */
  loadedSales?: readonly OwnSale[],
): Promise<ScanCallDetail> {
  const [sales, unsold] = await Promise.all([
    loadedSales ?? scanSales(db, tenant, now),
    unsoldItems(db, tenant),
  ]);
  const history = scanOwnHistory(read, sales);
  const matched = new Set(history.forCall?.saleIds ?? []);
  const trend =
    history.forCall === undefined
      ? undefined
      : salesTrend(
          sales.filter((sale) => matched.has(sale.id)),
          now,
        );
  const recentOwnSales = trend?.recentSales ?? 0;
  // Each marketplace's comparisons that came in, Depop first.
  const markets = marketInputs(comparisons, recentOwnSales);
  const retail = retailOf(read, research);
  const fees = await payoutFees(db, tenant, history.payoutMarketplace, now);
  const settings = DEFAULT_SCAN_CALL_SETTINGS;
  const input: ScanCallInput = {
    identityConfidence: read.identityConfidence,
    ownHistory: history.forCall,
    aiEstimate: read.aiEstimate ?? undefined,
    flags: read.flags,
    fees,
    // What the household's items sold for against what they asked, from the sales whose prices
    // the call models: the AI estimate and the web's asks are scaled by it.
    calibration: priceCalibration(
      sales.filter((sale) => OWN_SALES_MAY_MODEL_PRICES[sale.marketplace]),
    ),
    namedBrand: read.brand !== null,
    retail:
      retail === undefined
        ? undefined
        : {
            lowCents: retail.low.amountCents,
            highCents: retail.high.amountCents,
            from: retail.source === 'tag' ? 'tag' : 'web',
            site: retail.site,
            models: retail.models,
          },
    web:
      research?.resale === undefined || research.resale === null
        ? undefined
        : {
            lowCents: research.resale.lowCents,
            highCents: research.resale.highCents,
            sites: research.resale.sources.map((source) => source.site),
            reputation: research.reputation,
          },
    newWithTags: read.condition === 'new_with_tags',
    trend,
    style: read.style ?? undefined,
    unsold: unsoldLikeIt(read, unsold),
    markets,
  };
  const rule = scanCall(input, settings);
  return {
    ...callDetail({
      rule,
      history,
      brand: read.brand,
      range: rule.range,
      worthListingCents: settings.worthListingCents,
    }),
    ...(trend === undefined || trend.direction === 'unknown' ? {} : { trend: trendView(trend) }),
    ...(retail === undefined ? {} : { retail }),
    ...(comparisons.length === 0 ? {} : { comparisons: [...comparisons], recentOwnSales }),
    ...(rule.aiEstimate === undefined ? {} : { aiEstimate: rule.aiEstimate }),
  };
}

/** The household's own sales the scan weighs: those of the marketplaces whose sales are real. */
export async function scanSales(db: DbExecutor, tenant: Tenant, now: Date): Promise<OwnSale[]> {
  const gate = await loadFeatureGate(db, tenant.accountId);
  return ownSales(db, tenant, ownSalesMarketplaces(gate), now);
}

/**
 * The read with its brand snapped to the one of the household's sold brands it nearly spells
 * (`snapBrand`: "Wrenfeld" for Wrenfield), so the card, the own sales, the web research, and a
 * kept item all name the brand the household sells. Unchanged when no single brand is that close.
 */
export function snappedRead(
  read: ThriftScan,
  sales: readonly OwnSale[],
): { read: ThriftScan; snappedFrom?: string } {
  const snapped = snapBrand(
    read.brand,
    sales.map((sale) => sale.brand),
  );
  return snapped === undefined
    ? { read }
    : { read: { ...read, brand: snapped.brand }, snappedFrom: snapped.readAs };
}

/** The retail price: printed on this item's own tag first, else what the web research found. */
function retailOf(read: ThriftScan, research: ScanResearch | undefined): ScanRetail | undefined {
  if (read.retailPriceCents !== null) {
    const price = usd(read.retailPriceCents);
    return {
      low: price,
      high: price,
      source: 'tag',
      label: `Retail ${dollars(read.retailPriceCents)} on the tag`,
    };
  }
  const web = research?.retail;
  if (web === undefined || web === null) return undefined;
  const exact = web.lowCents === web.highCents;
  const [first] = web.sources;
  return {
    low: usd(web.lowCents),
    high: usd(web.highCents),
    ...(web.models.length === 0 ? {} : { models: [...web.models] }),
    source: 'web',
    ...(first === undefined ? {} : { site: first.site, url: first.url }),
    label: exact
      ? `Retail about ${dollars(web.highCents)}`
      : `Retail ${dollars(web.lowCents)}-${dollars(web.highCents)}${
          web.models.length > 1 ? ` across ${String(web.models.length)} models` : ''
        }`,
  };
}

function trendView(trend: ReturnType<typeof salesTrend>): ScanTrend {
  return {
    source: trend.source,
    direction: trend.direction,
    recentSales: trend.recentSales,
    earlierSales: trend.earlierSales,
    ...(trend.lastSoldDaysAgo === undefined ? {} : { lastSoldDaysAgo: trend.lastSoldDaysAgo }),
    ...(trend.label === undefined ? {} : { label: trend.label }),
    basedOn: trend.basedOn,
  };
}

function dollars(cents: number): string {
  return `$${String(Math.round(cents / 100))}`;
}
