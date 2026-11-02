import {
  feeEstimator,
  feeTableFor,
  estimateFeesCents,
  type FeeCalibration,
} from '@listora/pricing';
import {
  calibratedWebAsks,
  DEFAULT_SCAN_CALL_SETTINGS,
  MATCH_LEVELS,
  brandKey,
  priceCalibration,
  snapBrand,
  medianCents,
  ownHistoryComparisons,
  scanCall,
  type CallConfidence,
  type HistorySale,
  type MatchLevel,
  type OwnHistoryComparisons,
  type PriceCalibration,
  type ScanCallInput,
  type ScanCallKind,
  type ScanCallSettings,
  type ScanIdentity,
} from '@listora/sourcing';
import type { ThriftScan } from '@listora/analysis';

import type { ScanDataset, ScanDatasetItem } from './dataset.ts';
import type { ResearchRead, ScanRead, ScanReader, ScanResearcher } from './readers.ts';
import {
  anchoredCall,
  isVintage,
  resaleRatio,
  retailAnchoredRange,
  saleToRetail,
  type BacktestBasis,
  type BacktestCall,
  type ResaleRatio,
} from './retail-anchor.ts';

/**
 * The call's variants: `ai`, the scan's own read as the call took it before the calibration
 * (the AI estimate and the web's asks as they came); `calibrated`, the same read with its brand
 * snapped to one of the seller's own (`snapBrand`) and the AI estimate and the web's asks scaled
 * by the seller's sale-to-asking ratio (`priceCalibration`), the call at the store today;
 * `anchored`, the same with a known retail price holding the range at the seller's
 * resale-to-retail ratio ahead of the web's asks and the AI estimate (`anchoredCall`, measured
 * and not shipped); `anchored_default`, the same at the default ratio, as for a seller with no
 * sales of a known retail price; `labels`, the set's labels with full
 * confidence and no AI estimate (the best an own-history-only call could do, offline too). Each
 * item's snap, calibration, and ratio come from the set's other items only (leave-one-out), so
 * an item never calibrates itself.
 */
export const CALL_VARIANTS = [
  'ai',
  'calibrated',
  'anchored',
  'anchored_default',
  'labels',
] as const;
export type CallVariant = (typeof CALL_VARIANTS)[number];

/** The variants whose prices are scored side by side: before and after each change. */
export const PRICE_VARIANTS = ['ai', 'calibrated', 'anchored', 'anchored_default'] as const;
export type PriceVariant = (typeof PRICE_VARIANTS)[number];

/** The worth-listing amounts the sweep tries, $5 to $20. */
export const DEFAULT_WORTH_SWEEP_CENTS = [500, 800, 1_000, 1_200, 1_500, 2_000];

export interface ScanBacktestOptions {
  /** The AI read; without one only the `labels` variant runs. */
  readonly reader?: ScanReader;
  /** The web research after each read (with a reader only); without one the call has no web info. */
  readonly researcher?: ScanResearcher;
  readonly settings?: ScanCallSettings;
  readonly worthSweepCents?: readonly number[];
}

export interface ItemResult {
  readonly id: string;
  readonly salePriceCents: number;
  /** What the seller got: the sale price less the actual fees, or the estimated ones. */
  readonly payoutCents: number;
  readonly read: ScanRead | undefined;
  /** The web research of the read, when one ran and the read had a brand. */
  readonly research?: ResearchRead | undefined;
  readonly calls: Partial<Record<CallVariant, VariantResult>>;
}

export interface VariantResult {
  readonly identity: ScanIdentity;
  /** The brand as the AI read it, when the variant snapped it to one of the seller's own. */
  readonly snappedFrom?: string;
  /** The seller's sale-to-asking ratio the variant scaled the AI estimate and web asks by. */
  readonly calibration?: PriceCalibration;
  /** The seller's resale-to-retail ratio a known retail price was taken at. */
  readonly resaleRatio?: ResaleRatio;
  readonly ownHistory: OwnHistoryComparisons | undefined;
  readonly call: BacktestCall;
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
  readonly variant: CallVariant;
  /** Items whose match had at least the minimum comparisons, by level, and the rest. */
  readonly byLevel: Readonly<Record<MatchLevel, number>>;
  readonly thin: number;
  readonly none: number;
  /** Of the items with enough comparisons, scored on their quartiles and median. */
  readonly estimate: EstimateScores;
}

export interface CallScores {
  readonly variant: CallVariant;
  readonly worthListingCents: number;
  readonly counts: Readonly<Record<ScanCallKind, number>>;
  readonly byConfidence: Readonly<Record<CallConfidence, number>>;
  readonly byBasis: Readonly<Record<BacktestBasis, number>>;
  /** Buys that really paid out the worth-listing amount, and Skips that really paid less. */
  readonly buyHeld: number;
  readonly skipHeld: number;
}

/** The prices of one variant against what the items sold for, in one category group. */
export interface PriceScores {
  readonly variant: PriceVariant;
  /**
   * `all`; `with retail`, the items whose read or lookup found a retail price (every source
   * on the same items as the retail anchor); or the labeled category's group
   * (`clothing/bottoms`), or `unlabeled`.
   */
  readonly group: string;
  readonly items: number;
  /** The AI estimate as the card shows it. */
  readonly aiEstimate: EstimateScores;
  /** The web's asking prices (the research's range), as the call weighs them. */
  readonly webAsks: EstimateScores;
  /** The household's own sales like it, low to high quartile (3 or more). */
  readonly ownSales: EstimateScores;
  /** The retail price times the resale-to-retail ratio, where a retail price was known. */
  readonly retailAnchor: EstimateScores;
  /** The range the call rests on, whatever its basis; its middle is the midpoint. */
  readonly call: EstimateScores;
}

/**
 * What the items resold for as a share of their retail price, where the read or the web found
 * one: overall, then by the labeled category's group. Ratios only, no titles or brands.
 */
export interface RetailRatioScores {
  readonly group: string;
  readonly items: number;
  readonly low: number;
  readonly median: number;
  readonly high: number;
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
  readonly researcher: { readonly id: string; readonly description: string } | null;
  readonly settings: ScanCallSettings;
  readonly read: ReadScores | null;
  readonly ownHistory: readonly OwnHistoryScores[];
  /** Every price the card shows, before and after the calibration, overall and by category. */
  readonly prices: readonly PriceScores[];
  /** The sale-to-retail ratios of the items whose retail price was found. */
  readonly retailRatios: readonly RetailRatioScores[];
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
    askingPriceCents: item.askingPriceCents,
  }));

  const variants: readonly CallVariant[] =
    options.reader === undefined ? ['labels'] : CALL_VARIANTS;
  const results: ItemResult[] = [];
  // Each variant's call, kept to make it again at each worth-listing amount.
  const remakes = new Map<string, Partial<Record<CallVariant, Remake>>>();
  // Every read and lookup first: an item's resale-to-retail ratio rests on the others' retail.
  const looked: { read: ScanRead | undefined; research: ResearchRead | undefined }[] = [];
  for (const item of items) {
    const read =
      options.reader === undefined ? undefined : await options.reader.read(dataset, item);
    const research =
      options.researcher === undefined || read?.ok !== true
        ? undefined
        : await options.researcher.research(item, read.scan);
    looked.push({ read, research });
  }
  const retailById = new Map(
    items.map((item, index) => [
      item.id,
      retailMiddle(retailOf(scanOf(looked[index]?.read), looked[index]?.research)),
    ]),
  );
  const sales: BacktestSale[] = history.map((sale) => ({
    ...sale,
    retailCents: retailById.get(sale.id),
  }));
  for (const [index, item] of items.entries()) {
    const { read, research } = looked[index] ?? { read: undefined, research: undefined };
    const others = sales.filter((sale) => sale.id !== item.id);
    const calls: Partial<Record<CallVariant, VariantResult>> = {};
    const itemRemakes: Partial<Record<CallVariant, Remake>> = {};
    for (const name of variants) {
      const made = variant(name, item, read, research, others, settings, fees);
      calls[name] = made.result;
      itemRemakes[name] = made.remake;
    }
    remakes.set(item.id, itemRemakes);
    results.push({
      id: item.id,
      salePriceCents: item.salePriceCents,
      payoutCents: payoutOf(item),
      read,
      ...(research === undefined ? {} : { research }),
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
    researcher:
      options.researcher === undefined || options.reader === undefined
        ? null
        : { id: options.researcher.id, description: options.researcher.description },
    settings,
    read: options.reader === undefined ? null : readScores(items, results),
    ownHistory: variants.map((name) => ownHistoryScores(name, results, settings)),
    prices: options.reader === undefined ? [] : priceScores(items, results, settings),
    retailRatios: retailRatioScores(items, retailById),
    calls: variants.map((name) => callScores(name, results, settings.worthListingCents)),
    sweep: variants.flatMap((name) =>
      sweepAmounts.map((worthListingCents) => {
        const swept = { ...settings, worthListingCents };
        const recalled = results.map((result) => {
          const current = result.calls[name];
          const remake = remakes.get(result.id)?.[name];
          if (current === undefined || remake === undefined) return result;
          return { ...result, calls: { [name]: { ...current, call: remake(swept) } } };
        });
        return callScores(name, recalled, worthListingCents);
      }),
    ),
    items: results,
  };
}

/** A variant's call made again at other settings (the worth-listing sweep). */
type Remake = (settings: ScanCallSettings) => BacktestCall;

/** One of the set's sales, with the retail price its read or lookup found. */
type BacktestSale = HistorySale & { readonly retailCents?: number | undefined };

function variant(
  name: CallVariant,
  item: ScanDatasetItem,
  read: ScanRead | undefined,
  research: ResearchRead | undefined,
  others: readonly BacktestSale[],
  settings: ScanCallSettings,
  fees: (priceCents: number) => number,
): { result: VariantResult; remake: Remake } {
  const scan = read?.ok === true ? read.scan : undefined;
  const calibrated = name !== 'ai' && name !== 'labels';
  const snapped = calibrated
    ? snapBrand(
        scan?.brand ?? null,
        others.map((sale) => sale.brand),
      )
    : undefined;
  const identity: ScanIdentity =
    name === 'labels'
      ? { brand: item.brand, category: item.category }
      : { brand: snapped?.brand ?? scan?.brand ?? null, category: scan?.category ?? null };
  const ownHistory = ownHistoryComparisons(identity, others, {
    minComparisons: settings.minComparisons,
  });
  const calibration = calibrated ? priceCalibration(others) : undefined;
  const ratio =
    name === 'anchored'
      ? resaleRatio(others)
      : name === 'anchored_default'
        ? resaleRatio([])
        : undefined;
  const input = callInput(name, scan, research, ownHistory, fees, identity, calibration);
  const vintage = scan !== undefined && isVintage(scan);
  const remake: Remake = (at) =>
    ratio === undefined ? scanCall(input, at) : anchoredCall(input, ratio, vintage, at);
  return {
    result: {
      identity,
      ...(snapped === undefined ? {} : { snappedFrom: snapped.readAs }),
      ...(calibration === undefined ? {} : { calibration }),
      ...(ratio === undefined ? {} : { resaleRatio: ratio }),
      ownHistory,
      call: remake(settings),
    },
    remake,
  };
}

/**
 * The call's input as the scan builds it (`assessScan` in the API): the read, the household's
 * own sales like it, and the research's retail price and web asking prices; a price tag's
 * retail price comes first.
 */
function callInput(
  name: CallVariant,
  scan: ThriftScan | undefined,
  research: ResearchRead | undefined,
  ownHistory: OwnHistoryComparisons | undefined,
  fees: (priceCents: number) => number,
  identity: ScanIdentity,
  calibration: PriceCalibration | undefined,
): ScanCallInput {
  if (name === 'labels') {
    const known = identity.brand !== null || identity.category !== null;
    return { identityConfidence: known ? 1 : 0, ownHistory, flags: NO_FLAGS, fees };
  }
  const found = research?.ok === true ? research.research : undefined;
  const retail = retailOf(scan, research);
  return {
    identityConfidence: scan?.identityConfidence ?? 0,
    ownHistory,
    aiEstimate: scan?.aiEstimate ?? undefined,
    flags: scan?.flags ?? NO_FLAGS,
    fees,
    ...(calibration === undefined ? {} : { calibration }),
    namedBrand: identity.brand !== null,
    ...(retail === undefined ? {} : { retail }),
    ...(found?.resale
      ? {
          web: {
            lowCents: found.resale.lowCents,
            highCents: found.resale.highCents,
            sites: found.resale.sources.map((source) => source.site),
            reputation: found.reputation,
          },
        }
      : {}),
    newWithTags: scan?.condition === 'new_with_tags',
  };
}

const NO_FLAGS = { visibleDamage: false, lotOrBundle: false, counterfeitProne: false };

function scanOf(read: ScanRead | undefined): ThriftScan | undefined {
  return read?.ok === true ? read.scan : undefined;
}

/** The retail price as the scan takes it (`assessScan`): a price tag's first, else the web's. */
function retailOf(
  scan: ThriftScan | undefined,
  research: ResearchRead | undefined,
): NonNullable<ScanCallInput['retail']> | undefined {
  const found = research?.ok === true ? research.research : undefined;
  if (scan?.retailPriceCents !== null && scan?.retailPriceCents !== undefined) {
    return { lowCents: scan.retailPriceCents, highCents: scan.retailPriceCents, from: 'tag' };
  }
  if (!found?.retail) return undefined;
  return {
    lowCents: found.retail.lowCents,
    highCents: found.retail.highCents,
    from: 'web',
    site: found.retail.sources[0]?.site,
    models: found.retail.models,
  };
}

/** A retail price as one number for the ratio: a range across models at its middle. */
function retailMiddle(
  retail: { readonly lowCents: number; readonly highCents: number } | undefined,
): number | undefined {
  return retail === undefined || retail.highCents <= 0
    ? undefined
    : Math.round((retail.lowCents + retail.highCents) / 2);
}

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
  source: CallVariant,
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
  return { variant: source, byLevel, thin, none, estimate: estimateScores(ranges) };
}

function callScores(
  source: CallVariant,
  results: readonly ItemResult[],
  worthListingCents: number,
): CallScores {
  const counts: Record<ScanCallKind, number> = { buy: 0, your_call: 0, skip: 0 };
  const byConfidence: Record<CallConfidence, number> = { high: 0, medium: 0, low: 0 };
  const byBasis: Record<BacktestBasis, number> = {
    own_history: 0,
    market_sold: 0,
    retail: 0,
    web_info: 0,
    ai_estimate: 0,
    none: 0,
  };
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
  return { variant: source, worthListingCents, counts, byConfidence, byBasis, buyHeld, skipHeld };
}

interface Scored {
  readonly range: { lowCents: number; midCents: number; highCents: number };
  readonly saleCents: number;
}

/**
 * Every price the card shows, before (`ai`) and after (`calibrated`) the calibration, against
 * what each item sold for: overall, then by the labeled category's group.
 */
function priceScores(
  items: readonly ScanDatasetItem[],
  results: readonly ItemResult[],
  settings: ScanCallSettings,
): PriceScores[] {
  const groupOf = new Map(items.map((item) => [item.id, categoryGroup(item.category)]));
  const withRetail = new Set(
    results
      .filter(
        (result) =>
          retailOf(scanOf(result.read), result.research) !== undefined &&
          !isVintage(scanOf(result.read) ?? {}),
      )
      .map((result) => result.id),
  );
  const groups = ['all', WITH_RETAIL, ...[...new Set(groupOf.values())].sort()];
  return PRICE_VARIANTS.flatMap((name) =>
    groups.map((group) => {
      const inGroup = results.filter(
        (result) =>
          group === 'all' ||
          (group === WITH_RETAIL ? withRetail.has(result.id) : groupOf.get(result.id) === group),
      );
      const ai: Scored[] = [];
      const web: Scored[] = [];
      const own: Scored[] = [];
      const anchor: Scored[] = [];
      const call: Scored[] = [];
      for (const result of inGroup) {
        const made = result.calls[name];
        if (made === undefined) continue;
        const saleCents = result.salePriceCents;
        const scan = result.read?.ok === true ? result.read.scan : undefined;
        const estimate = name === 'ai' ? scan?.aiEstimate : made.call.aiEstimate;
        if (estimate !== undefined && estimate !== null) ai.push({ range: estimate, saleCents });
        const resale = result.research?.ok === true ? result.research.research.resale : null;
        if (resale !== null) {
          const asks =
            made.calibration === undefined ? resale : calibratedWebAsks(resale, made.calibration);
          web.push({ range: withMid(asks), saleCents });
        }
        const found = made.ownHistory;
        if (found !== undefined && found.prices.count >= settings.minComparisons) {
          const { lowCents, medianCents: midCents, highCents } = found.prices;
          own.push({ range: { lowCents, midCents, highCents }, saleCents });
        }
        const retail = retailOf(scan, result.research);
        if (made.resaleRatio !== undefined && retail !== undefined && scan && !isVintage(scan)) {
          anchor.push({ range: withMid(retailAnchoredRange(retail, made.resaleRatio)), saleCents });
        }
        if (made.call.range !== undefined)
          call.push({ range: withMid(made.call.range), saleCents });
      }
      return {
        variant: name,
        group,
        items: inGroup.length,
        aiEstimate: estimateScores(ai),
        webAsks: estimateScores(web),
        ownSales: estimateScores(own),
        retailAnchor: estimateScores(anchor),
        call: estimateScores(call),
      };
    }),
  );
}

function retailRatioScores(
  items: readonly ScanDatasetItem[],
  retailById: ReadonlyMap<string, number | undefined>,
): RetailRatioScores[] {
  const ratios = items.flatMap((item) => {
    const retail = retailById.get(item.id);
    if (retail === undefined) return [];
    return [
      { group: categoryGroup(item.category), ratio: saleToRetail(item.salePriceCents, retail) },
    ];
  });
  const groups = ['all', ...[...new Set(ratios.map((entry) => entry.group))].sort()];
  return groups.flatMap((group) => {
    const values = ratios
      .filter((entry) => group === 'all' || entry.group === group)
      .map((entry) => entry.ratio);
    if (values.length === 0) return [];
    return [
      {
        group,
        items: values.length,
        low: percentile(values, 0.25) ?? 0,
        median: percentile(values, 0.5) ?? 0,
        high: percentile(values, 0.75) ?? 0,
      },
    ];
  });
}

/** The price table's group of the items with a retail price, not vintage. */
const WITH_RETAIL = 'with retail';

/** A category's group: its path less the last step (`clothing/bottoms`), or `unlabeled`. */
function categoryGroup(category: string | null): string {
  return category === null ? 'unlabeled' : topOf(category);
}

function withMid(range: { lowCents: number; highCents: number }) {
  return {
    lowCents: range.lowCents,
    midCents: Math.round((range.lowCents + range.highCents) / 2),
    highCents: range.highCents,
  };
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
