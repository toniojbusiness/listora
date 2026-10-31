import { AI_ESTIMATE_LABEL, WEB_INFO_LABEL } from '@listora/pricing';

import type { OwnHistoryComparisons } from './own-history.ts';
import type { UnsoldLikeIt } from './unsold.ts';
import type { SalesTrend } from './trend.ts';

/** The scan's answer to "is it worth listing?" (docs/features/thrift-scan.md, "The call"). */
export const SCAN_CALLS = ['buy', 'your_call', 'skip'] as const;
export type ScanCallKind = (typeof SCAN_CALLS)[number];

/** How sure the call is, always shown next to it. */
export const CALL_CONFIDENCES = ['high', 'medium', 'low'] as const;
export type CallConfidence = (typeof CALL_CONFIDENCES)[number];

/** Where the range the call rests on came from. */
export const CALL_BASES = ['own_history', 'web_info', 'ai_estimate', 'none'] as const;
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
};

/** What else the call weighed, each said with what it rests on. */
export const SCAN_SIGNAL_KINDS = [
  'retail',
  'new_with_tags',
  'web_resale',
  'trend',
  'style',
  'unsold',
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
  /** The AI's price guess in cents; never called sold data. */
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
  /** What the web says such items resell for, with the sites it comes from (web research). */
  readonly web?:
    | {
        readonly lowCents: number;
        readonly highCents: number;
        readonly sites: readonly string[];
        readonly reputation: 'strong' | 'average' | 'weak' | 'unknown';
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
  /** The retail tag, new with tags, the trend, and the style, when there is something to say. */
  readonly signals: readonly ScanSignal[];
}

/**
 * The call, from resale value only (no cost: that comes at the haul's checkout):
 * - the range is the seller's own matching sales (low to high quartile) when there are at
 *   least `minComparisons`, else the AI estimate, which alone is always low confidence;
 * - **Skip** when even the range's high end pays out less than the worth-listing amount;
 * - **Buy** when its low end pays out at least that, the confidence is medium or high, and no
 *   flag is raised;
 * - **Your call** otherwise: the range straddles the amount, the read is unsure, or a flag.
 */
export function scanCall(
  input: ScanCallInput,
  settings: ScanCallSettings = DEFAULT_SCAN_CALL_SETTINGS,
): ScanCall {
  const history = input.ownHistory;
  const useHistory = history !== undefined && history.prices.count >= settings.minComparisons;
  const web =
    input.web !== undefined && input.web.highCents > 0 && input.web.sites.length > 0
      ? input.web
      : undefined;
  const basis: CallBasis = useHistory
    ? 'own_history'
    : web
      ? 'web_info'
      : input.aiEstimate
        ? 'ai_estimate'
        : 'none';
  const signals: ScanSignal[] = [];
  let range =
    basis === 'own_history' && history
      ? { lowCents: history.prices.lowCents, highCents: history.prices.highCents }
      : basis === 'web_info' && web
        ? { lowCents: web.lowCents, highCents: web.highCents }
        : input.aiEstimate && {
            lowCents: input.aiEstimate.lowCents,
            highCents: input.aiEstimate.highCents,
          };
  if (
    range !== undefined &&
    useHistory &&
    input.newWithTags === true &&
    settings.newWithTagsBump > 0
  ) {
    const bump = 1 + settings.newWithTagsBump;
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
  if (web !== undefined && web.reputation !== 'unknown' && web.reputation !== 'average') {
    signals.push({
      kind: 'web_resale',
      label: web.reputation === 'strong' ? 'Resells well' : 'Resells poorly',
      basedOn: `${WEB_INFO_LABEL}: ${web.sites.join(', ')}`,
    });
  }
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
  if (range === undefined) {
    return {
      call: 'your_call',
      confidence: 'low',
      basis: 'none',
      basedOn: 'Not enough to go on',
      signals,
    };
  }
  let confidence: CallConfidence =
    basis === 'own_history' && history
      ? historyConfidence(input, history, settings)
      : basis === 'web_info' && web
        ? webConfidence(input, web.sites.length, settings)
        : 'low';
  // Slowing sales of the seller's own never back a high-confidence call; a rise never raises one.
  if (trend?.direction === 'down' && confidence === 'high') confidence = 'medium';
  const conservativePayoutCents = payout(range.lowCents, input.fees);
  const optimisticPayoutCents = payout(range.highCents, input.fees);
  const flagged =
    input.flags.visibleDamage || input.flags.lotOrBundle || input.flags.counterfeitProne;
  const call = decideCall(
    { conservativePayoutCents, optimisticPayoutCents, confidence, flagged },
    settings,
  );
  return {
    call,
    confidence,
    basis,
    range,
    conservativePayoutCents,
    optimisticPayoutCents,
    basedOn:
      basis === 'own_history' && history
        ? yourSales(history.prices.count)
        : basis === 'web_info' && web
          ? `${WEB_INFO_LABEL}: ${web.sites.join(', ')}`
          : AI_ESTIMATE_LABEL,
    signals,
  };
}

/**
 * The call from a range's payouts, the one rule the server's call and the iPhone's offline call
 * share (`offlineScanCall`, kept equal by golden cases): **Skip** when even the optimistic payout
 * is under the worth-listing amount; **Buy** when the conservative one reaches it at medium or
 * high confidence with no flag; **Your call** otherwise.
 */
export function decideCall(
  range: {
    readonly conservativePayoutCents: number;
    readonly optimisticPayoutCents: number;
    readonly confidence: CallConfidence;
    readonly flagged: boolean;
  },
  settings: Pick<ScanCallSettings, 'worthListingCents'>,
): ScanCallKind {
  if (range.optimisticPayoutCents < settings.worthListingCents) return 'skip';
  return range.conservativePayoutCents >= settings.worthListingCents &&
    range.confidence !== 'low' &&
    !range.flagged
    ? 'buy'
    : 'your_call';
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
