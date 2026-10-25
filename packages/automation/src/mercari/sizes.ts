/**
 * Mercari sizes for an item's tag size. Mercari's listing form offers a size list per category
 * (categories.ts says which): letter sizes (`XS` to `4XL`), numeric sizes (`00` to `24`), waist
 * sizes for pants (`28` to `44`), US shoe sizes in halves (`5` to `15`), and `One size`. The
 * create script picks the option whose label is the size, or starts with it and a space (a
 * label such as `M (8-10)`), so only the size itself has to match (docs/mercari.md).
 *
 * `mercariSize` is deterministic: `Small` → `S`, `2XL` → `XXL`, `W32 L30` → `32`, `10 1/2` →
 * `10.5`. It returns `null` for a size it can't tell, and validation then asks for one.
 */
import type { ItemSnapshot } from '@listora/marketplaces';

import type { MercariSizeKind } from './categories.ts';

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
};

/** Mercari's spelling of the item's size for a category's size list, or `null`. */
export function mercariSize(item: ItemSnapshot, kind: MercariSizeKind): string | null {
  const label = item.sizeLabel?.trim() ?? '';
  if (label === '' || kind === 'none') return null;
  if (kind === 'shoes') {
    return item.sizeSystem === 'uk' || item.sizeSystem === 'eu' ? null : shoe(label);
  }
  if (item.sizeSystem === 'one_size' || /^(one\s*size|os|o\/s)$/i.test(label)) return 'One size';
  // Waist and inseam (`32x30`, `W32 L30`): Mercari's pants sizes are the waist.
  const waist = /^w?\s*(\d{2})\s*(?:x|\/|\s)\s*l?\s*\d{2}$/i.exec(label)?.[1];
  if (waist !== undefined) return inRange(waist, 24, 50);
  const token = label.toLowerCase().replace(/[\s.-]+/g, '');
  const letter = LETTER_SIZES[token];
  if (letter !== undefined) return letter;
  const numeric = /^(00|0|[1-9]\d?)$/.exec(token)?.[1];
  return numeric === undefined ? null : inRange(numeric, 0, 50);
}

/** A US shoe size as Mercari lists it: `9`, `10.5`. */
function shoe(label: string): string | null {
  const match = /^(?:us\s*)?(?:[mw]\s*)?(\d{1,2})(\s*(?:\.5|1\/2|½))?(?:\s*(?:us|m|w))?$/i.exec(
    label,
  );
  const whole = match?.[1];
  if (whole === undefined || Number(whole) < 1 || Number(whole) > 18) return null;
  return match?.[2] === undefined ? String(Number(whole)) : `${String(Number(whole))}.5`;
}

function inRange(value: string, min: number, max: number): string | null {
  const number = Number(value);
  return number >= min && number <= max ? value : null;
}

/**
 * Whether a size option's label offers `size`: the label is the size, or the size followed by
 * a space and more (`M (8-10)`).
 */
export function sizeOptionMatches(optionLabel: string, size: string): boolean {
  const label = optionLabel.trim();
  return label === size || label.startsWith(`${size} `);
}
