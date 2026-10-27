/**
 * What a scan at the packing table means (docs/features/pack-check.md, "Scanning"): the pure
 * rules, from the facts the database gave (scan.ts). The seller scans the shipping label, and
 * optionally the item's sticker, while packing one order (or with no order chosen, to find the
 * label's order), and the answer is one of:
 *
 * - `match`: the label is this order's: green, and Pack records it.
 * - `found`: with no order chosen, the label's order (or the sticker's), to pack next.
 * - `wrong_order`: the label is another order's: a red stop.
 * - `already_packed`: the label went on a package already (a second print): when, and on which.
 * - `sticker_mismatch`: the label is this order's but the sticker is another item's: a red stop.
 * - `unknown_label`: no order has this tracking number yet; the photo check decides.
 * - `sticker_scanned`: a sticker where the label goes.
 * - `not_a_label`: nothing that can be a tracking number.
 *
 * The sticker makes the match exact (the item in the package is the order's), the label alone
 * matches by its tracking number, and the item's photo, shown large with every answer, stays
 * the seller's own check.
 */
import { assertNever } from '@listora/shared';

/** An open order, as a verdict names it. */
export interface VerdictOrder {
  saleId: string;
  /** "the black Shaka Wear tee, 2XL" (`describeOrder`). */
  description: string;
  /** The SKUs of the order's items. */
  skus: readonly string[];
}

/** A label already packed: when, and on which order's package. */
export interface PackedLabel {
  order: VerdictOrder;
  packedAt: Date;
}

/** What the database knows about the scanned codes. */
export interface ScanFacts {
  /** The canonical tracking number scanned, or `null` when no label was scanned. */
  label: string | null;
  /** Whether a label code was scanned that cannot be a tracking number. */
  labelUnreadable: boolean;
  /** The SKU the scanned label code names, when the "label" was an item sticker. */
  labelIsSticker: boolean;
  /** The sticker's SKU, when one was scanned. */
  stickerSku: string | null;
  /** The order being packed, when the seller chose one. */
  expected: VerdictOrder | null;
  /** The open orders whose label has this tracking number. */
  labelOrders: readonly VerdictOrder[];
  /** The package this label went on already, if any. */
  packed: PackedLabel | null;
  /** The open order the sticker's item is in, if any. */
  stickerOrder: VerdictOrder | null;
}

export type ScanVerdict =
  | { verdict: 'match'; order: VerdictOrder; matchedBy: 'sticker' | 'label' }
  | { verdict: 'found'; order: VerdictOrder; matchedBy: 'sticker' | 'label' }
  | { verdict: 'wrong_order'; order: VerdictOrder; expected: VerdictOrder }
  | { verdict: 'already_packed'; packed: PackedLabel; expected: VerdictOrder | null }
  | { verdict: 'sticker_mismatch'; order: VerdictOrder; sticker: VerdictOrder | null; sku: string }
  | { verdict: 'unknown_label'; expected: VerdictOrder | null }
  | { verdict: 'sticker_scanned'; order: VerdictOrder | null }
  | { verdict: 'not_a_label' };

export type ScanVerdictKind = ScanVerdict['verdict'];

/** Decides what the scan means. */
export function scanVerdict(facts: ScanFacts): ScanVerdict {
  const { expected, stickerSku } = facts;
  if (facts.labelIsSticker) return { verdict: 'sticker_scanned', order: facts.stickerOrder };
  if (facts.label === null) {
    if (facts.labelUnreadable) return { verdict: 'not_a_label' };
    // Only a sticker: the order its item is in.
    if (stickerSku === null) return { verdict: 'not_a_label' };
    if (facts.stickerOrder === null) return { verdict: 'unknown_label', expected };
    if (expected !== null && facts.stickerOrder.saleId !== expected.saleId) {
      return {
        verdict: 'sticker_mismatch',
        order: expected,
        sticker: facts.stickerOrder,
        sku: stickerSku,
      };
    }
    return expected === null
      ? { verdict: 'found', order: facts.stickerOrder, matchedBy: 'sticker' }
      : { verdict: 'match', order: expected, matchedBy: 'sticker' };
  }
  // A label on a package already: whatever else is true, this copy must not go on another.
  if (facts.packed !== null) return { verdict: 'already_packed', packed: facts.packed, expected };
  const own =
    expected === null
      ? facts.labelOrders[0]
      : facts.labelOrders.find((order) => order.saleId === expected.saleId);
  if (own === undefined) {
    const [other] = facts.labelOrders;
    if (other !== undefined && expected !== null) {
      return { verdict: 'wrong_order', order: other, expected };
    }
    return { verdict: 'unknown_label', expected };
  }
  if (stickerSku !== null && !own.skus.includes(stickerSku)) {
    return {
      verdict: 'sticker_mismatch',
      order: own,
      sticker: facts.stickerOrder,
      sku: stickerSku,
    };
  }
  const matchedBy = stickerSku === null ? 'label' : 'sticker';
  return expected === null
    ? { verdict: 'found', order: own, matchedBy }
    : { verdict: 'match', order: own, matchedBy };
}

/** The contract's `StatusTone` values a verdict uses. */
export type VerdictTone = 'success' | 'failed' | 'action_needed' | 'neutral';

/** What the app shows for a verdict, in the seller's words. */
export interface VerdictWords {
  tone: VerdictTone;
  headline: string;
  detail: string;
}

/** The words for a verdict; `now` dates a label packed earlier ("12 minutes ago"). */
export function verdictWords(verdict: ScanVerdict, now: Date): VerdictWords {
  switch (verdict.verdict) {
    case 'match':
      return {
        tone: 'success',
        headline: `This label is for ${verdict.order.description}.`,
        detail:
          verdict.matchedBy === 'sticker'
            ? 'The label and the item sticker match this order. Tap Packed.'
            : 'The label matches this order. Check the item against the photo, then tap Packed.',
      };
    case 'found':
      return {
        tone: 'neutral',
        headline: `This ${verdict.matchedBy === 'sticker' ? 'sticker' : 'label'} is for ${verdict.order.description}.`,
        detail: 'Pack this order with it.',
      };
    case 'wrong_order':
      return {
        tone: 'failed',
        headline: `This label is for ${verdict.order.description}.`,
        detail: `Do not use it on this package. This package is for ${verdict.expected.description}.`,
      };
    case 'already_packed': {
      const when = ago(verdict.packed.packedAt, now);
      const same = verdict.expected?.saleId === verdict.packed.order.saleId;
      return {
        tone: 'failed',
        headline: same
          ? 'This order is already packed with this label.'
          : 'This label was already used.',
        detail: same
          ? `You packed ${verdict.packed.order.description} with it ${when}.`
          : `It went on the package for ${verdict.packed.order.description} ${when}. If your printer printed it twice, throw this copy away.`,
      };
    }
    case 'sticker_mismatch':
      return {
        tone: 'failed',
        headline:
          verdict.sticker === null
            ? `This sticker (${verdict.sku}) is not for ${verdict.order.description}.`
            : `This sticker is for ${verdict.sticker.description}.`,
        detail: `Do not pack it with this label. The label is for ${verdict.order.description}.`,
      };
    case 'unknown_label':
      return {
        tone: 'action_needed',
        headline: "Listora doesn't know this label yet.",
        detail:
          verdict.expected === null
            ? 'Choose the order it is for, then check the item against its photo.'
            : `Check the photo: is this label for ${verdict.expected.description}? If it is, tap "It's this order".`,
      };
    case 'sticker_scanned':
      return {
        tone: 'action_needed',
        headline: "That's an item sticker.",
        detail: 'Scan the barcode on the shipping label.',
      };
    case 'not_a_label':
      return {
        tone: 'action_needed',
        headline: "That isn't a shipping label's barcode.",
        detail: 'Scan the long barcode with the tracking number, or type the number.',
      };
    default:
      return assertNever(verdict, 'scan verdict');
  }
}

/** "12 minutes ago", "3 hours ago", "2 days ago"; no time zone needed. */
export function ago(then: Date, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - then.getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${String(minutes)} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${String(hours)} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${String(days)} days ago`;
}
