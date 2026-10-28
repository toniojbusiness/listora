/**
 * Packing an order (docs/features/pack-check.md, "Packing"): the seller taps Packed once the
 * scan said the label is this order's, and Listora records which label went on the package.
 * The check runs again inside the transaction, under a lock on the sale, so two phones packing
 * at once, or a stale screen, can never pack a label twice or the wrong label: a label is packed
 * once (`sale_pack`'s unique tracking number), an order once.
 *
 * A label Listora doesn't know (no order page read gave its tracking number) is packed only
 * after the seller's photo check (`photoCheck`): the scan then becomes the order's label
 * (`source` `scan`), so a second print of it is caught like any other.
 *
 * Nothing here touches a marketplace: Pack check only reads them.
 */
import type { DbExecutor, DbTransaction } from '@listora/db';

import { checkScan, PackOrderNotFoundError, type ScanInput } from './scan.ts';
import { stickerSku } from './sticker.ts';
import { carrierOf } from './tracking.ts';
import type { ScanVerdict } from './verdict.ts';

export interface PackInput extends ScanInput {
  saleId: string;
  label: string;
  /** The seller compared the item with the order's photo and says the label is this order's. */
  photoCheck?: boolean | undefined;
  userId: string;
}

/** Packing was refused: the verdict says why (the scan's own words explain it). */
export class PackRefusedError extends Error {
  readonly verdict: ScanVerdict;

  constructor(verdict: ScanVerdict) {
    super(`packing refused: ${verdict.verdict}`);
    this.name = 'PackRefusedError';
    this.verdict = verdict;
  }
}

/** The order is not one that still needs a package (shipped, canceled, or returned). */
export class PackOrderClosedError extends Error {
  constructor() {
    super('This order no longer needs a package.');
    this.name = 'PackOrderClosedError';
  }
}

/** The order is packed already, with another label. */
export class PackOrderPackedError extends Error {
  constructor() {
    super('This order is already packed. Unpack it first to pack it again.');
    this.name = 'PackOrderPackedError';
  }
}

/** Records the order as packed with the scanned label; throws when the scan doesn't allow it. */
export async function packOrder(
  trx: DbTransaction,
  accountId: string,
  input: PackInput,
): Promise<void> {
  const sale = await trx
    .selectFrom('sale')
    .select(['id', 'status'])
    .where('account_id', '=', accountId)
    .where('id', '=', input.saleId)
    .forUpdate()
    .executeTakeFirst();
  if (sale === undefined) throw new PackOrderNotFoundError();
  if (sale.status !== 'detected' && sale.status !== 'confirmed') throw new PackOrderClosedError();
  const checked = await checkScan(trx, accountId, input);
  const { verdict, trackingNumber } = checked;
  if (verdict.verdict === 'already_packed' && verdict.packed.order.saleId === input.saleId) {
    throw new PackOrderPackedError();
  }
  const existing = await trx
    .selectFrom('sale_pack')
    .select('sale_id')
    .where('account_id', '=', accountId)
    .where('sale_id', '=', input.saleId)
    .executeTakeFirst();
  if (existing !== undefined) throw new PackOrderPackedError();

  if (verdict.verdict === 'match' && trackingNumber !== null) {
    // The order's own number, so a later scan of the same label in any barcode finds it.
    const own = checked.orders.get(input.saleId)?.label?.trackingNumber ?? trackingNumber;
    const sku = verdict.matchedBy === 'sticker' ? stickerSku(input.sticker ?? '') : null;
    await insertPack(trx, accountId, input, own, sku === null ? 'label' : 'sticker', sku);
    return;
  }
  if (verdict.verdict === 'unknown_label' && trackingNumber !== null && input.photoCheck === true) {
    await trx
      .insertInto('sale_label')
      .values({
        account_id: accountId,
        sale_id: input.saleId,
        tracking_number: trackingNumber,
        carrier: carrierOf(trackingNumber),
        source: 'scan',
      })
      .onConflict((conflict) =>
        conflict.columns(['account_id', 'sale_id']).doUpdateSet({
          tracking_number: trackingNumber,
          carrier: carrierOf(trackingNumber),
          source: 'scan',
        }),
      )
      .execute();
    await insertPack(trx, accountId, input, trackingNumber, 'photo', null);
    return;
  }
  throw new PackRefusedError(verdict);
}

async function insertPack(
  trx: DbTransaction,
  accountId: string,
  input: PackInput,
  trackingNumber: string,
  matchedBy: 'sticker' | 'label' | 'photo',
  stickerSku: string | null,
): Promise<void> {
  await trx
    .insertInto('sale_pack')
    .values({
      account_id: accountId,
      sale_id: input.saleId,
      tracking_number: trackingNumber,
      matched_by: matchedBy,
      sticker_sku: stickerSku,
      packed_by_user_id: input.userId,
    })
    .execute();
}

/**
 * Takes the order off its package (to pack it again): the record and its photo go. Returns the
 * photo's storage key, to delete once the transaction commits; `null` when it had none, and
 * `undefined` when the order was not packed.
 */
export async function unpackOrder(
  trx: DbTransaction,
  accountId: string,
  saleId: string,
): Promise<{ photoKey: string | null } | undefined> {
  const removed = await trx
    .deleteFrom('sale_pack')
    .where('account_id', '=', accountId)
    .where('sale_id', '=', saleId)
    .returning('photo_key')
    .executeTakeFirst();
  return removed === undefined ? undefined : { photoKey: removed.photo_key };
}

/**
 * Saves the package photo of a packed order that has none yet: `saved`, `not_packed`, or
 * `has_photo` (the seller removes it first to take another).
 */
export async function savePackPhoto(
  trx: DbTransaction,
  accountId: string,
  saleId: string,
  photoKey: string,
): Promise<'saved' | 'not_packed' | 'has_photo'> {
  const before = await trx
    .selectFrom('sale_pack')
    .select('photo_key')
    .where('account_id', '=', accountId)
    .where('sale_id', '=', saleId)
    .forUpdate()
    .executeTakeFirst();
  if (before === undefined) return 'not_packed';
  if (before.photo_key !== null) return 'has_photo';
  await trx
    .updateTable('sale_pack')
    .set({ photo_key: photoKey, photo_added_at: new Date() })
    .where('account_id', '=', accountId)
    .where('sale_id', '=', saleId)
    .execute();
  return 'saved';
}

/** Removes the package photo; returns its key, to delete once committed, or `undefined`. */
export async function removePackPhoto(
  executor: DbExecutor,
  accountId: string,
  saleId: string,
): Promise<string | undefined> {
  const before = await executor
    .selectFrom('sale_pack')
    .select('photo_key')
    .where('account_id', '=', accountId)
    .where('sale_id', '=', saleId)
    .where('photo_key', 'is not', null)
    .executeTakeFirst();
  if (before === undefined || before.photo_key === null) return undefined;
  const updated = await executor
    .updateTable('sale_pack')
    .set({ photo_key: null, photo_added_at: null })
    .where('account_id', '=', accountId)
    .where('sale_id', '=', saleId)
    .where('photo_key', '=', before.photo_key)
    .executeTakeFirst();
  return updated.numUpdatedRows === 0n ? undefined : before.photo_key;
}
