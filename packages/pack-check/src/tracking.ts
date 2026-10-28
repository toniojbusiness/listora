/**
 * Shipping label barcodes (docs/features/pack-check.md, "Scanning"). A phone camera reads the
 * label's barcode as text, and what it reads is not always the tracking number the marketplace
 * shows:
 *
 * - **USPS** labels carry an IMpb barcode (GS1-128) that is the routing code `420` and the
 *   destination ZIP (5 or 9 digits) before the tracking number, often with a symbology
 *   identifier (`]C1`) or a separator character (FNC1, read as `\u001d`) between them:
 *   `]C142094107\u001d9400111899223197428490` is tracking `9400111899223197428490`.
 * - **UPS** labels carry the `1Z...` number itself in Code 128.
 * - **FedEx** labels carry a longer barcode whose end is the 12 or 15 digit tracking number.
 *
 * So a scan is cleaned up (`canonicalTracking`: the symbology identifier, separators, and the
 * USPS routing code go), and a scan matches a known tracking number when it is that number or
 * ends with it (`scanMatchesTracking`), which covers the FedEx barcode without guessing its
 * layout.
 */

export const CARRIERS = ['usps', 'ups', 'fedex', 'dhl', 'other'] as const;
export type Carrier = (typeof CARRIERS)[number];

/** The shortest tracking number Listora compares by its end (a FedEx number is 12 digits). */
export const MIN_TRACKING_LENGTH = 10;
/** The longest code Listora keeps as a tracking number. */
export const MAX_TRACKING_LENGTH = 40;

/** A GS1 symbology identifier a scanner may put in front of what it read (`]C1`, `]d2`). */
const SYMBOLOGY_ID = /^\][A-Za-z][0-9A-Za-z]/;
/** USPS's routing code: `420`, the ZIP (and ZIP+4), then the tracking number. */
const USPS_ROUTED = /^420(?:\d{5}|\d{9})(9[1-5]\d{18,32})$/;
const USPS_ZIP5 = /^420\d{5}(9[1-5]\d{18,32})$/;

/**
 * The tracking number a scanned or read code stands for: upper case, letters and digits only,
 * without a symbology identifier or USPS's routing code. `null` for a code that can't be one
 * (too short or too long, or no digit at all).
 */
export function canonicalTracking(raw: string): string | null {
  let text = raw.trim();
  if (SYMBOLOGY_ID.test(text)) text = text.slice(3);
  // A separator (FNC1 read as a group separator) ends the routing code: what follows is the
  // tracking number.
  const separated = text.split('\u001d');
  if (separated.length > 1 && /^420\d{5,9}$/.test(cleaned(separated[0] ?? ''))) {
    text = separated.slice(1).join('');
  }
  let code = cleaned(text);
  // Prefer the 5-digit ZIP: USPS's own numbers start with 9, and so may a ZIP+4's last digits.
  const routed = USPS_ZIP5.exec(code) ?? USPS_ROUTED.exec(code);
  if (routed?.[1] !== undefined) code = routed[1];
  if (code.length < MIN_TRACKING_LENGTH || code.length > MAX_TRACKING_LENGTH) return null;
  if (!/\d/.test(code)) return null;
  return code;
}

function cleaned(text: string): string {
  return text.toUpperCase().replaceAll(/[^A-Z0-9]/g, '');
}

/**
 * Whether a scanned label is the label with `tracking` (both canonical): the same number, or a
 * longer barcode that ends with it (FedEx). Never a match on a number shorter than
 * `MIN_TRACKING_LENGTH`, so a short code can't stand for many labels.
 */
export function scanMatchesTracking(scanned: string, tracking: string): boolean {
  if (scanned === tracking) return true;
  return tracking.length >= MIN_TRACKING_LENGTH && scanned.endsWith(tracking);
}

/** The carrier a tracking number's shape names, for display only; `other` when it can't tell. */
export function carrierOf(tracking: string): Carrier {
  if (/^1Z[0-9A-Z]{16}$/.test(tracking)) return 'ups';
  if (/^9[1-5]\d{18,32}$/.test(tracking) || /^[A-Z]{2}\d{9}US$/.test(tracking)) return 'usps';
  if (/^\d{12}$/.test(tracking) || /^\d{15}$/.test(tracking)) return 'fedex';
  if (/^\d{10}$/.test(tracking)) return 'dhl';
  return 'other';
}

/** `•••• 8490`: the end of a tracking number, as the app shows it next to the carrier. */
export function trackingTail(tracking: string): string {
  return `•••• ${tracking.slice(-4)}`;
}
