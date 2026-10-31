import { AI_ESTIMATE_LABEL } from '@listora/pricing';

import type { OwnHistoryComparisons } from './own-history.ts';

/** The scan's answer to "is it worth listing?" (docs/features/thrift-scan.md, "The call"). */
export const SCAN_CALLS = ['buy', 'your_call', 'skip'] as const;
export type ScanCallKind = (typeof SCAN_CALLS)[number];

/** How sure the call is, always shown next to it. */
export const CALL_CONFIDENCES = ['high', 'medium', 'low'] as const;
export type CallConfidence = (typeof CALL_CONFIDENCES)[number];

/** Where the range the call rests on came from. */
export const CALL_BASES = ['own_history', 'ai_estimate', 'none'] as const;
export type CallBasis = (typeof CALL_BASES)[number];

export interface ScanCallSettings {
  /** The seller's "worth listing" amount: the least payout, after fees, worth buying for. */
  readonly worthListingCents: number;
  /** Fewest matching sales of the seller's own a range must rest on to beat the AI estimate. */
  readonly minComparisons: number;
  /** Matching sales (brand and category) a high-confidence call needs. */
  readonly highComparisons: number;
  /** The AI's identification confidence (0 to 1) below which the call is low confidence. */
  readonly minIdentityConfidence: number;
  /** The identification confidence a high-confidence call needs. */
  readonly highIdentityConfidence: number;
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
  minIdentityConfidence: 0.6,
  highIdentityConfidence: 0.8,
};

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
}

export interface ScanCall {
  readonly call: ScanCallKind;
  readonly confidence: CallConfidence;
  readonly basis: CallBasis;
  /** The payout after fees at the range's low end, and at its high end; absent with no range. */
  readonly conservativePayoutCents?: number;
  readonly optimisticPayoutCents?: number;
  /** What the call is based on, as the seller reads it. */
  readonly basedOn: string;
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
  const range = useHistory
    ? { lowCents: history.prices.lowCents, highCents: history.prices.highCents }
    : input.aiEstimate;
  if (range === undefined) {
    return {
      call: 'your_call',
      confidence: 'low',
      basis: 'none',
      basedOn: 'Not enough to go on',
    };
  }
  const confidence = useHistory ? historyConfidence(input, history, settings) : 'low';
  const conservativePayoutCents = payout(range.lowCents, input.fees);
  const optimisticPayoutCents = payout(range.highCents, input.fees);
  const flagged =
    input.flags.visibleDamage || input.flags.lotOrBundle || input.flags.counterfeitProne;
  const call: ScanCallKind =
    optimisticPayoutCents < settings.worthListingCents
      ? 'skip'
      : conservativePayoutCents >= settings.worthListingCents && confidence !== 'low' && !flagged
        ? 'buy'
        : 'your_call';
  return {
    call,
    confidence,
    basis: useHistory ? 'own_history' : 'ai_estimate',
    conservativePayoutCents,
    optimisticPayoutCents,
    basedOn: useHistory ? yourSales(history.prices.count) : AI_ESTIMATE_LABEL,
  };
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
