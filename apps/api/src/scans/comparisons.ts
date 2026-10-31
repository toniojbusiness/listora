/**
 * The scan's marketplace comparisons (docs/features/thrift-scan.md, "Marketplace
 * comparisons"). The server never reads a marketplace: for each marketplace whose comparisons
 * are on for the account (`market_comps`), it hands the seller's iPhone a read of the
 * marketplace's public search (which the phone makes logged out, in a web view that holds no
 * account), unless a read of the same search from the last 24 hours answers it, the marketplace
 * showed a check (24 hours) or asked to slow down (an hour), or this hour's or day's reads are
 * used up. The phone answers with counts and quartiles only (`saveScanComparison`).
 *
 * Depop shows a visitor no sold listings, so its numbers are what close matches ask, labeled as
 * asking prices; the household's own sales are the sold side, and the demand is their recent
 * pace against Depop's live supply. eBay shows its sold listings, so its numbers are also what
 * close matches sold for (the call's range when the household's own sales are too few), and its
 * demand is its search's sold pace against its supply.
 */
import type { ScanComparison, ScanComparisonAnswer } from '@listora/api-contract';
import {
  automationProfile,
  COMPARISON_MARKETPLACES,
  COMPARISON_SOLD_WINDOW_DAYS,
  COMPARISON_VERSION,
  comparisonQuery,
  comparisonQueryKey,
  type ComparisonInput,
  type ComparisonMarketplace,
  type ComparisonStats,
} from '@listora/automation';
import type { ThriftScan } from '@listora/analysis';
import { jsonb, type DbExecutor, type JsonObject } from '@listora/db';
import { isFeatureOn, MARKETPLACE_NAMES, type FeatureGate } from '@listora/marketplaces';
import { ASKING_PRICES_LABEL, marketSoldLabel } from '@listora/pricing';
import {
  marketDemand,
  marketSoldPace,
  soldPace,
  type MarketCallInput,
  type MarketDemandRead,
} from '@listora/sourcing';

import type { Tenant } from '../tenancy.ts';

/** How many reads a marketplace's comparisons may make for an account. */
export interface ComparisonLimits {
  readonly perHour: number;
  readonly perDay: number;
  /**
   * Once this many of the hour's reads are used, the rest go only to items the AI puts at
   * `minEstimateCents` or more at the high end (or could not price): where a comparison can
   * change the call most. Absent: every item is read until the hour's limit.
   */
  readonly saveForPricier?: { readonly after: number; readonly minEstimateCents: number };
}

/**
 * Reads each marketplace's comparisons may make for an account, per hour and per day: starting
 * points to tune in the live test, not proven safe limits (the plan's section 3.3). An eBay read
 * loads two results pages (its sold and its for-sale search).
 */
export const COMPARISON_LIMITS: Readonly<Record<ComparisonMarketplace, ComparisonLimits>> = {
  depop: { perHour: 60, perDay: 300 },
  ebay: { perHour: 30, perDay: 150, saveForPricier: { after: 20, minEstimateCents: 2_500 } },
};

/** A read of the same search answers for this long. */
export const COMPARISON_CACHE_MS = 24 * 60 * 60 * 1000;
/** How long a marketplace's comparisons wait after it showed a check. */
export const CHECK_PAUSE_MS = 24 * 60 * 60 * 1000;
/** How long they wait after it asked Listora to slow down. */
export const RATE_LIMIT_PAUSE_MS = 60 * 60 * 1000;
/** Close matches for sale a row needs before it shows their asking prices. */
export const MIN_ASKING_SHOWN = 3;
/** Sold close matches a row needs before it shows what they sold for. */
export const MIN_SOLD_SHOWN = 3;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How long the phone gives one read, and each of its steps. */
const STEP_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 30_000;

/** One marketplace's comparison, as `item_scan.call_detail.comparisons` keeps it. */
export interface StoredComparison {
  readonly marketplace: ComparisonMarketplace;
  readonly status: 'checking' | 'read' | 'not_enough' | 'paused' | 'limit' | 'failed';
  /** The read handed to the phone (or the cached read that answered). */
  readonly comparisonId?: string;
  /** What the phone reads, only while it is `checking`. */
  readonly input?: ComparisonInput;
  readonly stats?: ComparisonStats;
  readonly forSaleTotal?: number | null;
  /** The whole sold search's count, where the marketplace shows sold listings (eBay). */
  readonly soldTotal?: number | null;
  readonly cached?: boolean;
  /** Why there are no numbers. */
  readonly reason?: 'check' | 'rate_limited' | 'hour' | 'day' | 'no_query' | 'no_match';
}

/**
 * What each marketplace's comparison is for a new scan: a cached read, a pause, a used-up
 * budget, or a read for the phone (written as `pending` once the scan is, `startComparisons`).
 */
export async function planComparisons(
  db: DbExecutor,
  tenant: Tenant,
  read: ThriftScan,
  gate: FeatureGate,
  now: Date,
): Promise<StoredComparison[]> {
  const planned: StoredComparison[] = [];
  for (const marketplace of COMPARISON_MARKETPLACES) {
    if (!isFeatureOn(marketplace, 'market_comps', gate)) continue;
    const query = comparisonQuery(marketplace, read);
    if (query === null) {
      planned.push({ marketplace, status: 'not_enough', reason: 'no_query' });
      continue;
    }
    const key = comparisonQueryKey(marketplace, query);
    const recent = await db
      .selectFrom('market_comparison')
      .select([
        'id',
        'status',
        'query_key',
        'stats',
        'for_sale_total',
        'sold_total',
        'created_at',
        'answered_at',
      ])
      .where('account_id', '=', tenant.accountId)
      .where('marketplace', '=', marketplace)
      .where('created_at', '>=', new Date(now.getTime() - DAY_MS))
      .orderBy('created_at', 'desc')
      .execute();
    const pause = recent.find((row) => {
      const at = (row.answered_at ?? row.created_at).getTime();
      return (
        (row.status === 'check' && at > now.getTime() - CHECK_PAUSE_MS) ||
        (row.status === 'rate_limited' && at > now.getTime() - RATE_LIMIT_PAUSE_MS)
      );
    });
    if (pause !== undefined) {
      planned.push({
        marketplace,
        status: 'paused',
        reason: pause.status === 'check' ? 'check' : 'rate_limited',
      });
      continue;
    }
    const cached = recent.find(
      (row) =>
        row.status === 'read' &&
        row.query_key === key &&
        row.created_at.getTime() > now.getTime() - COMPARISON_CACHE_MS,
    );
    if (cached?.stats) {
      planned.push(
        settled(marketplace, cached.id, cached.stats as unknown as ComparisonStats, true, {
          forSaleTotal: cached.for_sale_total,
          soldTotal: cached.sold_total,
        }),
      );
      continue;
    }
    const limits = COMPARISON_LIMITS[marketplace];
    const lastHour = recent.filter((row) => row.created_at.getTime() > now.getTime() - HOUR_MS);
    const saved = limits.saveForPricier;
    const saving =
      saved !== undefined &&
      lastHour.length >= saved.after &&
      read.aiEstimate !== null &&
      read.aiEstimate.highCents < saved.minEstimateCents;
    if (recent.length >= limits.perDay || lastHour.length >= limits.perHour || saving) {
      planned.push({
        marketplace,
        status: 'limit',
        reason: recent.length >= limits.perDay ? 'day' : 'hour',
      });
      continue;
    }
    const profile = automationProfile(marketplace);
    planned.push({
      marketplace,
      status: 'checking',
      input: {
        version: COMPARISON_VERSION,
        marketplace,
        query,
        pacing: profile.readOnlyPacing,
        stepTimeoutMs: STEP_TIMEOUT_MS,
        callTimeoutMs: CALL_TIMEOUT_MS,
        now: now.toISOString(),
      },
    });
  }
  return planned;
}

/** Writes the planned reads for the phone, now that their scan exists; the plan with their ids. */
export async function startComparisons(
  db: DbExecutor,
  tenant: Tenant,
  scanId: string,
  planned: readonly StoredComparison[],
): Promise<StoredComparison[]> {
  const started: StoredComparison[] = [];
  for (const comparison of planned) {
    if (comparison.status !== 'checking' || comparison.input === undefined) {
      started.push(comparison);
      continue;
    }
    const { query } = comparison.input;
    const row = await db
      .insertInto('market_comparison')
      .values({
        account_id: tenant.accountId,
        scan_id: scanId,
        marketplace: comparison.marketplace,
        query_key: comparisonQueryKey(comparison.marketplace, query),
        query: jsonb(query as unknown as JsonObject),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    started.push({ ...comparison, comparisonId: row.id });
  }
  return started;
}

/** A comparison with numbers: a read the phone answered, or a cached one. */
function settled(
  marketplace: ComparisonMarketplace,
  comparisonId: string,
  stats: ComparisonStats,
  cached: boolean,
  totals: { readonly forSaleTotal: number | null; readonly soldTotal: number | null },
): StoredComparison {
  const enough =
    (stats.forSale?.count ?? 0) >= MIN_ASKING_SHOWN || (stats.sold?.count ?? 0) >= MIN_SOLD_SHOWN;
  const showsSold = COMPARISON_SOLD_WINDOW_DAYS[marketplace] !== undefined;
  return {
    marketplace,
    comparisonId,
    stats,
    forSaleTotal: totals.forSaleTotal,
    ...(showsSold ? { soldTotal: totals.soldTotal } : {}),
    cached,
    status: enough ? 'read' : 'not_enough',
    ...(enough ? {} : { reason: 'no_match' as const }),
  };
}

/**
 * Records the phone's answer to a read and returns the scan's comparisons with it; `null` when
 * the read is not one of this scan's, and the comparisons unchanged when it was answered before.
 */
export async function answerComparison(
  db: DbExecutor,
  tenant: Tenant,
  scanId: string,
  comparisons: readonly StoredComparison[],
  comparisonId: string,
  answer: ScanComparisonAnswer,
  now: Date,
): Promise<{ comparisons: StoredComparison[]; changed: boolean } | null> {
  const row = await db
    .selectFrom('market_comparison')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', comparisonId)
    .where('scan_id', '=', scanId)
    .forUpdate()
    .executeTakeFirst();
  const index = comparisons.findIndex((one) => one.comparisonId === comparisonId);
  if (row === undefined || index === -1) return null;
  if (row.status !== 'pending') return { comparisons: [...comparisons], changed: false };
  const stats = answer.outcome === 'read' ? answer.stats : undefined;
  const outcome = answer.outcome === 'read' && stats === undefined ? 'failed' : answer.outcome;
  await db
    .updateTable('market_comparison')
    .set({
      status: outcome,
      stats: stats === undefined ? null : jsonb(stats as unknown as JsonObject),
      for_sale_total: answer.forSaleTotal ?? null,
      sold_total: answer.soldTotal ?? null,
      read_ms: answer.ms,
      answered_at: now,
    })
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', comparisonId)
    .execute();
  const marketplace = row.marketplace as ComparisonMarketplace;
  const next: StoredComparison =
    stats !== undefined
      ? settled(marketplace, comparisonId, stats as ComparisonStats, false, {
          forSaleTotal: answer.forSaleTotal ?? null,
          soldTotal: answer.soldTotal ?? null,
        })
      : outcome === 'check' || outcome === 'rate_limited'
        ? { marketplace, comparisonId, status: 'paused', reason: outcome }
        : { marketplace, comparisonId, status: 'failed' };
  const updated = [...comparisons];
  updated[index] = next;
  return { comparisons: updated, changed: true };
}

/**
 * What the contract can't say of an answer: quartiles in order, and no more listings counted
 * than the searches returned. A broken answer is refused, never shown.
 */
export function comparisonAnswerErrors(
  answer: ScanComparisonAnswer,
): { field: string; message: string }[] {
  const stats = answer.stats;
  if (stats === undefined) return [];
  const errors: { field: string; message: string }[] = [];
  for (const [field, prices, read] of [
    ['stats.forSale', stats.forSale, stats.read.forSale],
    ['stats.sold', stats.sold, stats.read.sold],
  ] as const) {
    if (prices === undefined) continue;
    if (!(prices.lowCents <= prices.medianCents && prices.medianCents <= prices.highCents)) {
      errors.push({ field, message: 'must have lowCents <= medianCents <= highCents' });
    }
    if (prices.count > read) {
      errors.push({ field, message: 'counts more listings than the search returned' });
    }
  }
  return errors;
}

const usd = (amountCents: number) => ({ amountCents, currency: 'USD' as const });

function dollars(cents: number): string {
  return `$${String(Math.round(cents / 100))}`;
}

/**
 * What the call weighs of each marketplace's comparisons, Depop first: close matches' asking
 * prices, what they sold for where the marketplace shows it (eBay), and the demand.
 */
export function marketInputs(
  comparisons: readonly StoredComparison[],
  recentOwnSales: number,
): MarketCallInput[] {
  return comparisons.flatMap((comparison) => {
    const stats = comparison.stats;
    if (stats === undefined) return [];
    const name = MARKETPLACE_NAMES[comparison.marketplace];
    const { forSale, sold } = stats;
    const demand = demandOf(comparison, recentOwnSales);
    return [
      {
        marketplace: name,
        ...(forSale === undefined
          ? {}
          : {
              asking: {
                count: forSale.count,
                lowCents: forSale.lowCents,
                highCents: forSale.highCents,
              },
            }),
        ...(sold === undefined || stats.level === undefined
          ? {}
          : {
              sold: {
                count: sold.count,
                lowCents: sold.lowCents,
                highCents: sold.highCents,
                windowDays: sold.windowDays,
                level: stats.level,
              },
            }),
        demand: {
          ...demand,
          fromSoldPace: COMPARISON_SOLD_WINDOW_DAYS[comparison.marketplace] !== undefined,
        },
      },
    ];
  });
}

/**
 * The trend read: a marketplace's own sold pace against its supply where it shows sold listings
 * (eBay), else the household's recent sales like it against the marketplace's supply.
 */
function demandOf(comparison: StoredComparison, recentOwnSales: number): MarketDemandRead {
  const name = MARKETPLACE_NAMES[comparison.marketplace];
  const window = COMPARISON_SOLD_WINDOW_DAYS[comparison.marketplace];
  return window === undefined
    ? marketDemand(recentOwnSales, comparison.forSaleTotal ?? null, name)
    : marketSoldPace(comparison.soldTotal ?? null, comparison.forSaleTotal ?? null, window, name);
}

/** The comparison as the card shows it. */
export function comparisonView(
  comparison: StoredComparison,
  recentOwnSales: number,
): ScanComparison {
  const name = MARKETPLACE_NAMES[comparison.marketplace];
  const base = { marketplace: comparison.marketplace, status: comparison.status } as const;
  switch (comparison.status) {
    case 'checking':
      return {
        ...base,
        label: `Checking ${name}...`,
        ...(comparison.comparisonId === undefined || comparison.input === undefined
          ? {}
          : {
              read: {
                id: comparison.comparisonId,
                input: comparison.input as unknown as Record<string, unknown>,
              },
            }),
      };
    case 'paused':
      return {
        ...base,
        label:
          comparison.reason === 'rate_limited'
            ? `${name} prices paused for an hour`
            : `${name} prices paused today`,
      };
    case 'limit':
      return {
        ...base,
        label:
          comparison.reason === 'day'
            ? `Not checked: ${name} limit for today`
            : `Not checked: ${name} limit for this hour`,
      };
    case 'failed':
      return { ...base, label: `Couldn't check ${name}` };
    case 'not_enough':
    case 'read':
      return readView(comparison, recentOwnSales, name);
  }
}

function readView(
  comparison: StoredComparison,
  recentOwnSales: number,
  name: string,
): ScanComparison {
  const stats = comparison.stats;
  const forSale =
    stats?.forSale !== undefined && stats.forSale.count >= MIN_ASKING_SHOWN
      ? stats.forSale
      : undefined;
  const sold =
    stats?.sold !== undefined && stats.sold.count >= MIN_SOLD_SHOWN ? stats.sold : undefined;
  const supply = comparison.forSaleTotal ?? undefined;
  const extras = {
    ...(supply === undefined ? {} : { supply }),
    ...(comparison.cached === undefined ? {} : { cached: comparison.cached }),
  };
  const label =
    sold !== undefined
      ? `${name}: sold ${dollars(sold.lowCents)}-${dollars(sold.highCents)}, ${soldPace(sold.count, sold.windowDays)}`
      : forSale !== undefined
        ? `${name}: asking ${dollars(forSale.lowCents)}-${dollars(forSale.highCents)}, ${String(forSale.count)} like it for sale`
        : undefined;
  if (comparison.status === 'not_enough' || label === undefined) {
    return {
      marketplace: comparison.marketplace,
      status: 'not_enough',
      label:
        comparison.reason === 'no_query'
          ? `Not enough to search ${name} for`
          : `Not enough similar listings on ${name}`,
      ...extras,
    };
  }
  const demand = demandOf(comparison, recentOwnSales);
  return {
    marketplace: comparison.marketplace,
    status: 'read',
    label,
    ...(forSale === undefined
      ? {}
      : {
          asking: {
            count: forSale.count,
            low: usd(forSale.lowCents),
            median: usd(forSale.medianCents),
            high: usd(forSale.highCents),
            label: ASKING_PRICES_LABEL,
          },
        }),
    ...(sold === undefined
      ? {}
      : {
          sold: {
            count: sold.count,
            low: usd(sold.lowCents),
            median: usd(sold.medianCents),
            high: usd(sold.highCents),
            ...(sold.windowDays === null ? {} : { windowDays: sold.windowDays }),
            label: marketSoldLabel(name),
          },
        }),
    ...extras,
    demand: {
      demand: demand.demand,
      ...(demand.label === undefined ? {} : { label: demand.label }),
      basedOn: demand.basedOn,
    },
  };
}
