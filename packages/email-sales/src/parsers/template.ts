/**
 * The deterministic parser every marketplace's sold email goes through. Each marketplace
 * describes its template (parsers/<marketplace>.ts): which subjects announce a sale, and the
 * labels its body puts before the item's title, price, and order number. The listing id comes
 * from a link to the listing (`parseListingUrl`), the SKU from Listora's own SKU anywhere in the
 * text. A sale needs a price and something to match it by (a listing id, a SKU, or a title);
 * a sold notice without them is an unknown format, which becomes a review task and never
 * delists anything.
 */
import { parseListingUrl } from '@listora/shared';

import type { MailMessage } from '../message.ts';
import type { EmailSaleMarketplace } from '../senders.ts';

export interface ParsedSale {
  /** The marketplace's order number, when the email shows one. */
  orderNumber: string | null;
  /** The marketplace's listing id, from a link to the listing. */
  externalListingId: string | null;
  /** A Listora SKU (`AJ-000184`) in the email's text. */
  sku: string | null;
  title: string | null;
  /** What the item sold for, in cents; the marketplace's currency is USD. */
  priceCents: number;
}

export type SaleEmailParse =
  | { type: 'sale'; sale: ParsedSale }
  /** A marketplace email that announces no sale (an offer, a like, a newsletter). */
  | { type: 'not_a_sale' }
  /** It announces a sale, but not in a form Listora reads. */
  | { type: 'unknown_format'; reason: string };

export interface SaleEmailTemplate {
  marketplace: EmailSaleMarketplace;
  /** Subjects of the marketplace's sold notices. */
  soldSubject: RegExp;
  /** The labels before each value, as a line's start (`Item:`) or a line of their own. */
  labels: { title: RegExp; price: RegExp; orderNumber: RegExp };
}

const SKU = /\b[A-Z]{2,4}-\d{6}\b/;
const MONEY = /\$\s?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?)\b/;

export function parseWithTemplate(
  template: SaleEmailTemplate,
  message: MailMessage,
): SaleEmailParse {
  if (!template.soldSubject.test(message.subject)) return { type: 'not_a_sale' };
  const lines = message.text.split('\n').map((line) => line.trim());
  const priceText = labeled(lines, template.labels.price);
  const priceCents = priceText === null ? null : cents(priceText);
  const title = labeled(lines, template.labels.title);
  const externalListingId = listingIdOf(template.marketplace, message.links);
  const sku = SKU.exec(message.text)?.[0] ?? null;
  const orderNumber = labeled(lines, template.labels.orderNumber);

  if (priceCents === null)
    return { type: 'unknown_format', reason: 'It shows no price Listora can read.' };
  if (externalListingId === null && sku === null && title === null) {
    return { type: 'unknown_format', reason: 'It names no listing Listora can read.' };
  }
  return {
    type: 'sale',
    sale: {
      orderNumber: orderNumber !== null && /^[\w-]{1,64}$/.test(orderNumber) ? orderNumber : null,
      externalListingId,
      sku,
      title: title === null ? null : title.slice(0, 200),
      priceCents,
    },
  };
}

/**
 * The value after a label: on the label's line (`Price: $45.00`, `Order #123`) or, when the
 * label is a line of its own, the next non-empty line. A label must end at the colon, so `Item`
 * never reads the line `Item price: $30.00`.
 */
function labeled(lines: readonly string[], label: RegExp): string | null {
  const inline = new RegExp(`^(?:${label.source})\\s*[:#]\\s*(.+)$`, 'i');
  const alone = new RegExp(`^(?:${label.source})\\s*:?$`, 'i');
  for (const [index, line] of lines.entries()) {
    const value = inline
      .exec(line)?.[1]
      ?.replace(/^[#:\s]+/, '')
      .trim();
    if (value !== undefined && value !== '') return value;
    if (!alone.test(line)) continue;
    const next = lines.slice(index + 1).find((candidate) => candidate !== '');
    if (next !== undefined) return next;
  }
  return null;
}

function cents(text: string): number | null {
  const amount = MONEY.exec(text)?.[1];
  if (amount === undefined) return null;
  const [dollars = '0', fraction = '00'] = amount.replace(/,/g, '').split('.');
  const value = Number(dollars) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** The listing the email links to on its own marketplace; none, or two different ones, is null. */
function listingIdOf(marketplace: EmailSaleMarketplace, links: readonly string[]): string | null {
  const ids = new Set<string>();
  for (const link of links) {
    const parsed = parseListingUrl(link);
    if (
      parsed.kind === 'listing' &&
      parsed.marketplace === marketplace &&
      parsed.listingId !== null
    ) {
      ids.add(parsed.listingId);
    }
  }
  return ids.size === 1 ? ([...ids][0] ?? null) : null;
}
