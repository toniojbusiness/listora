import { lineConfidence, ocrSource, type PreparedLine } from './normalize.ts';
import type { BarcodeRead, Gtin, Parsed } from './types.ts';

/*
 * UPC-A and EAN-13 product codes, from barcode payloads and from the human-readable digits
 * printed under a barcode. Every code must pass the GS1 mod-10 check digit. UPC-E, EAN-8, and
 * non-retail symbologies (QR, Code 128) are ignored.
 */

/** GS1 check digit for the digits that precede it (weights 3,1,3,1... from the right). */
export function gtinCheckDigit(body: string): number {
  if (!/^[0-9]+$/.test(body)) throw new RangeError('GTIN body must be digits');
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) {
    const digit = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? digit * 3 : digit;
  }
  return (10 - (sum % 10)) % 10;
}

/** True for a 12-digit UPC-A or 13-digit EAN-13 whose check digit is correct. */
export function isValidGtin(digits: string): boolean {
  if (!/^(?:[0-9]{12}|[0-9]{13})$/.test(digits)) return false;
  return gtinCheckDigit(digits.slice(0, -1)) === Number(digits.slice(-1));
}

/** Canonical form: UPC-A keeps 12 digits, including an EAN-13 that starts with 0. */
export function toGtin(digits: string): Gtin | null {
  if (!isValidGtin(digits)) return null;
  if (digits.length === 12) return { format: 'upc_a', digits };
  if (digits.startsWith('0')) return { format: 'upc_a', digits: digits.slice(1) };
  return { format: 'ean_13', digits };
}

type Symbology = 'upc_a' | 'ean_13' | 'unsupported' | 'unknown';

function classifySymbology(name: string | undefined): Symbology {
  if (name === undefined) return 'unknown';
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (key.endsWith('ean13')) return 'ean_13';
  if (key.endsWith('upca')) return 'upc_a';
  return 'unsupported';
}

export function parseBarcodeGtins(barcodes: readonly BarcodeRead[]): Parsed<Gtin>[] {
  const results: Parsed<Gtin>[] = [];
  barcodes.forEach((barcode, barcodeIndex) => {
    const symbology = classifySymbology(barcode.symbology);
    if (symbology === 'unsupported') return;
    const digits = barcode.payload.trim();
    if (symbology === 'upc_a' && digits.length !== 12) return;
    if (symbology === 'ean_13' && digits.length !== 13) return;
    const gtin = toGtin(digits);
    if (gtin === null) return;
    results.push({
      value: gtin,
      confidence: 0.99,
      source: {
        kind: 'barcode',
        barcodeIndex,
        payload: barcode.payload,
        ...(barcode.symbology === undefined ? {} : { symbology: barcode.symbology }),
        ...(barcode.photoId === undefined ? {} : { photoId: barcode.photoId }),
      },
    });
  });
  return results;
}

/** Digit runs printed the way UPC-A and EAN-13 human-readable text is grouped. */
const DIGIT_RUN = /(?<![0-9A-Z])[0-9](?: ?[0-9]){11,12}(?![0-9A-Z])/g;
const ACCEPTED_GROUPINGS = new Set(['12', '13', '1-5-5-1', '1-6-6']);
const GTIN_LABEL = /\b(?:UPC|EAN|GTIN)\b/;

export function parseOcrGtins(lines: readonly PreparedLine[]): Parsed<Gtin>[] {
  const results: Parsed<Gtin>[] = [];
  for (const line of lines) {
    const labeled = GTIN_LABEL.test(line.text);
    for (const match of line.text.matchAll(DIGIT_RUN)) {
      const groups = match[0].split(' ');
      if (!ACCEPTED_GROUPINGS.has(groups.map((group) => group.length).join('-'))) continue;
      const gtin = toGtin(groups.join(''));
      if (gtin === null) continue;
      results.push({
        value: gtin,
        confidence: lineConfidence(labeled ? 0.9 : 0.85, [line]),
        source: ocrSource([line]),
      });
    }
  }
  return results;
}
