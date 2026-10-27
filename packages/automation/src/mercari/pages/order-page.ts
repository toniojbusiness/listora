/**
 * A sale's order page (`/transaction/order_status/<item id>/`, the sold tab's "View order"), for
 * Pack check's label reads (docs/features/pack-check.md, "Reading labels").
 *
 * Read on the captain's account (2026-10-27, its one sale, delivered and complete): the page is
 * drawn after load; its order summary (`OrderSummary`) names the item, and its buyer block
 * (`UserInfoAndChat`) the buyer, by the name they gave Mercari (`UserNameLink`). The shipping
 * block shows the carrier and class (`CarrierBlock`) and a "View tracking" link to the help
 * center's tracking page (`/us/help_center/tracking/<item id>`), whose data, for a delivered
 * order, holds no tracking number (`deliveryDetails.showTracking: false`). Neither page showed a
 * tracking number for that order. So the label is read only where the shipping block shows a
 * "Tracking" line with a number, and otherwise reported as not there yet: never guessed.
 *
 * Only reads.
 */
import type { PageDriver } from '../../runner/types.ts';
import { awaitElement, absolute, type MercariSite } from './common.ts';

export const ORDER_PAGE = {
  summary: '[data-testid="OrderSummary"]',
  buyer: '[data-testid="UserInfoAndChat"] [data-testid="UserNameLink"]',
  shipping: '[data-testid="CarrierBlock"], [data-testid="ShippingCTA"], [data-testid*="Tracking"]',
  notFound: '[data-testid="NotFound"]',
} as const;

const PAGE = 'order page';

/** "Tracking number 9400 1118 ..." or "Tracking #: 1Z...": the number after the word. */
const TRACKING_LINE =
  /tracking(?:\s*(?:number|no\.?|#))?\s*[:#]?\s*([A-Z0-9][A-Z0-9 -]{8,48}[A-Z0-9])/i;

export interface OrderRead {
  found: boolean;
  buyerName: string | null;
  trackingNumber: string | null;
}

export function orderUrl(site: MercariSite, itemId: string): string {
  return absolute(site, `/transaction/order_status/${encodeURIComponent(itemId)}/`);
}

/** Opens the order page of the item's sale and reads its buyer and label. */
export async function readOrder(
  page: PageDriver,
  site: MercariSite,
  itemId: string,
): Promise<OrderRead> {
  await page.goto(orderUrl(site, itemId));
  if (page.status() === 404 || (await page.exists(ORDER_PAGE.notFound))) {
    return { found: false, buyerName: null, trackingNumber: null };
  }
  await awaitElement(page, ORDER_PAGE.summary, PAGE, 'order summary');
  const buyer = (await page.text(ORDER_PAGE.buyer))?.trim() ?? null;
  const shipping = await page.texts(ORDER_PAGE.shipping);
  return {
    found: true,
    buyerName: buyer === '' ? null : buyer,
    trackingNumber: trackingIn(shipping),
  };
}

/** The tracking number a shipping block's "Tracking" line shows, if any. */
export function trackingIn(texts: readonly string[]): string | null {
  for (const text of texts) {
    const match = TRACKING_LINE.exec(text);
    const number = match?.[1]?.replaceAll(/[\s-]/g, '');
    if (number !== undefined && /\d/.test(number) && number.length >= 10) return number;
  }
  return null;
}
