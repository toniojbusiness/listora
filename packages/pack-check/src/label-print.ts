/**
 * Printing an order's shipping label with its item stickers (docs/features/pack-check.md,
 * "Printing the label"). The phone downloads the label's file through the seller's own session
 * on the marketplace and prints it with the order's stickers in one job, so the label and the
 * stickers printed together are always the same order's. Listora's server never fetches or keeps
 * the file (it shows the buyer's name and address): it only says where the marketplace offers it
 * (`sale_label.label_file_url`, from the label read) and records each print, so printing the
 * same label again warns first. Where Listora can't print a marketplace's label, the order's page
 * on the marketplace opens instead (`labelPageUrl`).
 *
 * Nothing here touches a marketplace.
 */
import type { DbTransaction, Marketplace } from '@listora/db';
import { assertNever } from '@listora/shared';

import { OPEN_SALE_STATUSES } from './orders.ts';
import { PackOrderNotFoundError } from './scan.ts';
import { canonicalTracking } from './tracking.ts';

/** The order has no label Listora knows, or another one than the screen printed. */
export class LabelChangedError extends Error {
  constructor() {
    super("This order's label changed. Open the order again to print its label.");
    this.name = 'LabelChangedError';
  }
}

/** The order no longer needs a package (shipped, canceled, or returned). */
export class LabelOrderClosedError extends Error {
  constructor() {
    super('This order no longer needs a package.');
    this.name = 'LabelOrderClosedError';
  }
}

/** Listora's prints of the order's label. */
export interface LabelPrintRecord {
  printedAt: Date;
  /** How many times Listora printed this label. */
  count: number;
}

/**
 * Records that the phone printed the order's label (`trackingNumber`, the one it printed): the
 * next print of the same label warns first. The label must still be the order's, under a lock on
 * its row, so a stale screen records nothing. A print of a new label starts the count over.
 */
export async function recordLabelPrint(
  trx: DbTransaction,
  accountId: string,
  input: { saleId: string; trackingNumber: string; now: Date },
): Promise<LabelPrintRecord> {
  const sale = await trx
    .selectFrom('sale')
    .select('status')
    .where('account_id', '=', accountId)
    .where('id', '=', input.saleId)
    .executeTakeFirst();
  if (sale === undefined) throw new PackOrderNotFoundError();
  if (!(OPEN_SALE_STATUSES as readonly string[]).includes(sale.status)) {
    throw new LabelOrderClosedError();
  }
  const label = await trx
    .selectFrom('sale_label')
    .select(['tracking_number', 'printed_tracking_number', 'print_count'])
    .where('account_id', '=', accountId)
    .where('sale_id', '=', input.saleId)
    .forUpdate()
    .executeTakeFirst();
  const printed = canonicalTracking(input.trackingNumber);
  if (printed === null || label?.tracking_number !== printed) throw new LabelChangedError();
  const count = label.printed_tracking_number === printed ? label.print_count + 1 : 1;
  await trx
    .updateTable('sale_label')
    .set({ printed_tracking_number: printed, printed_at: input.now, print_count: count })
    .where('account_id', '=', accountId)
    .where('sale_id', '=', input.saleId)
    .execute();
  return { printedAt: input.now, count };
}

/**
 * The order's own page on the marketplace, where the seller prints its label themselves when
 * Listora can't download it: the marketplace hasn't named the label's file, or getting it there
 * is not only a read (Mercari makes the label when it is printed; eBay sells it).
 */
export function labelPageUrl(marketplace: Marketplace, externalOrderId: string | null): string {
  const id = externalOrderId === null ? null : encodeURIComponent(externalOrderId);
  switch (marketplace) {
    case 'depop':
      return 'https://www.depop.com/sellinghub/sold-items/';
    case 'poshmark':
      // A sale Listora knows only by its listing (`listing:<id>`) opens the list of sales.
      return id === null || externalOrderId?.startsWith('listing:') === true
        ? 'https://poshmark.com/order/sales'
        : `https://poshmark.com/order/sales/${id}`;
    case 'mercari':
      // A Mercari order is named by its item's id.
      return id === null
        ? 'https://www.mercari.com/mypage/listings/in_progress/'
        : `https://www.mercari.com/transaction/order_status/${id}/`;
    case 'ebay':
      return id === null
        ? 'https://www.ebay.com/sh/ord'
        : `https://www.ebay.com/sh/ord/details?orderid=${id}`;
    default:
      return assertNever(marketplace, 'marketplace');
  }
}
