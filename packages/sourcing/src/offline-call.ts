/**
 * The scan's instant read with no signal (docs/features/thrift-scan.md, "Offline at the bins"):
 * the brand printed on the tag, looked up in the sourcing kit, and the call from the household's
 * own sales of it alone. The iPhone has its own copy of this rule (`OfflineScanCall` in the app's
 * Core); the golden cases in `offline-call.cases.ts`, which both test suites run, keep the two
 * equal. Pure.
 */
import type { KnownMarketplace, OwnSalesBucket, SourcingKit } from '@listora/api-contract';

import { brandKey } from './brand.ts';
import { decideCall, type CallConfidence, type ScanCallKind } from './call.ts';
import { SOURCING_KIT_VERSION } from './kit.ts';

/** Shown with every offline call: it rests on the household's own sales and nothing else. */
export const OFFLINE_CALL_LABEL = 'From your sales only';

/** The offline read of one scan, in whole cents. */
export interface OfflineScanRead {
  /** The brand as the household's sales spell it, and its match key. */
  readonly brand: string;
  readonly brandKey: string;
  readonly call: ScanCallKind;
  readonly confidence: CallConfidence;
  /** `own_history` when enough of the brand's sales back a range, else `none`. */
  readonly basis: 'own_history' | 'none';
  readonly lowCents?: number;
  readonly highCents?: number;
  readonly conservativePayoutCents?: number;
  readonly optimisticPayoutCents?: number;
  readonly payoutMarketplace?: KnownMarketplace;
  /** What the call rests on, as the seller reads it. */
  readonly basedOn: string;
  /** The household's items of the brand in inventory, not sold (groups that sold only). */
  readonly unsoldCount: number;
}

/** The longest run of words a brand candidate is read from, so a long line stays cheap. */
const MAX_CANDIDATE_WORDS = 4;

/**
 * The kit's brand group whose brand the tag text names: each line in reading order, each word
 * of it in order, the first whose `brandKey` (of that word and the few after it) is a brand of
 * the kit. Only brand groups count; a category or size group needs a category the tag cannot
 * give. Undefined when no line names one.
 */
export function tagBrandBucket(
  kit: SourcingKit,
  tagText: readonly string[],
): OwnSalesBucket | undefined {
  const brands = new Map<string, OwnSalesBucket>();
  for (const bucket of kit.buckets) {
    if (bucket.category === undefined && bucket.sizeBucket === undefined) {
      brands.set(bucket.brandKey, bucket);
    }
  }
  for (const line of tagText) {
    const words = line.split(/\s+/).filter((word) => word !== '');
    for (let start = 0; start < words.length; start += 1) {
      const key = brandKey(words.slice(start, start + MAX_CANDIDATE_WORDS).join(' '));
      const bucket = key === undefined ? undefined : brands.get(key);
      if (bucket) return bucket;
    }
  }
  return undefined;
}

/**
 * The offline call of a scan whose tag names a brand of the kit, or undefined when the kit is of
 * a format this rule does not know or the tag names none of its brands.
 *
 * The brand is the one thing known: it is printed, so the read counts as sure, but with no
 * category the own sales match on the brand alone, which the server's call never makes high
 * confidence. So: at least `minComparisons` of the brand's sales (not eBay's) give a range from
 * their low to high quartile, at medium confidence, and the call is the server's rule
 * (`decideCall`) on its payouts, with no flags (nothing saw the item). Fewer give no range: Your
 * call, low confidence.
 */
export function offlineScanCall(
  kit: SourcingKit,
  tagText: readonly string[],
): OfflineScanRead | undefined {
  if (kit.version !== SOURCING_KIT_VERSION) return undefined;
  const bucket = tagBrandBucket(kit, tagText);
  if (bucket === undefined) return undefined;
  const sales = bucket.forCall;
  const identity = {
    brand: bucket.brand,
    brandKey: bucket.brandKey,
    unsoldCount: bucket.unsoldCount,
  };
  if (sales === undefined || sales.soldCount < kit.call.minComparisons) {
    return {
      ...identity,
      call: 'your_call',
      confidence: 'low',
      basis: 'none',
      basedOn: `Not enough of your ${bucket.brand} sales to go on`,
    };
  }
  const confidence: CallConfidence = 'medium';
  const conservativePayoutCents = sales.conservativePayout.amountCents;
  const optimisticPayoutCents = sales.optimisticPayout.amountCents;
  return {
    ...identity,
    call: decideCall(
      { conservativePayoutCents, optimisticPayoutCents, confidence, flagged: false },
      { worthListingCents: kit.call.worthListing.amountCents },
    ),
    confidence,
    basis: 'own_history',
    lowCents: sales.low.amountCents,
    highCents: sales.high.amountCents,
    conservativePayoutCents,
    optimisticPayoutCents,
    payoutMarketplace: sales.payoutMarketplace,
    basedOn: `Your ${String(sales.soldCount)} ${bucket.brand} sales`,
  };
}
