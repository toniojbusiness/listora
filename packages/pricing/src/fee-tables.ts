/**
 * Versioned US seller-fee tables. A fee change never rewrites history: add a new table with a
 * new version and `effectiveFrom` day, keep the old one, and every floor records the version
 * it was computed with. A table can be added before its day; it is used from that day on.
 *
 * Each estimate is for the item price alone. It leaves out fees charged on buyer-paid shipping
 * and sales tax, optional upgrades (promoted or boosted listings), and payout fees, so actual
 * fees on an order can be higher; `fee_line` rows with `source = 'actual'` replace it there.
 */
import type { KnownMarketplace } from '@listora/api-contract';

import type { FeeTable } from './fees.ts';

/**
 * eBay "most categories" for sellers without an eBay Store (Clothing, Shoes & Accessories
 * included, except Women's Bags & Handbags). Verified on 2026-10-24: "13.6% on total amount of
 * the sale up to $7,500 calculated per item, 2.35% on the portion of the sale over $7,500",
 * plus a per-order fee: "For orders $10.00 or less the per order fee is $0.30, for orders over
 * $10.00 the per order fee is $0.40." This is Listora's estimate from eBay's public fee page,
 * not eBay API content; actual fees from eBay order data are never used to compute a price
 * (see `ORDER_DATA_MAY_ADJUST_FEES`).
 */
const EBAY_2026_10_24: FeeTable = {
  marketplace: 'ebay',
  version: 'ebay-us-2026-10-24',
  effectiveFrom: '2026-10-24',
  sourceUrl: 'https://www.ebay.com/help/selling/fees-credits-invoices/selling-fees?id=4364',
  verifiedOn: '2026-10-24',
  verified: true,
  notes:
    'Most categories, no eBay Store. Category-specific rates (for example handbags and ' +
    'sneakers) and Store discounts are not applied. eBay charges the final value fee on the ' +
    'total amount of the sale, including shipping and sales tax; this estimate uses the item ' +
    'price. Effective day: the day this schedule was verified.',
  rules: [
    {
      name: 'Final value fee',
      kind: 'marketplace',
      bands: [
        { fromCents: 0, fixedCents: 0, basisPoints: 1360 },
        // Over $7,500: 13.6% of the first $7,500 ($1,020.00) plus 2.35% of the rest.
        { fromCents: 750_001, fixedCents: 102_000, basisPoints: 235, marginalFromCents: 750_000 },
      ],
    },
    {
      name: 'Per-order fee',
      kind: 'marketplace',
      bands: [
        { fromCents: 0, fixedCents: 30, basisPoints: 0 },
        { fromCents: 1_001, fixedCents: 40, basisPoints: 0 },
      ],
    },
  ],
};

/**
 * Depop US. Depop's Selling API documentation (verified on 2026-10-24) says "Depop charges
 * UK/US buyers for the depop fee. Sellers will have to pay a transaction fee, and boosting fee
 * when applicable", and points to the Help Centre page "Seller fees and charges" for the rates.
 * That page sits behind a bot check Listora does not get around, so the 3.3% + $0.45
 * transaction fee is unverified. Depop's orders API returns each order's actual fee breakdown,
 * which replaces this estimate once the account has sales.
 */
const DEPOP_2026_10_24: FeeTable = {
  marketplace: 'depop',
  version: 'depop-us-2026-10-24',
  effectiveFrom: '2026-10-24',
  sourceUrl: 'https://partnerapi.depop.com/api-docs/concepts/fees/',
  verifiedOn: '2026-10-24',
  verified: false,
  notes:
    'No selling fee for US sellers (buyers pay the Depop fee). The transaction fee rate is ' +
    'unverified. Boosting fees are optional and not included. Effective day: the day this ' +
    'schedule was checked.',
  rules: [
    {
      name: 'Transaction fee',
      kind: 'payment',
      bands: [{ fromCents: 0, fixedCents: 45, basisPoints: 330 }],
    },
  ],
};

/**
 * Poshmark US. Verified on 2026-10-24: "For sales under $15, Poshmark takes a flat commission
 * of $2.95" and "For sales of $15 or more, you keep 80% of the sale, and Poshmark takes a 20%
 * commission."
 */
const POSHMARK_2026_10_24: FeeTable = {
  marketplace: 'poshmark',
  version: 'poshmark-us-2026-10-24',
  effectiveFrom: '2026-10-24',
  sourceUrl: 'https://support.poshmark.com/s/article/297755057',
  verifiedOn: '2026-10-24',
  verified: true,
  notes:
    'Since 2025-10-01 sellers located in Texas also pay a Texas Seller Fee Tax, which is not ' +
    'included. Effective day: the day this schedule was verified.',
  rules: [
    {
      name: 'Commission',
      kind: 'marketplace',
      bands: [
        { fromCents: 0, fixedCents: 295, basisPoints: 0 },
        { fromCents: 1_500, fixedCents: 0, basisPoints: 2000 },
      ],
    },
  ],
};

/**
 * Mercari US. Verified on 2026-10-24: "Effective January 6, 2025, a 10% selling fee will apply
 * to item price and buyer-paid shipping for new and updated listings", with "No separate
 * payment processing fee" (the buyer pays a 3.6% Buyer Protection fee).
 */
const MERCARI_2025_01_06: FeeTable = {
  marketplace: 'mercari',
  version: 'mercari-us-2025-01-06',
  effectiveFrom: '2025-01-06',
  sourceUrl: 'https://www.mercari.com/us/help_center/article/169/',
  verifiedOn: '2026-10-24',
  verified: true,
  notes:
    'Mercari also charges the 10% on buyer-paid shipping, which this estimate leaves out. ' +
    'Instant Pay ($3 per cash-out) is a payout fee and is not included.',
  rules: [
    {
      name: 'Selling fee',
      kind: 'marketplace',
      bands: [{ fromCents: 0, fixedCents: 0, basisPoints: 1000 }],
    },
  ],
};

/** Every table, current and past. */
export const FEE_TABLES: readonly FeeTable[] = [
  EBAY_2026_10_24,
  DEPOP_2026_10_24,
  POSHMARK_2026_10_24,
  MERCARI_2025_01_06,
];

/** The table in effect for `marketplace` on `at` (UTC): the latest whose day has come. */
export function feeTableFor(marketplace: KnownMarketplace, at: Date): FeeTable {
  const day = at.toISOString().slice(0, 10);
  const table = FEE_TABLES.filter(
    (candidate) => candidate.marketplace === marketplace && candidate.effectiveFrom <= day,
  ).reduce<FeeTable | undefined>(
    (latest, candidate) =>
      latest === undefined || candidate.effectiveFrom > latest.effectiveFrom ? candidate : latest,
    undefined,
  );
  // The first table of every marketplace starts no later than the day this code shipped.
  if (!table) throw new Error(`no ${marketplace} fee table is in effect on ${day}`);
  return table;
}

export function feeTableByVersion(version: string): FeeTable | undefined {
  return FEE_TABLES.find((table) => table.version === version);
}
