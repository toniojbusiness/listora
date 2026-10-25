/**
 * The SKU line: how the automation scripts of a marketplace without a seller SKU field (Mercari,
 * Depop) find a listing whose id Listora never learned. The scripts end the listing's own text
 * with a line naming the listing's SKU (`SKU: AJ-000184`), and a later attempt or a read-back
 * looks for that line among the seller's newest listings, so a create the marketplace already
 * took (its answer lost to a timeout) is never posted twice. Reads strip the line again, so the
 * description Listora verifies is the listing's own (docs/features/mercari.md, "Finding a listing
 * again").
 */
import type { ListingRef } from '@listora/marketplaces';

/** The line the scripts end a listing's text with. */
export function skuLine(sku: string): string {
  return `SKU: ${sku}`;
}

/** The SKU the scripts write and look for: the listing's external SKU, else its Listora id. */
export function listingSku(ref: ListingRef): string {
  return ref.externalSku ?? ref.listingId;
}

/** Room the SKU line takes at the end of a description (a blank line, `SKU: `, 64 characters). */
export const SKU_LINE_RESERVE = '\n\n'.length + skuLine('').length + 64;

/** The description with its SKU line, as the scripts type it. */
export function withSkuLine(description: string, sku: string): string {
  return `${description}\n\n${skuLine(sku)}`;
}

/**
 * A description as a listing page shows it, split into the seller's text and the SKU its last
 * line names (`null` when it has none).
 */
export function splitSkuLine(shown: string): { description: string; sku: string | null } {
  const match = /\r?\n(?:\r?\n)?SKU: (\S{1,64})\s*$/.exec(shown);
  if (match?.[1] === undefined) return { description: shown.trim(), sku: null };
  return { description: shown.slice(0, match.index).trim(), sku: match[1] };
}
