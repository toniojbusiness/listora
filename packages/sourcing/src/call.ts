import {
  AI_ESTIMATE_LABEL,
  ASKING_PRICES_LABEL,
  marketSoldLabel,
  WEB_INFO_LABEL,
} from '@listora/pricing';

import {
  DEFAULT_PRICE_CALIBRATION_SETTINGS,
  calibratedAiEstimate,
  calibratedWebAsks,
  calibrationPercent,
  type PriceCalibration,
} from './calibration.ts';
import { dollarsAndCents, type ItemCost } from './cost.ts';
import type { MarketDemand, MarketMatchLevel } from './market.ts';
import { scanPrices, type ScanPrices } from './prices.ts';

import type { OwnHistoryComparisons } from './own-history.ts';
import type { UnsoldLikeIt } from './unsold.ts';
import type { SalesTrend } from './trend.ts';

/** The scan's answer to "is it worth listing?" (docs/features/thrift-scan.md, "The call"). */
export const SCAN_CALLS = ['buy', 'your_call', 'skip'] as const;
export type ScanCallKind = (typeof SCAN_CALLS)[number];

/** How sure the call is, always shown next to it. */
export const CALL_CONFIDENCES = ['high', 'medium', 'low'] as const;
export type CallConfidence = (typeof CALL_CONFIDENCES)[number];

/**
 * Where the range the call rests on came from: the household's own sales, a marketplace's sold
 * listings (its public search, eBay's, Poshmark's, or Mercari's), the web, or the AI estimate.
 */
export const CALL_BASES = [
  'own_history',
  'market_sold',
  'web_info',
  'ai_estimate',
  'none',
] as const;
export type CallBasis = (typeof CALL_BASES)[number];

export interface ScanCallSettings {
  /** The seller's "worth listing" amount: the least payout, after fees, worth buying for. */
  readonly worthListingCents: number;
  /** Fewest matching sales of the seller's own a range must rest on to beat the AI estimate. */
  readonly minComparisons: number;
  /** Matching sales (brand and category) a high-confidence call needs. */
  readonly highComparisons: number;
  /** Sites a web resale range needs for a medium-confidence call (else low). */
  readonly webSitesForMedium: number;
  /** The AI's identification confidence (0 to 1) below which the call is low confidence. */
  readonly minIdentityConfidence: number;
  /** The identification confidence a high-confidence call needs. */
  readonly highIdentityConfidence: number;
  /**
   * How much more than the seller's own sales an item with its tags still on is taken to pay,
   * as a share (0.15 is 15%). A starting estimate: the backtest's sales had no tag reads.
   */
  readonly newWithTagsBump: number;
  /** Close matches for sale a marketplace's asking prices need before they hold a range. */
  readonly minAskingMatches: number;
  /** Close matches a marketplace's sold listings need before the call rests on them. */
  readonly minMarketSold: number;
  /** Sold close matches of the exact model a high-confidence call on them needs. */
  readonly highMarketSold: number;
}

/**
 * The defaults, set by the backtest on the household's 64 Depop sales (`npm run eval -- scan`,
 * thrift-scan.md "Backtest", 2026-10-31). Worth listing is $8, which 75% of those sales paid
 * out. At the plan's first guess, about the median payout, the call left 83% of items to the
 * seller and its Skips held under half the time; at $8 its Buys on a one-photo scan held 10
 * times in 11, with no Skips.
 */
export const DEFAULT_SCAN_CALL_SETTINGS: ScanCallSettings = {
  worthListingCents: 800,
  minComparisons: 3,
  highComparisons: 5,
  webSitesForMedium: 2,
  minIdentityConfidence: 0.6,
  highIdentityConfidence: 0.8,
  newWithTagsBump: 0.15,
  minAskingMatches: 5,
  minMarketSold: 5,
  highMarketSold: 10,
};

/** What else the call weighed, each said with what it rests on. */
export const SCAN_SIGNAL_KINDS = [
  'retail',
  'new_with_tags',
  'web_resale',
  'brand_pulse',
  'trend',
  'style',
  'unsold',
  'asking',
  'demand',
  'calibrated',
  'prices',
  'missing',
  'cost',
] as const;
export type ScanSignalKind = (typeof SCAN_SIGNAL_KINDS)[number];

export interface ScanSignal {
  readonly kind: ScanSignalKind;
  /** Short, as the card shows it: "Retail $68 on the tag", "Trending up", "Y2K". */
  readonly label: string;
  readonly basedOn: string;
}

/** What the AI saw that keeps an item from being a Buy whatever its price. */
export interface ScanFlags {
  readonly visibleDamage: boolean;
  readonly lotOrBundle: boolean;
  readonly counterfeitProne: boolean;
}

export interface ScanCallInput {
  /** How sure the identification is, 0 to 1. */
  readonly identityConfidence: number;
  readonly ownHistory?: OwnHistoryComparisons | undefined;
  /**
   * What the seller's items sell for against their asking price (`priceCalibration`): the web's
   * asking prices are scaled by its square, and the AI estimate of a named brand by it, before
   * either holds a range. Without one both are taken as they are.
   */
  readonly calibration?: PriceCalibration | undefined;
  /**
   * The read named a brand. The AI prices a named brand like that brand's listings ask (on the
   * backtest, 35% over the sale against 7% without one), so only then is its estimate scaled.
   */
  readonly namedBrand?: boolean | undefined;
  /** The AI's price guess in cents, as the AI gave it; never called sold data. */
  readonly aiEstimate?:
    | { readonly lowCents: number; readonly midCents: number; readonly highCents: number }
    | undefined;
  readonly flags: ScanFlags;
  /** The marketplace's estimated fees for one item at a price (`feeEstimator`). */
  readonly fees: (priceCents: number) => number;
  /** The original retail price: read off a price tag, or found on the web (with its site). */
  readonly retail?:
    | {
        readonly lowCents: number;
        readonly highCents: number;
        readonly from: 'tag' | 'web';
        /** The site that states it, for a web price. */
        readonly site?: string | undefined;
        /** The likely models a web range covers, when the exact one is not known. */
        readonly models?: readonly string[] | undefined;
      }
    | undefined;
  /** What the web's used listings of such items ask, with the sites (web research): asking prices. */
  readonly web?:
    | {
        readonly lowCents: number;
        readonly highCents: number;
        readonly sites: readonly string[];
        readonly reputation: 'strong' | 'average' | 'weak' | 'unknown';
      }
    | undefined;
  /**
   * What the wider web says of the brand (the brand pulse): in demand, steady, or slow, with
   * why, what asks more, and the sites. A signal only; it never moves the call (the backtest
   * found no call it would have made hold more often, thrift-scan.md "Brand pulse").
   */
  readonly brandPulse?:
    | {
        readonly verdict: 'in_demand' | 'steady' | 'slow';
        readonly reason: string;
        readonly premium?: string | undefined;
        readonly sites: readonly string[];
      }
    | undefined;
  /** The tags are still on (the read's condition is `new_with_tags`). */
  readonly newWithTags?: boolean | undefined;
  /** How the seller's own sales like it are moving (`salesTrend`). */
  readonly trend?: SalesTrend | undefined;
  /** A style or era buyers search by, the AI's read. */
  readonly style?: string | undefined;
  /** The household's items like it in inventory, not sold (`unsoldLikeIt`); never moves the call. */
  readonly unsold?: UnsoldLikeIt | undefined;
  /**
   * Each marketplace's comparisons (its public search, read logged out), Depop first: what close
   * matches for sale ask, what they sold for where the marketplace shows sold listings (eBay,
   * Poshmark, Mercari), and the demand. A marketplace's sold listings are the range when the
   * household's own sales are too few; a demand from a marketplace's sold pace that reads slow keeps a call from high
   * confidence, and any other demand is a signal only.
   */
  readonly markets?: readonly MarketCallInput[] | undefined;
  /**
   * What the item likely costs where the seller sources (`itemCost`): its weight at the bins'
   * price per pound, or a store's price. The call weighs the payouts less it; none: free.
   */
  readonly cost?: ItemCost | undefined;
}

/** One marketplace's comparisons, as the call weighs them. */
export interface MarketCallInput {
  /** As the seller reads it: "Depop". */
  readonly marketplace: string;
  readonly asking?: {
    readonly count: number;
    readonly lowCents: number;
    readonly highCents: number;
  };
  /** Close matches' sold prices (low to high quartile), and how far back they go. */
  readonly sold?: {
    readonly count: number;
    readonly lowCents: number;
    readonly highCents: number;
    readonly windowDays: number | null;
    readonly level: MarketMatchLevel;
  };
  readonly demand?: {
    readonly demand: MarketDemand;
    readonly label?: string | undefined;
    readonly basedOn: string;
    /** The demand is the marketplace's own sold pace, not the household's sales. */
    readonly fromSoldPace?: boolean;
  };
}

/** The card's three prices, with where they come from as the seller reads it. */
export interface ScanCallPrices extends ScanPrices {
  readonly basedOn: string;
}

export interface ScanCall {
  readonly call: ScanCallKind;
  readonly confidence: CallConfidence;
  readonly basis: CallBasis;
  /** The price range the call rests on; absent with none. */
  readonly range?: { readonly lowCents: number; readonly highCents: number };
  /** The payout after fees at the range's low end, and at its high end; absent with no range. */
  readonly conservativePayoutCents?: number;
  readonly optimisticPayoutCents?: number;
  /** What the call is based on, as the seller reads it. */
  readonly basedOn: string;
  /**
   * The headline's one-line why (`callWhy`): what the range pays out against the worth-listing
   * amount, a flag, or how little there is to go on.
   */
  readonly why: string;
  /** The AI estimate as the card shows it: scaled by the calibration when there is one. */
  readonly aiEstimate?: {
    readonly lowCents: number;
    readonly midCents: number;
    readonly highCents: number;
  };
  /** List at, realistic sale, and fast sale, from the range (`scanPrices`); absent with no range. */
  readonly prices?: ScanCallPrices;
  /** The item's likely cost the payouts were weighed against, when the input had one. */
  readonly cost?: ItemCost;
  /** The retail tag, new with tags, the trend, and the style, when there is something to say. */
  readonly signals: readonly ScanSignal[];
}

/**
 * The call, from the payouts after fees less the item's likely cost (thrift-scan.md "The call"):
 * - the range is the seller's own matching sales (low to high quartile) when there are at
 *   least `minComparisons`, else a marketplace's sold listings, the web's asks, or the AI
 *   estimate;
 * - **Skip** when even the range's high end pays out under the worth-listing amount;
 * - **Buy** when its low end, less the cost, pays out at least that and no flag is raised, at
 *   any confidence (at the bins a clearly valuable item is worth its pound even when the exact
 *   model is unsure), unless the range is an estimate (the web's asks or the AI's) that every
 *   other source says pays less, or the AI estimate with nothing to check it (`unsupportedBy`);
 * - **Your call** otherwise: the range straddles the amount, a flag, or that lone estimate.
 */
export function scanCall(
  input: ScanCallInput,
  settings: ScanCallSettings = DEFAULT_SCAN_CALL_SETTINGS,
): ScanCall {
  const history = input.ownHistory;
  const useHistory = history !== undefined && history.prices.count >= settings.minComparisons;
  const calibration = input.calibration;
  const estimateCalibration = input.namedBrand === true ? calibration : undefined;
  const scaleEstimate = input.aiEstimate !== undefined && estimateCalibration !== undefined;
  const aiEstimate =
    input.aiEstimate === undefined || estimateCalibration === undefined
      ? input.aiEstimate
      : calibratedAiEstimate(input.aiEstimate, estimateCalibration);
  const asks =
    input.web !== undefined && input.web.highCents > 0 && input.web.sites.length > 0
      ? input.web
      : undefined;
  const web =
    asks !== undefined && calibration !== undefined ? calibratedWebAsks(asks, calibration) : asks;
  const markets = input.markets ?? [];
  const soldMarket = markets.find(
    (market) => market.sold !== undefined && market.sold.count >= settings.minMarketSold,
  );
  const sold = soldMarket?.sold;
  const basis: CallBasis = useHistory
    ? 'own_history'
    : sold
      ? 'market_sold'
      : web
        ? 'web_info'
        : aiEstimate
          ? 'ai_estimate'
          : 'none';
  const signals: ScanSignal[] = [];
  let range =
    basis === 'own_history' && history
      ? { lowCents: history.prices.lowCents, highCents: history.prices.highCents }
      : basis === 'market_sold' && sold
        ? { lowCents: sold.lowCents, highCents: sold.highCents }
        : basis === 'web_info' && web
          ? { lowCents: web.lowCents, highCents: web.highCents }
          : aiEstimate && {
              lowCents: aiEstimate.lowCents,
              highCents: aiEstimate.highCents,
            };
  const tagsBump =
    range !== undefined && useHistory && input.newWithTags === true && settings.newWithTagsBump > 0
      ? 1 + settings.newWithTagsBump
      : 1;
  if (range !== undefined && tagsBump !== 1) {
    const bump = tagsBump;
    range = {
      lowCents: Math.round(range.lowCents * bump),
      highCents: Math.round(range.highCents * bump),
    };
    signals.push({
      kind: 'new_with_tags',
      label: 'New with tags',
      basedOn: `Your sales like it, plus ${String(Math.round(settings.newWithTagsBump * 100))}% for the tags still on (a starting estimate)`,
    });
  }
  const retail = input.retail;
  if (retail !== undefined && retail.highCents > 0) {
    // The AI's guess runs high (the backtest): resale above the retail price is not taken on
    // the AI's word.
    const capped =
      basis === 'ai_estimate' && range !== undefined && range.highCents > retail.highCents;
    if (capped && range) {
      range = { lowCents: Math.min(range.lowCents, retail.highCents), highCents: retail.highCents };
    }
    const exact = retail.lowCents === retail.highCents;
    const price = exact
      ? dollars(retail.highCents)
      : `${dollars(retail.lowCents)}-${dollars(retail.highCents)}`;
    const models =
      !exact && retail.models !== undefined && retail.models.length > 1
        ? ` across ${String(retail.models.length)} models`
        : '';
    const source =
      retail.from === 'tag' ? 'Read off the tag' : `${WEB_INFO_LABEL}: ${retail.site ?? 'the web'}`;
    signals.push({
      kind: 'retail',
      label:
        retail.from === 'tag'
          ? `Retail ${price} on the tag`
          : `Retail ${exact ? 'about ' : ''}${price}${models}`,
      basedOn: capped
        ? `${AI_ESTIMATE_LABEL}, held to the retail price`
        : range === undefined
          ? source
          : `${source}; the range is ${percentOf(range.lowCents, retail.highCents)}-${percentOf(range.highCents, retail.highCents)} of ${dollars(retail.highCents)}`,
    });
  }
  // Depop first: the first marketplace with enough close matches for sale holds the range.
  const askingMarket = markets.find(
    (market) => market.asking !== undefined && market.asking.count >= settings.minAskingMatches,
  );
  const asking = askingMarket?.asking;
  if (askingMarket !== undefined && asking !== undefined) {
    // Sellers ask more than buyers pay, so a guess above what close matches ask is not taken.
    const held =
      (basis === 'ai_estimate' || basis === 'web_info') &&
      range !== undefined &&
      range.highCents > asking.highCents;
    if (held && range) {
      range = { lowCents: Math.min(range.lowCents, asking.highCents), highCents: asking.highCents };
    }
    signals.push({
      kind: 'asking',
      label: `Asking ${dollars(asking.lowCents)}-${dollars(asking.highCents)} on ${askingMarket.marketplace}`,
      basedOn: `${ASKING_PRICES_LABEL}: ${String(asking.count)} like it for sale on ${askingMarket.marketplace}${
        held ? '; the range is held to them' : ''
      }`,
    });
  }
  for (const market of markets) {
    const demand = market.demand;
    if (demand?.label !== undefined) {
      signals.push({ kind: 'demand', label: demand.label, basedOn: demand.basedOn });
    }
  }
  if (web !== undefined && web.reputation !== 'unknown' && web.reputation !== 'average') {
    signals.push({
      kind: 'web_resale',
      label: web.reputation === 'strong' ? 'Resells well' : 'Resells poorly',
      basedOn: `${WEB_INFO_LABEL}: ${web.sites.join(', ')}`,
    });
  }
  if (input.brandPulse !== undefined) signals.push(brandPulseSignal(input.brandPulse));
  const trend = input.trend;
  if (trend?.label !== undefined) {
    signals.push({ kind: 'trend', label: trend.label, basedOn: trend.basedOn });
  }
  if (input.style !== undefined && input.style !== '') {
    signals.push({
      kind: 'style',
      label: input.style,
      basedOn: "The AI's read of the style, not sales data",
    });
  }
  if (input.unsold !== undefined && input.unsold.count > 0) {
    signals.push(unsoldSignal(input.unsold));
  }
  if (calibration !== undefined && (scaleEstimate || web !== undefined)) {
    signals.push(calibrationSignal(calibration, scaleEstimate, web !== undefined));
  }
  const shownEstimate = aiEstimate === undefined ? {} : { aiEstimate };
  if (range === undefined) {
    return {
      call: 'your_call',
      confidence: 'low',
      basis: 'none',
      basedOn: 'Not enough to go on',
      why: 'Not enough to price it: no sales like it, web prices, or AI estimate',
      ...shownEstimate,
      signals,
    };
  }
  let confidence: CallConfidence =
    basis === 'own_history' && history
      ? historyConfidence(input, history, settings)
      : basis === 'market_sold' && sold
        ? marketSoldConfidence(input, sold, settings)
        : basis === 'web_info' && web
          ? webConfidence(input, web.sites.length, settings)
          : 'low';
  // Slowing sales of the seller's own, or a marketplace where items like it sell slowly, never
  // back a high-confidence call; a rise or a fast pace never raises one.
  const slow = markets.some(
    (market) => market.demand?.fromSoldPace === true && market.demand.demand === 'crowded',
  );
  if ((trend?.direction === 'down' || slow) && confidence === 'high') confidence = 'medium';

  const conservativePayoutCents = payout(range.lowCents, input.fees);
  const optimisticPayoutCents = payout(range.highCents, input.fees);
  const flagged =
    input.flags.visibleDamage || input.flags.lotOrBundle || input.flags.counterfeitProne;
  const cost = input.cost;
  const costCents = cost?.cents ?? 0;
  const unsupported =
    basis === 'web_info' || basis === 'ai_estimate'
      ? unsupportedBy(
          basis,
          otherSources(basis, input, history, aiEstimate, web, markets),
          input.fees,
          costCents,
          settings.worthListingCents,
        )
      : undefined;
  const call = decideCall(
    {
      conservativePayoutCents,
      optimisticPayoutCents,
      costCents,
      flagged,
      unsupported: unsupported !== undefined,
    },
    settings,
  );
  const why = callWhy(
    call,
    { conservativePayoutCents, optimisticPayoutCents, confidence },
    input.flags,
    settings,
    {
      ...(cost === undefined ? {} : { cost }),
      ...(unsupported === undefined ? {} : { unsupported }),
    },
  );
  if (cost !== undefined) {
    signals.push({ kind: 'cost', label: cost.label, basedOn: cost.basedOn });
  }
  const expected =
    basis === 'own_history' && history
      ? Math.round(history.prices.medianCents * tagsBump)
      : basis === 'ai_estimate' && aiEstimate
        ? aiEstimate.midCents
        : (range.lowCents + range.highCents) / 2;
  const prices = {
    ...scanPrices(range, expected, calibration),
    basedOn: pricesBasedOn(basis, calibration),
  };
  return {
    call,
    confidence,
    basis,
    range,
    conservativePayoutCents,
    optimisticPayoutCents,
    prices,
    basedOn:
      basis === 'own_history' && history
        ? yourSales(history.prices.count)
        : basis === 'market_sold' && soldMarket && sold
          ? `${marketSoldLabel(soldMarket.marketplace)}: ${soldPace(sold.count, sold.windowDays)}`
          : basis === 'web_info' && web
            ? `${WEB_INFO_LABEL}: ${webBasis(web.sites, calibration !== undefined)}`
            : AI_ESTIMATE_LABEL,
    why,
    ...shownEstimate,
    ...(cost === undefined ? {} : { cost }),
    signals,
  };
}

/** A source other than the one the range rests on, as the call checks it against the range. */
interface OtherSource {
  /** As the why names it: "Depop's asks", "the retail price". */
  readonly name: string;
  /** The name takes "say" ("Depop's asks say less"), not "says". */
  readonly plural: boolean;
  readonly highCents: number;
}

/**
 * Why a range resting on an estimate (the web's asks or the AI's) makes no Grab on its own:
 * every other source that prices the item says it pays less (`disagreed`), or, for the AI
 * estimate, there is no other source to check it against (`alone`).
 */
export type UnsupportedEstimate =
  | {
      readonly kind: 'disagreed';
      /** What the range rests on, as the why names it: "the web's asks", "the AI estimate". */
      readonly estimate: string;
      readonly by: { readonly name: string; readonly plural: boolean };
    }
  | { readonly kind: 'alone'; readonly estimate: string };

/**
 * Every source other than the range's own that prices the item: the household's own sales like
 * it (even fewer than `minComparisons`), each marketplace's sold listings and asks, the web's
 * asks, the AI estimate (both as scaled), and the retail price.
 */
function otherSources(
  basis: CallBasis,
  input: ScanCallInput,
  history: OwnHistoryComparisons | undefined,
  aiEstimate: ScanCallInput['aiEstimate'],
  web: { readonly highCents: number } | undefined,
  markets: readonly MarketCallInput[],
): OtherSource[] {
  const sources: OtherSource[] = [];
  if (history !== undefined && history.prices.count > 0) {
    sources.push({ name: 'your sales like it', plural: true, highCents: history.prices.highCents });
  }
  for (const market of markets) {
    if (market.sold !== undefined && market.sold.count > 0) {
      sources.push({
        name: `${market.marketplace}'s sold listings`,
        plural: true,
        highCents: market.sold.highCents,
      });
    }
    if (market.asking !== undefined && market.asking.count > 0) {
      sources.push({
        name: `${market.marketplace}'s asks`,
        plural: true,
        highCents: market.asking.highCents,
      });
    }
  }
  if (basis !== 'web_info' && web !== undefined) {
    sources.push({ name: "the web's asks", plural: true, highCents: web.highCents });
  }
  if (basis !== 'ai_estimate' && aiEstimate !== undefined) {
    sources.push({ name: 'the AI estimate', plural: false, highCents: aiEstimate.highCents });
  }
  if (input.retail !== undefined && input.retail.highCents > 0) {
    sources.push({ name: 'the retail price', plural: false, highCents: input.retail.highCents });
  }
  return sources;
}

/**
 * Whether the range's own estimate stands unsupported, so it makes no Grab: every other source
 * says the item pays less (its high end, after fees and the cost, under the worth-listing
 * amount), or the range is the AI estimate with no other source at all. Undefined when a
 * source agrees, or the range is the web's asks with nothing else (several sites' listings).
 */
function unsupportedBy(
  basis: 'web_info' | 'ai_estimate',
  sources: readonly OtherSource[],
  fees: (priceCents: number) => number,
  costCents: number,
  worthListingCents: number,
): UnsupportedEstimate | undefined {
  const estimate = basis === 'web_info' ? "the web's asks" : 'the AI estimate';
  const [first] = sources;
  if (first === undefined) return basis === 'ai_estimate' ? { kind: 'alone', estimate } : undefined;
  const disagrees = (source: OtherSource) =>
    payout(source.highCents, fees) - costCents < worthListingCents;
  return sources.every(disagrees)
    ? { kind: 'disagreed', estimate, by: { name: first.name, plural: first.plural } }
    : undefined;
}

/**
 * The headline's one-line why, from the payouts after fees against the worth-listing amount:
 * a Grab pays out enough even at the range's low end; a Leave not even at its high end; a Maybe
 * says what holds it back (a flag, little to go on, or a range across the amount). Never says
 * "sold": the payouts are estimates whatever the range rests on.
 */
export function callWhy(
  call: ScanCallKind,
  payouts: {
    readonly conservativePayoutCents: number;
    readonly optimisticPayoutCents: number;
    readonly confidence: CallConfidence;
  },
  flags: ScanFlags,
  settings: Pick<ScanCallSettings, 'worthListingCents'>,
  weighed: {
    /** The item's likely cost the payouts were weighed against. */
    readonly cost?: ItemCost;
    /** Why the range's own estimate makes no Grab on its own (`unsupportedBy`). */
    readonly unsupported?: UnsupportedEstimate;
  } = {},
): string {
  const low = dollars(Math.max(0, payouts.conservativePayoutCents));
  const high = dollars(Math.max(0, payouts.optimisticPayoutCents));
  const worth = dollars(settings.worthListingCents);
  const range = low === high ? low : `${low}-${high}`;
  const cost = weighed.cost;
  // "your $8 plus its $1.49 bins cost": the line the payouts must clear.
  const line =
    cost === undefined || cost.cents === 0
      ? `your ${worth}`
      : `your ${worth} plus its ${dollarsAndCents(cost.cents)} ${cost.mode === 'bins' ? 'bins cost' : 'store price'}`;
  switch (call) {
    case 'buy':
      return payouts.confidence === 'low'
        ? `Even its low end pays out ${low} after fees, over ${line}, though the exact item is unsure`
        : `Even its low end pays out ${low} after fees, over ${line}`;
    case 'skip':
      return `Pays out ${high} at most after fees, under your ${worth}`;
    case 'your_call':
      if (flags.counterfeitProne)
        return `Pays out ${range} after fees, but often faked: check it's real`;
      if (flags.visibleDamage) return `Pays out ${range} after fees, but it shows damage`;
      if (flags.lotOrBundle) return `Pays out ${range} after fees, but it's a lot or bundle`;
      if (weighed.unsupported?.kind === 'disagreed') {
        const { estimate, by } = weighed.unsupported;
        return `Pays out ${range} after fees on ${estimate}, but ${by.name} ${by.plural ? 'say' : 'says'} less`;
      }
      if (weighed.unsupported?.kind === 'alone') {
        return `Pays out ${range} after fees on ${weighed.unsupported.estimate} alone, with nothing to check it`;
      }
      return `Pays out ${range} after fees: it may or may not clear ${line}`;
  }
}

/**
 * The call from a range's payouts and the item's likely cost, the one rule the server's call
 * and the iPhone's offline call share (`offlineScanCall`, kept equal by golden cases): **Skip**
 * when even the optimistic payout is under the worth-listing amount; **Buy** when the
 * conservative one less the cost reaches it, with no flag and an estimate that does not stand
 * unsupported; **Your call** otherwise. The cost raises only the Buy's line: a wrong Leave
 * throws away an item that would have paid, while at bins prices the cost is small, and with it
 * on the Leave's line too the backtest's Leaves held 3 times in 7 against 2 in 2 without
 * (thrift-scan.md "Backtest", 2026-11-05). The offline call has no cost (its tag gives no
 * category) and no other source, so its rule is the payouts against the amount.
 */
export function decideCall(
  range: {
    readonly conservativePayoutCents: number;
    readonly optimisticPayoutCents: number;
    /** The item's likely cost; none: 0. */
    readonly costCents?: number;
    readonly flagged: boolean;
    /** The range is an estimate every other source says pays less (`unsupportedBy`). */
    readonly unsupported?: boolean;
  },
  settings: Pick<ScanCallSettings, 'worthListingCents'>,
): ScanCallKind {
  const cost = range.costCents ?? 0;
  if (range.optimisticPayoutCents < settings.worthListingCents) return 'skip';
  return range.conservativePayoutCents - cost >= settings.worthListingCents &&
    !range.flagged &&
    range.unsupported !== true
    ? 'buy'
    : 'your_call';
}

/**
 * Where the three prices come from, as the seller reads it: the realistic sale is the middle of
 * what the call rests on, the fast sale its low end, and the list price leaves room for offers.
 * Never says "sold": the three are estimates, whatever the range rests on.
 */
function pricesBasedOn(basis: CallBasis, calibration: PriceCalibration | undefined): string {
  const middle =
    basis === 'own_history'
      ? 'the middle of your sales like it'
      : basis === 'market_sold'
        ? "the middle of the marketplace's prices"
        : basis === 'web_info'
          ? "the middle of the web's asks, scaled to your sales"
          : 'the middle of the AI estimate';
  const share = calibrationPercent(
    calibration?.saleToAsking ?? DEFAULT_PRICE_CALIBRATION_SETTINGS.defaultSaleToAsking,
  );
  const room =
    calibration !== undefined && calibration.sales > 0
      ? `your items went for ${share} of what they asked`
      : `items usually go for about ${share} of what they ask`;
  return `Likely sale is ${middle}, fast sale its low end; list at leaves room for offers (${room})`;
}

/**
 * The three prices as a signal, for a card built before they had a place of their own (it
 * lists signals by their label): "List at $35 · Likely sale $25 · Fast sale $18".
 */
export function pricesSignal(prices: ScanCallPrices): ScanSignal {
  return {
    kind: 'prices',
    label: `List at ${dollars(prices.listAtCents)} · Likely sale ${dollars(prices.realisticCents)} · Fast sale ${dollars(prices.fastCents)}`,
    basedOn: prices.basedOn,
  };
}

/** The web's asks a range rests on: "asks on poshmark.com, scaled to your sales". */
function webBasis(sites: readonly string[], calibrated: boolean): string {
  return `asks on ${sites.join(', ')}${calibrated ? ', scaled to your sales' : ''}`;
}

/** Says what the AI estimate and the web's asking prices were scaled by, and why. */
function calibrationSignal(
  calibration: PriceCalibration,
  estimate: boolean,
  asks: boolean,
): ScanSignal {
  const what =
    estimate && asks
      ? "the AI estimate and the web's asking prices are"
      : estimate
        ? 'the AI estimate is'
        : "the web's asking prices are";
  const share = calibrationPercent(calibration.saleToAsking);
  return {
    kind: 'calibrated',
    label: 'Scaled to your sales',
    basedOn:
      calibration.sales === 0
        ? `Items usually go for about ${share} of what they ask; ${what} scaled to it`
        : `Your items went for ${share} of what they asked (${String(calibration.sales)} ${
            calibration.sales === 1 ? 'sale' : 'sales'
          }); ${what} scaled to it`,
  };
}

function unsoldSignal(unsold: UnsoldLikeIt): ScanSignal {
  return {
    kind: 'unsold',
    label: `You have ${String(unsold.count)} like it unsold`,
    basedOn:
      unsold.level === 'brand_and_category'
        ? 'Your items of the same brand and kind in inventory, ready or listed'
        : 'Your items of the same brand in inventory, ready or listed',
  };
}

/**
 * A marketplace's sold listings: high only with many sold of the exact model and a sure read;
 * medium with a usable read; low otherwise.
 */
function marketSoldConfidence(
  input: ScanCallInput,
  sold: NonNullable<MarketCallInput['sold']>,
  settings: ScanCallSettings,
): CallConfidence {
  if (input.identityConfidence < settings.minIdentityConfidence) return 'low';
  if (
    (sold.level === 'model_and_size' || sold.level === 'model') &&
    sold.count >= settings.highMarketSold &&
    input.identityConfidence >= settings.highIdentityConfidence
  ) {
    return 'high';
  }
  return 'medium';
}

/** "9 like it in the last 14 days", or "9 like it" where the marketplace dates none. */
export function soldPace(count: number, windowDays: number | null): string {
  const like = `${String(count)} like it`;
  if (windowDays === null) return like;
  return windowDays <= 1
    ? `${like} in the last day`
    : `${like} in the last ${String(windowDays)} days`;
}

/** Web info never makes a high-confidence call; medium only with a sure read and two sites. */
function webConfidence(
  input: ScanCallInput,
  sites: number,
  settings: ScanCallSettings,
): CallConfidence {
  return input.identityConfidence >= settings.highIdentityConfidence &&
    sites >= settings.webSitesForMedium
    ? 'medium'
    : 'low';
}

function dollars(cents: number): string {
  return `$${String(Math.round(cents / 100))}`;
}

function percentOf(cents: number, of: number): string {
  return `${String(Math.round((cents / of) * 100))}%`;
}

function historyConfidence(
  input: ScanCallInput,
  history: OwnHistoryComparisons,
  settings: ScanCallSettings,
): CallConfidence {
  if (input.identityConfidence < settings.minIdentityConfidence) return 'low';
  if (history.level === 'category') return 'low';
  if (
    history.level === 'brand_and_category' &&
    history.prices.count >= settings.highComparisons &&
    input.identityConfidence >= settings.highIdentityConfidence
  ) {
    return 'high';
  }
  return 'medium';
}

function payout(priceCents: number, fees: (priceCents: number) => number): number {
  return Math.max(0, priceCents - fees(priceCents));
}

function yourSales(count: number): string {
  return count === 1 ? 'Your 1 sale like it' : `Your ${String(count)} sales like it`;
}

/** The signal's label and what it rests on fit the card (60 and 200 characters). */
const PULSE_VERDICT_WORDS = { in_demand: 'in demand', steady: 'steady', slow: 'slow' } as const;
const MAX_SIGNAL_BASED_ON = 200;

/**
 * "Brand pulse: in demand", resting on "Web info - not sold listings: Y2K coverage has it
 * trending. Asks more: vintage 90s pieces. (vogue.com, reddit.com)". When it would not fit, the
 * last sites give way first, then what asks more, so it keeps its reason and a site.
 */
export function brandPulseSignal(pulse: NonNullable<ScanCallInput['brandPulse']>): ScanSignal {
  const reason = /[.!?]$/.test(pulse.reason) ? pulse.reason : `${pulse.reason}.`;
  const premium =
    pulse.premium === undefined || pulse.premium === ''
      ? undefined
      : `Asks more: ${pulse.premium.replace(/[.]$/, '')}.`;
  const siteLists = pulse.sites.map((_, index) => pulse.sites.slice(0, pulse.sites.length - index));
  const texts = [
    ...siteLists.map((sites) => [reason, premium, `(${sites.join(', ')})`]),
    ...siteLists.map((sites) => [reason, `(${sites.join(', ')})`]),
    [reason, premium],
    [reason],
  ].map((parts) => `${WEB_INFO_LABEL}: ${parts.filter((part) => part !== undefined).join(' ')}`);
  const basedOn =
    texts.find((text) => text.length <= MAX_SIGNAL_BASED_ON) ??
    `${(texts.at(-1) ?? '').slice(0, MAX_SIGNAL_BASED_ON - 1)}…`;
  return {
    kind: 'brand_pulse',
    label: `Brand pulse: ${PULSE_VERDICT_WORDS[pulse.verdict]}`,
    basedOn,
  };
}
