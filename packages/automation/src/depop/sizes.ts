/**
 * The Depop size for an item's tag size, picked from the size list Depop's form offers for the
 * listing's product type (categories.ts, from Depop's own taxonomy): men's tops `XS` to `6XL`,
 * women's tops and dresses also `00` to `36`, bottoms waists in inches (`32"`), US shoe sizes in
 * halves (`US 9.5`), kids' ages (`4 years`, `6-9 months`), kids' shoes (`9-9.5`), bras (`34B`),
 * and `One size`. The result is always one of the list's own labels, or `null` when the tag size
 * isn't one Depop lists for that product type (validation then says which it offers).
 *
 * Some examples: `Small` → `S`, `2XL` and `XXL` → `XXL`, `XXXL` → `3XL`, `32x30` and `W32` →
 * `32"`, `8` → `8` (women's) or `8 years` (kids'), `10 1/2` shoes → `US 10.5`, `2T` → `2 years`.
 * UK and EU shoe sizes are not mapped.
 */
import type { ItemSnapshot } from '@listora/marketplaces';

const LETTER_SIZES: Readonly<Record<string, string>> = {
  xxxs: '3XS',
  '3xs': '3XS',
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

/** The label in `sizes` that names the item's size, or `null`. */
export function depopSize(item: ItemSnapshot, sizes: readonly string[]): string | null {
  const label = item.sizeLabel?.trim() ?? '';
  if (sizes.length === 0) return null;
  const offered = (candidate: string | null): string | null => {
    if (candidate === null) return null;
    return sizes.find((size) => size.toLowerCase() === candidate.toLowerCase()) ?? null;
  };
  if (item.sizeSystem === 'one_size' || /^(one\s*size|os|o\/s)$/i.test(label)) {
    return offered('One size');
  }
  if (label === '') return null;
  for (const candidate of candidates(label, item.sizeSystem, sizes)) {
    const found = offered(candidate);
    if (found !== null) return found;
  }
  return null;
}

/** What the tag size may be called in Depop's lists, most likely first. */
function candidates(label: string, system: string | null, sizes: readonly string[]): string[] {
  const shoeList = sizes.some((size) => size.startsWith('US '));
  const kidsShoes = sizes.some((size) => size.includes('(adult)'));
  const kidsAges = sizes.some((size) => size.endsWith(' years'));
  if (shoeList) return system === 'uk' || system === 'eu' ? [] : [usShoe(label)].flatMap(listed);
  if (kidsShoes) return kidsShoe(label, sizes);
  const token = label.toLowerCase().replace(/[\s.-]+/g, '');
  const letter = LETTER_SIZES[token];
  if (letter !== undefined) return [letter];
  // Waist and inseam (`32x30`, `W32 L30`, `W32`): Depop's bottoms take the waist, in inches.
  const waist =
    /^w?\s*(\d{2})\s*(?:x|\/|\s)\s*l?\s*\d{2}$/i.exec(label)?.[1] ??
    /^w\s*(\d{2})$/i.exec(label)?.[1] ??
    /^(\d{2})\s*(?:"|in|inch(?:es)?)$/i.exec(label)?.[1];
  if (waist !== undefined) return [`${waist}"`];
  if (kidsAges) return kidsAge(label);
  // Bras: band and cup (`34B`, `36 DD`).
  const bra = /^(\d{2})\s*([a-h]{1,3})$/i.exec(label);
  if (bra?.[1] !== undefined && bra[2] !== undefined) {
    return [`${bra[1]}${bra[2].toUpperCase()}`];
  }
  const numeric = /^(?:us\s*)?(00|0|[1-9]\d?)$/i.exec(label.trim())?.[1];
  if (numeric === undefined) return [];
  // A dress size where the list has numbers; on a waist-only list, a waist.
  return system === 'waist_inseam' ? [`${numeric}"`, numeric] : [numeric, `${numeric}"`];
}

function listed(size: string | null): string[] {
  return size === null ? [] : [size];
}

/** A US shoe size as Depop lists it: `US 9`, `US 10.5`. */
function usShoe(label: string): string | null {
  const match = /^(?:us\s*)?(?:[mw]\s*)?(\d{1,2})(\s*(?:\.5|1\/2|½))?(?:\s*(?:us|m|w))?$/i.exec(
    label,
  );
  const whole = match?.[1];
  if (whole === undefined || Number(whole) < 1 || Number(whole) > 18) return null;
  const size = match?.[2] === undefined ? String(Number(whole)) : `${String(Number(whole))}.5`;
  return `US ${size}`;
}

/** A kids' age size: `2T` and `2` → `2 years`; `6-9M` → `6-9 months`. */
function kidsAge(label: string): string[] {
  const months = /^(\d{1,2})\s*-\s*(\d{1,2})\s*m(?:o(?:nths?)?)?$/i.exec(label);
  if (months?.[1] !== undefined && months[2] !== undefined) {
    return [`${months[1]}-${months[2]} months`];
  }
  const years = /^(\d{1,2})\s*(?:t|y|yr|yrs|years?)?$/i.exec(label)?.[1];
  return years === undefined ? [] : [`${String(Number(years))} years`];
}

/** A kids' shoe size within one of Depop's ranges (`9.5` → `9-9.5`), or exactly (`8`). */
function kidsShoe(label: string, sizes: readonly string[]): string[] {
  const match = /^(?:us\s*)?(\d{1,2})(\s*(?:\.5|1\/2|½))?\s*(?:c|k|y)?$/i.exec(label);
  if (match?.[1] === undefined) return [];
  const value = Number(match[1]) + (match[2] === undefined ? 0 : 0.5);
  const found = sizes.find((size) => {
    if (size.includes('(adult)')) return false;
    const range = /^(\d+(?:\.5)?)(?:-(\d+(?:\.5)?))?/.exec(size);
    if (range?.[1] === undefined) return false;
    const low = Number(range[1]);
    const high = range[2] === undefined ? low : Number(range[2]);
    return value >= low && value <= high;
  });
  return found === undefined ? [] : [found];
}

/**
 * Whether a size option's label offers `size`: the label is the size, or the size followed by
 * a space and more (a label such as `M (UK 12)`).
 */
export function sizeOptionMatches(optionLabel: string, size: string): boolean {
  const label = optionLabel.trim();
  return label === size || label.startsWith(`${size} `);
}
