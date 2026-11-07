/**
 * How a marketplace has an order shipped, in words for the seller packing it (`PackOrder.
 * shippingNote`), for information only: Listora changes nothing on the marketplace for it.
 *
 * Vinted (docs/features/vinted.md, "Shipping labels and Pack check"): the buyer picks the carrier
 * and the seller ships with it; Vinted cancels an order not shipped within 5 business days, and
 * the seller can ask the buyer in Vinted for 3 or 5 more days. A QR code is shown at the carrier's
 * counter, which prints the label there, so there is nothing to print.
 */
import type { LabelFormat, Marketplace } from '@listora/db';

/** The carriers' names as a seller reads them at the counter. */
const COUNTER_NAMES: Readonly<Record<string, string>> = {
  usps: 'USPS',
  ups: 'UPS',
  fedex: 'FedEx',
  dhl: 'DHL',
  speedx: 'SpeedX',
};

/** The words on how the order ships, or `null` where the marketplace needs none. */
export function shippingNote(
  marketplace: Marketplace,
  label: { carrier: string; format: LabelFormat | null } | null,
): string | null {
  if (marketplace !== 'vinted') return null;
  const deadline =
    "Vinted cancels the order if it isn't shipped within 5 business days. Need more time? Ask the buyer in Vinted for 3 or 5 more days.";
  if (label?.format !== 'qr_code') return deadline;
  const carrier = COUNTER_NAMES[label.carrier];
  const counter = carrier === undefined ? "the carrier's counter" : `the ${carrier} counter`;
  return `No label to print: show the QR code in Vinted at ${counter}, which prints the label. ${deadline}`;
}
