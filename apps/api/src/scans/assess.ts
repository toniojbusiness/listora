/**
 * The scan's call (docs/features/thrift-scan.md): from the AI's read, the household's own sales
 * like the item and their trend, the retail price (off a tag, or from the web research), and
 * what the web says such items resell for. Made when the read lands, and again when the web
 * research comes in.
 */
import type { ScanRetail, ScanTrend } from '@listora/api-contract';
import type { ScanResearch, ThriftScan } from '@listora/analysis';
import type { DbExecutor } from '@listora/db';
import { loadFeatureGate } from '@listora/marketplaces';
import {
  calibrateFees,
  feeEstimator,
  feeTableFor,
  ORDER_DATA_MAY_ADJUST_FEES,
} from '@listora/pricing';
import {
  DEFAULT_SCAN_CALL_SETTINGS,
  salesTrend,
  scanCall,
  scanOwnHistory,
  type ScanCallInput,
} from '@listora/sourcing';

import { recentObservedSales } from '../pricing/repository.ts';
import { ownSales, ownSalesMarketplaces } from '../sourcing/repository.ts';
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
): Promise<ScanCallDetail> {
  const gate = await loadFeatureGate(db, tenant.accountId);
  const sales = await ownSales(db, tenant, ownSalesMarketplaces(gate), now);
  const history = scanOwnHistory(read, sales);
  const matched = new Set(history.forCall?.saleIds ?? []);
  const trend =
    history.forCall === undefined
      ? undefined
      : salesTrend(
          sales.filter((sale) => matched.has(sale.id)),
          now,
        );
  const retail = retailOf(read, research);
  const fees = await payoutFees(db, tenant, history.payoutMarketplace, now);
  const settings = DEFAULT_SCAN_CALL_SETTINGS;
  const input: ScanCallInput = {
    identityConfidence: read.identityConfidence,
    ownHistory: history.forCall,
    aiEstimate: read.aiEstimate ?? undefined,
    flags: read.flags,
    fees,
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
  };
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

/**
 * The marketplace's fee estimate for one item: its current fee table, scaled by the account's
 * actual fees there when there are enough and the marketplace's order data may adjust fees.
 */
async function payoutFees(
  db: DbExecutor,
  tenant: Tenant,
  marketplace: Parameters<typeof feeTableFor>[0],
  now: Date,
): Promise<(priceCents: number) => number> {
  const calibration = ORDER_DATA_MAY_ADJUST_FEES[marketplace]
    ? calibrateFees(
        marketplace,
        (await recentObservedSales(db, tenant, now)).get(marketplace) ?? [],
      )
    : undefined;
  return feeEstimator(feeTableFor(marketplace, now), calibration);
}
