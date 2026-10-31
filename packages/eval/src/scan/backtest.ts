import {
  feeEstimator,
  feeTableFor,
  estimateFeesCents,
  type FeeCalibration,
} from '@listora/pricing';
import {
  DEFAULT_SCAN_CALL_SETTINGS,
  MATCH_LEVELS,
  brandKey,
  medianCents,
  ownHistoryComparisons,
  scanCall,
  type CallBasis,
  type CallConfidence,
  type HistorySale,
  type MatchLevel,
  type OwnHistoryComparisons,
  type ScanCall,
  type ScanCallKind,
  type ScanCallSettings,
  type ScanIdentity,
} from '@listora/sourcing';
import type { ThriftScan } from '@listora/analysis';

import type { ScanDataset, ScanDatasetItem } from './dataset.ts';
import type { ScanRead, ScanReader } from './readers.ts';

/**
 * Where a call variant's identity comes from: `ai`, the scan's own read (the real call at the
 * store); `labels`, the set's labels with full confidence and no AI estimate (the best an
 * own-history-only call could do, offline too).
 */
export const IDENTITY_SOURCES = ['ai', 'labels'] as const;
export type IdentitySource = (typeof IDENTITY_SOURCES)[number];

/** The worth-listing amounts the sweep tries, $5 to $20. */
export const DEFAULT_WORTH_SWEEP_CENTS = [500, 800, 1_000, 1_200, 1_500, 2_000];

export interface ScanBacktestOptions {
  /** The AI read; without one only the `labels` variant runs. */
  readonly reader?: ScanReader;
  readonly settings?: ScanCallSettings;
  readonly worthSweepCents?: readonly number[];
}

export interface ItemResult {
  readonly id: string;
  readonly salePriceCents: number;
  /** What the seller got: the sale price less the actual fees, or the estimated ones. */
  readonly payoutCents: number;
  readonly read: ScanRead | undefined;
  readonly calls: Partial<Record<IdentitySource, VariantResult>>;
}

export interface VariantResult {
  readonly identity: ScanIdentity;
  readonly ownHistory: OwnHistoryComparisons | undefined;
  readonly call: ScanCall;
}

export interface ReadScores {
  readonly scanned: number;
  readonly failed: number;
  /** Of items with a labeled brand: the AI named one, and it was the same brand. */
  readonly brand: { readonly labeled: number; readonly named: number; readonly agreed: number };
  /** Of items with a labeled category: the AI's path, and its top category, agreed. */
  readonly category: {
    readonly labeled: number;
    readonly named: number;
    readonly agreed: number;
    readonly sameTop: number;
  };
  readonly estimate: EstimateScores;
  readonly costMicrosTotal: number;
  readonly costMicrosPerScan: number;
  readonly latencyP50Ms: number | null;
  readonly latencyP95Ms: number | null;
}

/** How a range compares with what the items really sold for. */
export interface EstimateScores {
  /** Items that got a range. */
  readonly priced: number;
  /** Of those, how many sale prices fell inside it (low to high, inclusive). */
  readonly saleInRange: number;
  /** The median of |estimate - sale| / sale, and of the signed error (its bias). */
  readonly medianAbsError: number | null;
  readonly medianError: number | null;
}

export interface OwnHistoryScores {
  readonly identity: IdentitySource;
  /** Items whose match had at least the minimum comparisons, by level, and the rest. */
  readonly byLevel: Readonly<Record<MatchLevel, number>>;
  readonly thin: number;
  readonly none: number;
  /** Of the items with enough comparisons, scored on their quartiles and median. */
  readonly estimate: EstimateScores;
}

export interface CallScores {
  readonly identity: IdentitySource;
  readonly worthListingCents: number;
  readonly counts: Readonly<Record<ScanCallKind, number>>;
  readonly byConfidence: Readonly<Record<CallConfidence, number>>;
  readonly byBasis: Readonly<Record<CallBasis, number>>;
  /** Buys that really paid out the worth-listing amount, and Skips that really paid less. */
  readonly buyHeld: number;
  readonly skipHeld: number;
}

export interface ScanBacktestReport {
  readonly dataset: {
    readonly description: string;
    readonly items: number;
    readonly medianSalePriceCents: number;
    readonly medianPayoutCents: number;
    /** Items with actual fees, and their total against the fee table's estimate. */
    readonly feeCalibration: FeeCalibration | null;
    /** Items whose payout is at least each worth amount: the share a perfect call buys. */
    readonly worthShare: readonly { worthListingCents: number; items: number }[];
  };
  readonly reader: { readonly id: string; readonly description: string } | null;
  readonly settings: ScanCallSettings;
  readonly read: ReadScores | null;
  readonly ownHistory: readonly OwnHistoryScores[];
  readonly calls: readonly CallScores[];
  readonly sweep: readonly CallScores[];
  readonly items: readonly ItemResult[];
}

/**
 * Backtests the thrift-scan call on sold items (plan M0, docs/features/thrift-scan.md): reads
 * each item as the scan would, compares it with the seller's other sales (leave-one-out), makes
 * the call, and scores the read, the ranges, and the call against what each item really sold
 * for. Every item sold, so the set says how well the call judges value, never whether an
 * item would have sold at all.
 */
export async function runScanBacktest(
  dataset: ScanDataset,
  options: ScanBacktestOptions = {},
): Promise<ScanBacktestReport> {
  const settings = options.settings ?? DEFAULT_SCAN_CALL_SETTINGS;
  const items = dataset.manifest.items;
  const table = feeTableFor('depop', new Date());
  const feeCalibration = calibration(items, table);
  const fees = feeEstimator(table, feeCalibration ?? undefined);
  const payoutOf = (item: ScanDatasetItem) =>
    item.salePriceCents - (item.feesCents ?? fees(item.salePriceCents));
  const history: HistorySale[] = items.map((item) => ({
    id: item.id,
    brand: item.brand,
    category: item.category,
    salePriceCents: item.salePriceCents,
  }));

  const sources: readonly IdentitySource[] =
    options.reader === undefined ? ['labels'] : IDENTITY_SOURCES;
  const results: ItemResult[] = [];
  for (const item of items) {
    const read =
      options.reader === undefined ? undefined : await options.reader.read(dataset, item);
    const others = history.filter((sale) => sale.id !== item.id);
    const calls: Partial<Record<IdentitySource, VariantResult>> = {};
    for (const source of sources) {
      calls[source] = variant(source, item, read, others, settings, fees);
    }
    results.push({
      id: item.id,
      salePriceCents: item.salePriceCents,
      payoutCents: payoutOf(item),
      read,
      calls,
    });
  }

  const sweepAmounts = options.worthSweepCents ?? DEFAULT_WORTH_SWEEP_CENTS;
  return {
    dataset: {
      description: dataset.manifest.description,
      items: items.length,
      medianSalePriceCents: medianCents(items.map((item) => item.salePriceCents)) ?? 0,
      medianPayoutCents: medianCents(results.map((result) => result.payoutCents)) ?? 0,
      feeCalibration: feeCalibration ?? null,
      worthShare: sweepAmounts.map((worthListingCents) => ({
        worthListingCents,
        items: results.filter((result) => result.payoutCents >= worthListingCents).length,
      })),
    },
    reader:
      options.reader === undefined
        ? null
        : { id: options.reader.id, description: options.reader.description },
    settings,
    read: options.reader === undefined ? null : readScores(items, results),
    ownHistory: sources.map((source) => ownHistoryScores(source, results, settings)),
    calls: sources.map((source) => callScores(source, results, settings.worthListingCents)),
    sweep: sources.flatMap((source) =>
      sweepAmounts.map((worthListingCents) => {
        const swept = { ...settings, worthListingCents };
        const recalled = results.map((result) => {
          const current = result.calls[source];
          if (current === undefined) return result;
          const input = callInput(source, result.read, current.ownHistory, fees, current.identity);
          return { ...result, calls: { [source]: { ...current, call: scanCall(input, swept) } } };
        });
        return callScores(source, recalled, worthListingCents);
      }),
    ),
    items: results,
  };
}

function variant(
  source: IdentitySource,
  item: ScanDatasetItem,
  read: ScanRead | undefined,
  others: readonly HistorySale[],
  settings: ScanCallSettings,
  fees: (priceCents: number) => number,
): VariantResult {
  const scan = read?.ok === true ? read.scan : undefined;
  const identity: ScanIdentity =
    source === 'labels'
      ? { brand: item.brand, category: item.category }
      : { brand: scan?.brand ?? null, category: scan?.category ?? null };
  const ownHistory = ownHistoryComparisons(identity, others, {
    minComparisons: settings.minComparisons,
  });
  return {
    identity,
    ownHistory,
    call: scanCall(callInput(source, read, ownHistory, fees, identity), settings),
  };
}

function callInput(
  source: IdentitySource,
  read: ScanRead | undefined,
  ownHistory: OwnHistoryComparisons | undefined,
  fees: (priceCents: number) => number,
  identity: ScanIdentity,
) {
  const scan: ThriftScan | undefined = read?.ok === true ? read.scan : undefined;
  if (source === 'labels') {
    const known = identity.brand !== null || identity.category !== null;
    return { identityConfidence: known ? 1 : 0, ownHistory, flags: NO_FLAGS, fees };
  }
  return {
    identityConfidence: scan?.identityConfidence ?? 0,
    ownHistory,
    aiEstimate: scan?.aiEstimate ?? undefined,
    flags: scan?.flags ?? NO_FLAGS,
    fees,
  };
}

const NO_FLAGS = { visibleDamage: false, lotOrBundle: false, counterfeitProne: false };

/** The set's actual fees against the table's estimate, when at least three items have them. */
function calibration(
  items: readonly ScanDatasetItem[],
  table: ReturnType<typeof feeTableFor>,
): FeeCalibration | undefined {
  const withFees = items.filter((item) => item.feesCents !== null && item.feesCents > 0);
  if (withFees.length < 3) return undefined;
  return {
    sales: withFees.length,
    actualFeesCents: withFees.reduce((sum, item) => sum + (item.feesCents ?? 0), 0),
    estimatedFeesCents: withFees.reduce(
      (sum, item) => sum + estimateFeesCents(table, item.salePriceCents),
      0,
    ),
  };
}

function readScores(items: readonly ScanDatasetItem[], results: readonly ItemResult[]): ReadScores {
  const byId = new Map(items.map((item) => [item.id, item]));
  let failed = 0;
  let costMicrosTotal = 0;
  const latencies: number[] = [];
  const brand = { labeled: 0, named: 0, agreed: 0 };
  const category = { labeled: 0, named: 0, agreed: 0, sameTop: 0 };
  const ranges: {
    range: { lowCents: number; midCents: number; highCents: number };
    saleCents: number;
  }[] = [];
  for (const result of results) {
    const read = result.read;
    if (read === undefined) continue;
    costMicrosTotal += read.costMicros;
    latencies.push(read.latencyMs);
    if (!read.ok) {
      failed += 1;
      continue;
    }
    const item = byId.get(result.id);
    if (item === undefined) continue;
    if (item.brand !== null) {
      brand.labeled += 1;
      if (read.scan.brand !== null) {
        brand.named += 1;
        if (brandKey(read.scan.brand) === brandKey(item.brand)) brand.agreed += 1;
      }
    }
    if (item.category !== null) {
      category.labeled += 1;
      if (read.scan.category !== null) {
        category.named += 1;
        if (read.scan.category === item.category) category.agreed += 1;
        if (topOf(read.scan.category) === topOf(item.category)) category.sameTop += 1;
      }
    }
    if (read.scan.aiEstimate !== null) {
      ranges.push({ range: read.scan.aiEstimate, saleCents: item.salePriceCents });
    }
  }
  const scanned = results.filter((result) => result.read !== undefined).length;
  return {
    scanned,
    failed,
    brand,
    category,
    estimate: estimateScores(ranges),
    costMicrosTotal,
    costMicrosPerScan: scanned === 0 ? 0 : Math.round(costMicrosTotal / scanned),
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
  };
}

function ownHistoryScores(
  source: IdentitySource,
  results: readonly ItemResult[],
  settings: ScanCallSettings,
): OwnHistoryScores {
  const byLevel = Object.fromEntries(MATCH_LEVELS.map((level) => [level, 0])) as Record<
    MatchLevel,
    number
  >;
  let thin = 0;
  let none = 0;
  const ranges: {
    range: { lowCents: number; midCents: number; highCents: number };
    saleCents: number;
  }[] = [];
  for (const result of results) {
    const found = result.calls[source]?.ownHistory;
    if (found === undefined) {
      none += 1;
    } else if (found.prices.count < settings.minComparisons) {
      thin += 1;
    } else {
      byLevel[found.level] += 1;
      const { lowCents, medianCents: midCents, highCents } = found.prices;
      ranges.push({ range: { lowCents, midCents, highCents }, saleCents: result.salePriceCents });
    }
  }
  return { identity: source, byLevel, thin, none, estimate: estimateScores(ranges) };
}

function callScores(
  source: IdentitySource,
  results: readonly ItemResult[],
  worthListingCents: number,
): CallScores {
  const counts: Record<ScanCallKind, number> = { buy: 0, your_call: 0, skip: 0 };
  const byConfidence: Record<CallConfidence, number> = { high: 0, medium: 0, low: 0 };
  const byBasis: Record<CallBasis, number> = { own_history: 0, ai_estimate: 0, none: 0 };
  let buyHeld = 0;
  let skipHeld = 0;
  for (const result of results) {
    const call = result.calls[source]?.call;
    if (call === undefined) continue;
    counts[call.call] += 1;
    byConfidence[call.confidence] += 1;
    byBasis[call.basis] += 1;
    const worth = result.payoutCents >= worthListingCents;
    if (call.call === 'buy' && worth) buyHeld += 1;
    if (call.call === 'skip' && !worth) skipHeld += 1;
  }
  return { identity: source, worthListingCents, counts, byConfidence, byBasis, buyHeld, skipHeld };
}

function estimateScores(
  ranges: readonly {
    range: { lowCents: number; midCents: number; highCents: number };
    saleCents: number;
  }[],
): EstimateScores {
  const errors = ranges.map(({ range, saleCents }) => (range.midCents - saleCents) / saleCents);
  return {
    priced: ranges.length,
    saleInRange: ranges.filter(
      ({ range, saleCents }) => saleCents >= range.lowCents && saleCents <= range.highCents,
    ).length,
    medianAbsError: median(errors.map((error) => Math.abs(error))),
    medianError: median(errors),
  };
}

function topOf(category: string): string {
  return category.slice(0, category.lastIndexOf('/'));
}

function median(values: readonly number[]): number | null {
  return percentile(values, 0.5);
}

/** The `q` percentile, linear between the two nearest values; null for no values. */
function percentile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const below = Math.floor(position);
  const lower = sorted[below] ?? 0;
  const upper = sorted[Math.min(below + 1, sorted.length - 1)] ?? lower;
  return lower + (upper - lower) * (position - below);
}
