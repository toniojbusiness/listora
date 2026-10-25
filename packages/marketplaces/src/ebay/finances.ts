/**
 * An order's actual fees from eBay's Finances API (`getTransactions` filtered by order id, on
 * `apiz.ebay.com`, scope `sell.finances`). eBay records a `SALE` transaction for each order, with
 * each line item's `marketplaceFees` (the final value fee, the per-order fee, and so on); a
 * shipping label bought on eBay is a `SHIPPING_LABEL` transaction, and a Promoted Listings fee a
 * `NON_SALE_CHARGE` with fee type `AD_FEE`. Listora keeps only the fee amounts and their types:
 * no buyer, no payout details.
 *
 * Fee data from eBay is shown on the seller's own sales; it never sets a price
 * (docs/features/pricing.md, `ORDER_DATA_MAY_ADJUST_FEES`).
 */
import type { FeeKind } from '@listora/db';

import type { OrderFee } from '../adapter.ts';
import { rest, type EbayAmount, type RestRequestOptions, type RestResult } from './rest.ts';

/** One Finances API transaction, as far as Listora reads it. */
export interface EbayFinanceTransaction {
  transactionType: string;
  /** `CREDIT` (money to the seller) or `DEBIT` (money from the seller). */
  bookingEntry: string;
  amount: EbayAmount | null;
  /** The fee type of a `NON_SALE_CHARGE` (for example `AD_FEE`). */
  feeType: string | null;
  fees: { feeType: string; amount: EbayAmount }[];
}

/** The seller's Finances transactions for one order (`filter=orderId:{...}`). */
export function getOrderTransactions(
  financesHost: string,
  orderId: string,
  options: RestRequestOptions,
): Promise<RestResult<EbayFinanceTransaction[]>> {
  const params = new URLSearchParams({ filter: `orderId:{${orderId}}`, limit: '200' });
  return rest(
    'GET',
    `${financesHost}/sell/finances/v1/transaction?${params.toString()}`,
    options,
    (body) => {
      const transactions = (body as { transactions?: unknown } | null)?.transactions;
      // eBay leaves `transactions` out when there are none.
      if (transactions === undefined) return [];
      return Array.isArray(transactions) ? transactions.map(readTransaction) : undefined;
    },
  );
}

function readTransaction(entry: unknown): EbayFinanceTransaction {
  const transaction = (entry ?? {}) as Record<string, unknown>;
  const lines = Array.isArray(transaction['orderLineItems'])
    ? (transaction['orderLineItems'] as unknown[])
    : [];
  const fees = lines.flatMap((line) => {
    const lineFees = (line as { marketplaceFees?: unknown } | null)?.marketplaceFees;
    if (!Array.isArray(lineFees)) return [];
    return lineFees.flatMap((fee: unknown) => {
      const { feeType, amount } = (fee ?? {}) as Record<string, unknown>;
      const value = amountOf(amount);
      return typeof feeType === 'string' && value !== null ? [{ feeType, amount: value }] : [];
    });
  });
  return {
    transactionType: stringOr(transaction['transactionType'], ''),
    bookingEntry: stringOr(transaction['bookingEntry'], ''),
    amount: amountOf(transaction['amount']),
    feeType: typeof transaction['feeType'] === 'string' ? transaction['feeType'] : null,
    fees,
  };
}

/**
 * The fees in an order's transactions, or `null` when eBay has not recorded the sale yet (no
 * `SALE` transaction) or an amount is not in US dollars. Zero amounts are left out. A debit
 * is a fee the seller pays (positive); a credit of a fee (a refund) is negative.
 */
export function orderFeesFrom(
  transactions: readonly EbayFinanceTransaction[],
): { type: 'fees'; fees: OrderFee[] } | { type: 'not_yet' } | { type: 'not_usd' } {
  if (!transactions.some((transaction) => transaction.transactionType === 'SALE')) {
    return { type: 'not_yet' };
  }
  const fees: OrderFee[] = [];
  for (const transaction of transactions) {
    switch (transaction.transactionType) {
      case 'SALE':
        for (const fee of transaction.fees) {
          const cents = usdCentsSigned(fee.amount);
          if (cents === null) return { type: 'not_usd' };
          if (cents === 0) continue;
          fees.push({
            kind: saleFeeKind(fee.feeType),
            description: feeDescription(fee.feeType),
            amountCents: cents,
            currency: 'USD',
          });
        }
        break;
      case 'SHIPPING_LABEL':
      case 'NON_SALE_CHARGE': {
        if (transaction.amount === null) continue;
        const cents = usdCentsSigned(transaction.amount);
        if (cents === null) return { type: 'not_usd' };
        if (cents === 0) continue;
        const label = transaction.transactionType === 'SHIPPING_LABEL';
        fees.push({
          kind: label ? 'shipping_label' : saleFeeKind(transaction.feeType ?? ''),
          description: label ? 'Shipping label' : feeDescription(transaction.feeType ?? 'OTHER'),
          // A debit is what the seller pays; a credit gives it back.
          amountCents: transaction.bookingEntry === 'CREDIT' ? -cents : cents,
          currency: 'USD',
        });
        break;
      }
      default:
        // Refunds, disputes, transfers, and payouts move money but are not fees.
        break;
    }
  }
  return { type: 'fees', fees };
}

const FEE_DESCRIPTIONS: Record<string, string> = {
  FINAL_VALUE_FEE: 'Final value fee',
  FINAL_VALUE_FEE_FIXED_PER_ORDER: 'Per-order fee',
  AD_FEE: 'Promoted Listings fee',
  INTERNATIONAL_FEE: 'International fee',
  REGULATORY_OPERATING_FEE: 'Regulatory operating fee',
};

function saleFeeKind(feeType: string): FeeKind {
  return feeType === 'AD_FEE' ? 'promotion' : 'marketplace';
}

/** eBay's fee type in words: `FINAL_VALUE_FEE` is "Final value fee". */
export function feeDescription(feeType: string): string {
  const known = FEE_DESCRIPTIONS[feeType];
  if (known !== undefined) return known;
  const words = feeType.toLowerCase().replaceAll('_', ' ').trim();
  return words === ''
    ? 'eBay fee'
    : `${words[0]?.toUpperCase() ?? ''}${words.slice(1)}`.slice(0, 200);
}

/** A US dollar amount in cents, keeping its sign; `null` for another currency or a bad value. */
function usdCentsSigned(amount: EbayAmount): number | null {
  if (amount.currency !== 'USD') return null;
  const match = /^(-?)(\d{1,12})(?:\.(\d{1,2}))?$/.exec(amount.value);
  if (match === null) return null;
  const cents = Number(match[2]) * 100 + Number((match[3] ?? '0').padEnd(2, '0'));
  return match[1] === '-' ? -cents : cents;
}

function amountOf(value: unknown): EbayAmount | null {
  const amount = (value ?? {}) as { value?: unknown; currency?: unknown };
  return typeof amount.value === 'string' && typeof amount.currency === 'string'
    ? { value: amount.value, currency: amount.currency }
    : null;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}
