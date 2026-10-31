/**
 * The offline call's golden cases (docs/features/thrift-scan.md, "Offline at the bins"): one
 * invented kit, tag texts, and what the call must say for each, by hand. `offline-call.test.ts`
 * runs them here and writes them for the iPhone, whose own copy of the rule runs the same file
 * (`OfflineScanCallTests` in the app's Core). Invented brands' sales; no real shop's data.
 */
import type { KnownMarketplace, SourcingKit } from '@listora/api-contract';

import type { OfflineScanRead } from './offline-call.ts';

const usd = (amountCents: number) => ({ amountCents, currency: 'USD' as const });

function marketplace(
  name: KnownMarketplace,
  soldCount: number,
  low: number,
  median: number,
  high: number,
) {
  return {
    marketplace: name,
    soldCount,
    low: usd(low),
    median: usd(median),
    high: usd(high),
    medianPayout: usd(Math.round(median * 0.87)),
    feeTableVersion: `${name}-2026-01`,
    displayOnly: name === 'ebay',
  };
}

function forCall(
  soldCount: number,
  low: number,
  high: number,
  conservative: number,
  optimistic: number,
  payoutMarketplace: KnownMarketplace = 'depop',
) {
  return {
    soldCount,
    low: usd(low),
    high: usd(high),
    payoutMarketplace,
    conservativePayout: usd(conservative),
    optimisticPayout: usd(optimistic),
  };
}

export const GOLDEN_KIT: SourcingKit = {
  version: 2,
  generatedAt: '2026-10-31T12:00:00.000Z',
  windowDays: 365,
  call: { worthListing: usd(800), minComparisons: 3 },
  buckets: [
    {
      brand: 'Coach',
      brandKey: 'coach',
      unsoldCount: 0,
      // eBay's sales are display only: they never feed a call.
      marketplaces: [marketplace('ebay', 6, 4000, 5200, 7000)],
    },
    {
      brand: 'Étoile Isabel Marant',
      brandKey: 'etoile',
      unsoldCount: 0,
      marketplaces: [marketplace('poshmark', 3, 4500, 5000, 6000)],
      forCall: forCall(3, 4500, 6000, 3600, 4800, 'poshmark'),
    },
    {
      brand: 'Free People',
      brandKey: 'free people',
      unsoldCount: 1,
      marketplaces: [marketplace('depop', 4, 1800, 2200, 2600)],
      forCall: forCall(4, 1800, 2600, 1580, 2290),
    },
    {
      brand: "Levi's",
      brandKey: 'levi',
      unsoldCount: 3,
      marketplaces: [marketplace('depop', 2, 2000, 2400, 2800)],
      forCall: forCall(2, 2000, 2800, 1760, 2460),
    },
    {
      brand: 'Lululemon',
      brandKey: 'lululemon',
      unsoldCount: 2,
      marketplaces: [
        marketplace('depop', 4, 2500, 2800, 3400),
        marketplace('mercari', 1, 3000, 3000, 3000),
      ],
      forCall: forCall(5, 2500, 3400, 2210, 3010),
    },
    {
      // A category group: the tag cannot give a category, so the offline call never reads it.
      brand: 'Lululemon',
      brandKey: 'lululemon',
      category: 'clothing/bottoms/leggings',
      unsoldCount: 1,
      marketplaces: [marketplace('depop', 3, 3200, 3400, 3600)],
      forCall: forCall(3, 3200, 3600, 2850, 3200),
    },
    {
      brand: 'Old Navy',
      brandKey: 'old navy',
      unsoldCount: 0,
      marketplaces: [marketplace('depop', 4, 600, 750, 900)],
      forCall: forCall(4, 600, 900, 480, 760),
    },
    {
      brand: 'Patagonia',
      brandKey: 'patagonia',
      unsoldCount: 0,
      marketplaces: [marketplace('depop', 3, 900, 2500, 4000)],
      forCall: forCall(3, 900, 4000, 700, 3500),
    },
  ],
  // The offline call never reads the insights; the app shows them as they are.
  insights: {
    soldCount: 12,
    daysToSellCount: 4,
    lookFor: [
      {
        brand: 'Lululemon',
        brandKey: 'lululemon',
        category: 'clothing/bottoms/leggings',
        soldCount: 5,
        unsoldCount: 1,
        inStockCount: 2,
        sellThroughBasisPoints: 8333,
        medianDaysToSell: 9,
        medianPayout: usd(2100),
      },
    ],
    best: [
      {
        brand: 'Lululemon',
        brandKey: 'lululemon',
        category: 'clothing/bottoms/leggings',
        soldCount: 5,
        unsoldCount: 1,
        inStockCount: 2,
        sellThroughBasisPoints: 8333,
        medianDaysToSell: 9,
        medianPayout: usd(2100),
      },
    ],
    worst: [
      {
        brand: 'Coach',
        brandKey: 'coach',
        category: 'bags/handbags',
        soldCount: 0,
        unsoldCount: 3,
        inStockCount: 3,
        sellThroughBasisPoints: 0,
      },
    ],
  },
};

export interface OfflineCallCase {
  readonly name: string;
  readonly tagText: readonly string[];
  /** Null when the tag names no brand of the kit: no offline read. */
  readonly read: OfflineScanRead | null;
}

export const OFFLINE_CALL_CASES: readonly OfflineCallCase[] = [
  {
    name: 'a brand on the first line whose low end pays out the amount is a Buy',
    tagText: ['LULULEMON', 'Size 6', 'RN 123456'],
    read: {
      brand: 'Lululemon',
      brandKey: 'lululemon',
      call: 'buy',
      confidence: 'medium',
      basis: 'own_history',
      lowCents: 2500,
      highCents: 3400,
      conservativePayoutCents: 2210,
      optimisticPayoutCents: 3010,
      payoutMarketplace: 'depop',
      basedOn: 'Your 5 Lululemon sales',
      unsoldCount: 2,
    },
  },
  {
    name: 'a brand whose high end pays out under the amount is a Skip, read mid-line',
    tagText: ['100% cotton', 'Made for Old Navy'],
    read: {
      brand: 'Old Navy',
      brandKey: 'old navy',
      call: 'skip',
      confidence: 'medium',
      basis: 'own_history',
      lowCents: 600,
      highCents: 900,
      conservativePayoutCents: 480,
      optimisticPayoutCents: 760,
      payoutMarketplace: 'depop',
      basedOn: 'Your 4 Old Navy sales',
      unsoldCount: 0,
    },
  },
  {
    name: 'a range across the amount is Your call',
    tagText: ['Patagonia', 'Synchilla'],
    read: {
      brand: 'Patagonia',
      brandKey: 'patagonia',
      call: 'your_call',
      confidence: 'medium',
      basis: 'own_history',
      lowCents: 900,
      highCents: 4000,
      conservativePayoutCents: 700,
      optimisticPayoutCents: 3500,
      payoutMarketplace: 'depop',
      basedOn: 'Your 3 Patagonia sales',
      unsoldCount: 0,
    },
  },
  {
    name: 'too few sales of the brand give no range',
    tagText: ['Levi Strauss & Co.', 'W32 L30'],
    read: {
      brand: "Levi's",
      brandKey: 'levi',
      call: 'your_call',
      confidence: 'low',
      basis: 'none',
      basedOn: "Not enough of your Levi's sales to go on",
      unsoldCount: 3,
    },
  },
  {
    name: 'punctuation and a plural are dropped from the brand',
    tagText: ["LEVI'S®"],
    read: {
      brand: "Levi's",
      brandKey: 'levi',
      call: 'your_call',
      confidence: 'low',
      basis: 'none',
      basedOn: "Not enough of your Levi's sales to go on",
      unsoldCount: 3,
    },
  },
  {
    name: "eBay's sales never feed the call",
    tagText: ['COACH', 'NO. G1234-5678'],
    read: {
      brand: 'Coach',
      brandKey: 'coach',
      call: 'your_call',
      confidence: 'low',
      basis: 'none',
      basedOn: 'Not enough of your Coach sales to go on',
      unsoldCount: 0,
    },
  },
  {
    name: 'accents and case do not matter; the payouts are after the main marketplace',
    tagText: ['ÉTOILE ISABEL MARANT'],
    read: {
      brand: 'Étoile Isabel Marant',
      brandKey: 'etoile',
      call: 'buy',
      confidence: 'medium',
      basis: 'own_history',
      lowCents: 4500,
      highCents: 6000,
      conservativePayoutCents: 3600,
      optimisticPayoutCents: 4800,
      payoutMarketplace: 'poshmark',
      basedOn: 'Your 3 Étoile Isabel Marant sales',
      unsoldCount: 0,
    },
  },
  {
    name: 'a common leading word names a brand only with its second word',
    tagText: ['Free People', 'M'],
    read: {
      brand: 'Free People',
      brandKey: 'free people',
      call: 'buy',
      confidence: 'medium',
      basis: 'own_history',
      lowCents: 1800,
      highCents: 2600,
      conservativePayoutCents: 1580,
      optimisticPayoutCents: 2290,
      payoutMarketplace: 'depop',
      basedOn: 'Your 4 Free People sales',
      unsoldCount: 1,
    },
  },
  {
    name: 'a common leading word alone names no brand',
    tagText: ['TAX FREE', 'Made in USA'],
    read: null,
  },
  {
    name: 'the first line that names a brand wins',
    tagText: ['Old Navy', 'Lululemon'],
    read: {
      brand: 'Old Navy',
      brandKey: 'old navy',
      call: 'skip',
      confidence: 'medium',
      basis: 'own_history',
      lowCents: 600,
      highCents: 900,
      conservativePayoutCents: 480,
      optimisticPayoutCents: 760,
      payoutMarketplace: 'depop',
      basedOn: 'Your 4 Old Navy sales',
      unsoldCount: 0,
    },
  },
  {
    name: 'a tag naming no brand of the kit has no offline read',
    tagText: ['Made in China', '100% polyester', 'Machine wash cold'],
    read: null,
  },
  { name: 'no tag text has no offline read', tagText: [], read: null },
];

/**
 * Brands whose match keys the iPhone's `brandKey` must give exactly as `brandKey` here does; the
 * test writes each with its key.
 */
export const BRAND_KEY_SAMPLES: readonly string[] = [
  "Levi's",
  'LEVI',
  "LEVI'S®",
  'Levi Strauss & Co.',
  'Abercrombie & Fitch',
  'Abercrombie',
  'American Eagle Outfitters',
  'American Apparel',
  'Hollister Co.',
  'Old Navy',
  'Old Money',
  'Free People',
  'FREE',
  'J.Crew',
  'Étoile Isabel Marant',
  'Lands’ End',
  'The North Face',
  'Banana Republic',
  'Polo Ralph Lauren',
  'Nike',
  'Dr. Martens',
  'H&M',
  'Coach',
  'Gap',
  'Zara',
  '  ',
  '100% cotton',
];
