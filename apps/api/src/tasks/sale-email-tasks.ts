/**
 * Finishing the tasks a forwarded sale email made (docs/features/email-sales.md). Both end in
 * the sale intake, so the confirmed sale is recorded and delisted everywhere else exactly as if
 * Listora had acted on the email itself:
 *
 * - `confirm_sale` ("ask before auto-delist"): the user confirms the matched item sold, with
 *   optional corrections to its price, time, or order number.
 * - `review_match` (an ambiguous match or an unknown format): the user picks the item, or its
 *   listing, or says none of their items sold (`rejectMatch`), which records nothing.
 *
 * A sale a sale check or another email recorded meanwhile is not recorded twice: the task then
 * points at that sale.
 */
import type { UserTaskCompletion } from '@listora/api-contract';
import type { DbTransaction } from '@listora/db';
import { recordEmailSale, type EmailSaleTaskPayload } from '@listora/email-sales';
import type { AdapterLookup } from '@listora/marketplaces';
import { assertNever } from '@listora/shared';

import { ApiError, validationFailed } from '../errors.ts';
import { marketplaceName } from '../listings/views.ts';
import type { Tenant } from '../tenancy.ts';
import type { TaskRow } from './repository.ts';

/** The sale the task recorded (or found recorded), or null when the user rejected the match. */
export async function finishSaleEmailTask(
  trx: DbTransaction,
  tenant: Tenant,
  task: TaskRow,
  email: EmailSaleTaskPayload,
  completion: UserTaskCompletion,
  adapters: AdapterLookup,
): Promise<string | null> {
  const { marketplace, emailSale } = email;
  let itemId: string;
  let listingId: string | null;
  if (task.kind === 'confirm_sale') {
    if (task.item_id === null) throw new Error(`confirm task ${task.id} has no item`);
    itemId = task.item_id;
    listingId = task.listing_id;
  } else {
    const choice = await chosenItem(trx, tenant, marketplace, completion);
    if (choice === null) return null;
    ({ itemId, listingId } = choice);
  }

  const correction = completion.saleCorrection;
  const priceCents =
    correction?.salePrice?.amountCents ??
    emailSale.priceCents ??
    (await listingPrice(trx, tenant, marketplace, itemId, listingId));
  if (priceCents === null || priceCents <= 0) {
    throw validationFailed(
      [{ field: 'matchedItemId', message: 'has no price to record the sale with' }],
      `The email shows no price and the item has no ${marketplaceName(marketplace)} price. Mark it sold from the item instead.`,
    );
  }
  const soldAt = new Date(correction?.soldAt ?? emailSale.soldAt);
  if (soldAt.getTime() > Date.now()) {
    throw validationFailed([{ field: 'saleCorrection.soldAt', message: 'is in the future' }]);
  }
  const sale = await recordEmailSale(trx, adapters, {
    accountId: tenant.accountId,
    marketplace,
    itemId,
    listingId,
    priceCents,
    soldAt,
    orderNumber: correction?.externalOrderId ?? emailSale.orderNumber,
    inboundEventId: email.inboundEventId,
  });
  switch (sale.type) {
    case 'recorded':
    case 'duplicate':
      return sale.saleId;
    case 'not_listora':
      throw new ApiError('not_found', 'This item no longer exists.');
    default:
      return assertNever(sale, 'sale result');
  }
}

/** The review's choice: the item (and its listing) the user picked, or null for "none of them". */
async function chosenItem(
  trx: DbTransaction,
  tenant: Tenant,
  marketplace: EmailSaleTaskPayload['marketplace'],
  completion: UserTaskCompletion,
): Promise<{ itemId: string; listingId: string | null } | null> {
  const picked =
    completion.matchedItemId !== undefined || completion.matchedListingId !== undefined;
  if (completion.rejectMatch === true && !picked) return null;
  if (picked === (completion.rejectMatch === true) || completion.rejectMatch === false) {
    throw validationFailed(
      [{ field: 'matchedItemId', message: 'pick the item, or set rejectMatch when none matches' }],
      'Pick the item that sold, or say none of them did.',
    );
  }
  if (completion.matchedListingId !== undefined) {
    const listing = await trx
      .selectFrom('marketplace_listing')
      .select(['id', 'item_id'])
      .where('account_id', '=', tenant.accountId)
      .where('id', '=', completion.matchedListingId)
      .where('marketplace', '=', marketplace)
      .executeTakeFirst();
    if (listing === undefined) {
      throw validationFailed([
        {
          field: 'matchedListingId',
          message: `is not one of your ${marketplaceName(marketplace)} listings`,
        },
      ]);
    }
    if (completion.matchedItemId !== undefined && completion.matchedItemId !== listing.item_id) {
      throw validationFailed([
        { field: 'matchedListingId', message: 'is not that item’s listing' },
      ]);
    }
    return { itemId: listing.item_id, listingId: listing.id };
  }
  const itemId = completion.matchedItemId ?? '';
  const item = await trx
    .selectFrom('inventory_item')
    .select('id')
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', itemId)
    .executeTakeFirst();
  if (item === undefined) {
    throw validationFailed([{ field: 'matchedItemId', message: 'is not one of your items' }]);
  }
  return { itemId: item.id, listingId: null };
}

/** The price of the item's listing on the marketplace (the given one, else its newest). */
async function listingPrice(
  trx: DbTransaction,
  tenant: Tenant,
  marketplace: EmailSaleTaskPayload['marketplace'],
  itemId: string,
  listingId: string | null,
): Promise<number | null> {
  let query = trx
    .selectFrom('marketplace_listing')
    .select('price_cents')
    .where('account_id', '=', tenant.accountId)
    .where('marketplace', '=', marketplace)
    .where('item_id', '=', itemId);
  if (listingId !== null) query = query.where('id', '=', listingId);
  const row = await query.orderBy('created_at', 'desc').orderBy('id', 'desc').executeTakeFirst();
  return row?.price_cents ?? null;
}
