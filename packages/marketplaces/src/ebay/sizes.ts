/**
 * eBay's standard sizes. Since August 2026 eBay blocks Apparel and Footwear listings whose
 * `Size` item specific is not one of the category's standard values (Trading error 21920468,
 * "... is not a valid value for Size. Select a value from the available options."; developer
 * release notes 1477 and https://developer.ebay.com/updates/blog/size-standardization, which
 * gives "Small" → "S" as the normalization example).
 *
 * `ebaySize` turns a tag's size into eBay's style deterministically (`Small` → `S`, `2XL` →
 * `XXL`, `10 1/2` → `10.5`), so the pure payload builder sends a standard value for the common
 * sizes. eBay publishes the exact lists only per leaf category through `getItemAspectsForCategory`,
 * so `prepareListing` (adapter.ts) also matches the value against the live list
 * (`matchAllowedValue`, which knows eBay's spellings such as `2XL` for `XXL`).
 */
import type { ItemSnapshot, ListingAspect } from '../content.ts';
import type { SizeAspect } from './categories.ts';

const LETTER_SIZES: Readonly<Record<string, string>> = {
  xxs: 'XXS',
  '2xs': 'XXS',
  xs: 'XS',
  extrasmall: 'XS',
  s: 'S',
  sm: 'S',
  small: 'S',
  m: 'M',
  md: 'M',
  med: 'M',
  medium: 'M',
  l: 'L',
  lg: 'L',
  large: 'L',
  xl: 'XL',
  extralarge: 'XL',
  xxl: 'XXL',
  '2xl': 'XXL',
  xxxl: '3XL',
  '3xl': '3XL',
  xxxxl: '4XL',
  '4xl': '4XL',
  '5xl': '5XL',
  '6xl': '6XL',
};

/** Women's plus sizes, which eBay lists as `1X` to `6X`. */
const PLUS_SIZES = /^([1-6])x$/;

/** The size item specifics for an item in a category that takes `kind` (empty when none). */
export function ebaySizeSpecifics(item: ItemSnapshot, kind: SizeAspect): ListingAspect[] {
  const size = ebaySize(item, kind);
  if (size === null) return [];
  switch (kind) {
    case 'clothing':
      return [
        { name: 'Size', values: [size.value] },
        ...(size.sizeType === null ? [] : [{ name: 'Size Type', values: [size.sizeType] }]),
        ...(size.inseam === null ? [] : [{ name: 'Inseam', values: [size.inseam] }]),
      ];
    case 'shoes':
      return [{ name: 'US Shoe Size', values: [size.value] }];
    case 'none':
      return [];
  }
}

export interface EbaySize {
  value: string;
  /** `Regular`, `Petite`, `Plus`, or `Tall`, for clothing. */
  sizeType: string | null;
  /** For waist-and-inseam sizes, for example `30 in`. */
  inseam: string | null;
}

/** eBay's standard spelling of an item's size, or `null` when it can't be told. */
export function ebaySize(item: ItemSnapshot, kind: SizeAspect): EbaySize | null {
  const label = item.sizeLabel?.trim() ?? '';
  if (label === '' || kind === 'none') return null;
  if (kind === 'shoes') {
    if (item.sizeSystem === 'uk' || item.sizeSystem === 'eu') return null;
    const value = shoeSize(label);
    return value === null ? null : { value, sizeType: null, inseam: null };
  }
  if (item.sizeSystem === 'one_size' || /^(one\s*size|os|o\/s)$/i.test(label)) {
    return { value: 'One Size', sizeType: null, inseam: null };
  }
  const waistInseam = /^w?\s*(\d{2})\s*(?:x|\/|\s)\s*l?\s*(\d{2})$/i.exec(label);
  if (waistInseam?.[1] !== undefined && waistInseam[2] !== undefined) {
    return { value: waistInseam[1], sizeType: 'Regular', inseam: `${waistInseam[2]} in` };
  }
  return letterOrNumeric(label);
}

function letterOrNumeric(label: string): EbaySize | null {
  let token = label.toLowerCase().replace(/[\s.-]+/g, '');
  let sizeType = 'Regular';
  if (token.endsWith('petite')) {
    sizeType = 'Petite';
    token = token.slice(0, -'petite'.length);
  } else if (token.endsWith('tall')) {
    sizeType = 'Tall';
    token = token.slice(0, -'tall'.length);
  } else if (token.endsWith('plus')) {
    sizeType = 'Plus';
    token = token.slice(0, -'plus'.length);
  }
  const plus = PLUS_SIZES.exec(token);
  if (plus?.[1] !== undefined) return { value: `${plus[1]}X`, sizeType: 'Plus', inseam: null };
  const letter = LETTER_SIZES[token];
  if (letter !== undefined) return { value: letter, sizeType, inseam: null };
  // Petite and tall letter sizes are often written with a suffix: SP, MP, LT, XLT.
  const suffixed = /^(.+?)([pt])$/.exec(token);
  const suffixedLetter = suffixed?.[1] === undefined ? undefined : LETTER_SIZES[suffixed[1]];
  if (suffixedLetter !== undefined) {
    return {
      value: suffixedLetter,
      sizeType: suffixed?.[2] === 'p' ? 'Petite' : 'Tall',
      inseam: null,
    };
  }
  const numeric = /^(00|0|[1-9]\d?)(p)?$/.exec(token);
  if (numeric?.[1] !== undefined) {
    return { value: numeric[1], sizeType: numeric[2] === 'p' ? 'Petite' : sizeType, inseam: null };
  }
  return null;
}

/** A US shoe size as eBay writes it: `9`, `10.5`. */
function shoeSize(label: string): string | null {
  const match = /^(?:us\s*)?(?:[mw]\s*)?(\d{1,2})(?:\s*(?:\.5|1\/2|½))?(?:\s*(?:us|m|w))?$/i.exec(
    label,
  );
  if (match?.[1] === undefined) return null;
  const whole = Number(match[1]);
  if (whole < 1 || whole > 18) return null;
  const half = /(\.5|1\/2|½)/.test(label);
  return half ? `${String(whole)}.5` : String(whole);
}

/** Spellings eBay uses for the same size. */
const ALIASES: readonly (readonly string[])[] = [
  ['XXS', '2XS'],
  ['XXL', '2XL'],
  ['3XL', 'XXXL'],
  ['4XL', 'XXXXL'],
  ['One Size', 'OS', 'One Size Fits All'],
];

/** The value from eBay's allowed list that means `value`, or `null` when none does. */
export function matchAllowedValue(value: string, allowed: readonly string[]): string | null {
  const exact = allowed.find((candidate) => candidate === value);
  if (exact !== undefined) return exact;
  const lower = value.toLowerCase();
  const caseless = allowed.find((candidate) => candidate.toLowerCase() === lower);
  if (caseless !== undefined) return caseless;
  const spellings = ALIASES.find((group) => group.some((name) => name.toLowerCase() === lower));
  if (spellings !== undefined) {
    const alias = allowed.find((candidate) =>
      spellings.some((name) => name.toLowerCase() === candidate.toLowerCase()),
    );
    if (alias !== undefined) return alias;
  }
  const number = Number(value);
  if (value !== '' && Number.isFinite(number)) {
    const numeric = allowed.find((candidate) => Number(candidate) === number);
    if (numeric !== undefined) return numeric;
  }
  return null;
}
