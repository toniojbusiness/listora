/**
 * Depop sizes for an item's tag size. Depop's listing form offers a size list per category
 * (categories.ts says which): letter sizes (`XXS` to `XXXL`), US numeric sizes (`US 0` to
 * `US 24`), waist sizes for bottoms (`W24` to `W50`), US shoe sizes in halves (`US 5` to
 * `US 15`), and `One size`. The scripts pick the option whose label is the size, or starts with
 * it and a space (a label such as `M (UK 12)`), so only the size itself has to match
 * (docs/features/depop-automation.md).
 *
 * `depopSize` is deterministic: `Small` → `S`, `3XL` → `XXXL`, `8` → `US 8`, `W32 L30` and `32` →
 * `W32`, `10 1/2` shoes → `US 10.5`. It returns `null` for a size it can't tell
 * (and for UK and EU shoe sizes), and validation then asks for one.
 */
import type { ItemSnapshot } from '@listora/marketplaces';

import type { DepopSizeKind } from './categories.ts';

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
  xxxl: 'XXXL',
  '3xl': 'XXXL',
};

/** Depop's spelling of the item's size for a category's size list, or `null`. */
export function depopSize(item: ItemSnapshot, kind: DepopSizeKind): string | null {
  const label = item.sizeLabel?.trim() ?? '';
  if (label === '' || kind === 'none') return null;
  if (kind === 'shoes') {
    return item.sizeSystem === 'uk' || item.sizeSystem === 'eu' ? null : shoe(label);
  }
  if (item.sizeSystem === 'one_size' || /^(one\s*size|os|o\/s)$/i.test(label)) return 'One size';
  // Waist and inseam (`32x30`, `W32 L30`): Depop's bottoms sizes are the waist.
  const waist =
    /^w?\s*(\d{2})\s*(?:x|\/|\s)\s*l?\s*\d{2}$/i.exec(label)?.[1] ??
    /^w\s*(\d{2})$/i.exec(label)?.[1];
  if (waist !== undefined) return waistSize(waist);
  const token = label.toLowerCase().replace(/[\s.-]+/g, '');
  const letter = LETTER_SIZES[token];
  if (letter !== undefined) return letter;
  const numeric = /^(?:us)?(00|0|[1-9]\d?)$/.exec(token)?.[1];
  if (numeric === undefined) return null;
  // Up to 24 is a US dress size; above it, only a waist reads that way.
  const value = Number(numeric);
  return value <= 24 ? `US ${numeric}` : waistSize(numeric);
}

function waistSize(value: string): string | null {
  const number = Number(value);
  return number >= 24 && number <= 50 ? `W${value}` : null;
}

/** A US shoe size as Depop lists it: `US 9`, `US 10.5`. */
function shoe(label: string): string | null {
  const match = /^(?:us\s*)?(?:[mw]\s*)?(\d{1,2})(\s*(?:\.5|1\/2|½))?(?:\s*(?:us|m|w))?$/i.exec(
    label,
  );
  const whole = match?.[1];
  if (whole === undefined || Number(whole) < 1 || Number(whole) > 18) return null;
  const size = match?.[2] === undefined ? String(Number(whole)) : `${String(Number(whole))}.5`;
  return `US ${size}`;
}

/**
 * Whether a size option's label offers `size`: the label is the size, or the size followed by
 * a space and more (`M (UK 12)`).
 */
export function sizeOptionMatches(optionLabel: string, size: string): boolean {
  const label = optionLabel.trim();
  return label === size || label.startsWith(`${size} `);
}
