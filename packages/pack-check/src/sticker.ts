/**
 * Item stickers (docs/features/pack-check.md, "Item stickers"): a small sticker on the item's
 * bag with a QR code, its SKU, and its shelf. The QR code holds `LISTORA:<SKU>`, so a scan can
 * tell a sticker from a shipping label; the SKU printed under it is a Code 128 barcode of the
 * SKU alone, which a scan also accepts.
 */

/** What a sticker's QR code holds before the SKU. */
export const STICKER_PREFIX = 'LISTORA:';

/** A Listora SKU (`formatSku` in @listora/db): 2 to 4 capital letters, a dash, 6 digits. */
const SKU = /^[A-Z]{2,4}-\d{6}$/;

/** The text a sticker's QR code holds for `sku`. */
export function stickerCode(sku: string): string {
  if (!SKU.test(sku)) throw new RangeError(`not a Listora SKU: ${sku}`);
  return `${STICKER_PREFIX}${sku}`;
}

/** The SKU a scanned sticker names, or `null` when the code is not a Listora sticker. */
export function stickerSku(scanned: string): string | null {
  const text = scanned.trim().toUpperCase();
  const sku = text.startsWith(STICKER_PREFIX) ? text.slice(STICKER_PREFIX.length) : text;
  return SKU.test(sku) ? sku : null;
}
