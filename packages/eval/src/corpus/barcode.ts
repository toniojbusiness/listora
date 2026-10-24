/**
 * EAN-13 / UPC-A bar patterns (GS1 General Specifications, section 5.2). A UPC-A code is drawn
 * as the EAN-13 code with a leading 0, which produces the identical symbol.
 */

/** Left-hand odd-parity (set A) digit patterns; 1 = bar module, 0 = space module. */
export const L_CODES = [
  '0001101',
  '0011001',
  '0010011',
  '0111101',
  '0100011',
  '0110001',
  '0101111',
  '0111011',
  '0110111',
  '0001011',
] as const;

/** Right-hand (set C) patterns are the module-by-module complement of set A. */
export const R_CODES = L_CODES.map((code) =>
  Array.from(code, (bit) => (bit === '1' ? '0' : '1')).join(''),
);

/** Left-hand even-parity (set B) patterns are set C reversed. */
export const G_CODES = R_CODES.map((code) => Array.from(code).reverse().join(''));

/** Parity of the six left-hand digits, selected by the first (implied) digit. */
export const FIRST_DIGIT_PARITY = [
  'LLLLLL',
  'LLGLGG',
  'LLGGLG',
  'LLGGGL',
  'LGLLGG',
  'LGGLLG',
  'LGGGLL',
  'LGLGLG',
  'LGLGGL',
  'LGGLGL',
] as const;

export const EAN13_MODULES = 95;
const GUARD = '101';
const CENTER = '01010';

/** The 95 modules of an EAN-13 symbol for 12-digit (UPC-A) or 13-digit (EAN-13) input. */
export function ean13Modules(code: string): string {
  if (!/^(?:[0-9]{12}|[0-9]{13})$/.test(code)) {
    throw new RangeError('barcode digits must be 12 (UPC-A) or 13 (EAN-13) digits');
  }
  const digits = (code.length === 12 ? `0${code}` : code).split('').map(Number);
  const [first = 0, ...rest] = digits;
  const parity = FIRST_DIGIT_PARITY[first] ?? FIRST_DIGIT_PARITY[0];
  const left = rest
    .slice(0, 6)
    .map((digit, i) => (parity[i] === 'G' ? G_CODES[digit] : L_CODES[digit]) ?? '')
    .join('');
  const right = rest
    .slice(6)
    .map((digit) => R_CODES[digit] ?? '')
    .join('');
  return `${GUARD}${left}${CENTER}${right}${GUARD}`;
}

/** Human-readable text printed under the bars: `0 12345 67890 5` or `5 901234 123457`. */
export function humanReadable(code: string): string {
  if (code.length === 12) {
    return `${code.slice(0, 1)} ${code.slice(1, 6)} ${code.slice(6, 11)} ${code.slice(11)}`;
  }
  return `${code.slice(0, 1)} ${code.slice(1, 7)} ${code.slice(7)}`;
}
