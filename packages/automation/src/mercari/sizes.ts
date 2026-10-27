/**
 * The Mercari size for an item's tag size. A category's form offers the size list of its size
 * group (catalog/catalog.json): women's clothing `M (8-10)`, men's `XL (46-48)` and `Big 2X`,
 * adult pants by waist `32 in.` or letter, suits `40R`, women's shoes `8 (38.5)`, men's shoes
 * `10 (43)`, kids' clothing `2T` and `6-9 Months`, kids' shoes `1.5`, and bras `34E (DD)`. The
 * payload names the exact label to pick, so the form gets the size the item has or no listing is
 * sent (validation asks for one).
 *
 * `mercariSizeLabel` is deterministic. It reads the tag size as one of these and matches it to
 * the list, the first label in the list's order winning (the standard sizes come before petite,
 * tall, and big ones):
 *
 * - letter sizes, by the label's own letters (`Small` is `S`, `2XL` is `XXL`, `2X`, or `2XL`);
 * - numbers: a label that is the number (`10.5`, `32 in.`, `40R` for a suit's 40), then the
 *   range a label gives (`M (8-10)` for a women's 8), and for EU shoe sizes the EU size a label
 *   names (`8 (38.5)` for 38.5);
 * - months (`6M`, `6-9 months`, `Newborn`) by Mercari's month ranges;
 * - anything else by its exact label (`2T`, `34B`, `One size`), and a bra's US cup by the cup
 *   the label names (`34DD` is `34E (DD)`).
 *
 * UK shoe sizes are not mapped.
 *
 * `mercariSize` adds the list's parts: a petite or tall size (`4P`, `S Petite`, `XL Tall`) is
 * picked in the list's Petite or Tall part where it has one, and a size the reader above doesn't
 * read (`0S`, `27"`, `27/4`, `2X`) is read by its parts (adapter/adult-size.ts). A waist is only
 * ever a waist size (`27 in.`), never a dress size's range.
 */
import type { ItemSnapshot } from '@listora/marketplaces';

import { readAdultSize, type AdultSize } from '../adapter/adult-size.ts';

const LETTERS: Readonly<Record<string, string>> = {
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
  '2x': 'XXL',
  xxxl: '3XL',
  '3xl': '3XL',
  '3x': '3XL',
  xxxxl: '4XL',
  '4xl': '4XL',
  '4x': '4XL',
  '5xl': '5XL',
};

/** The names Mercari's lists use for a letter size (`XXL` is `2XL (20-22)`, `2X`, `XXL`). */
const LETTER_NAMES: Readonly<Record<string, readonly string[]>> = {
  XXS: ['XXS', 'XXS and Below'],
  XXL: ['XXL', '2XL', '2X'],
  '3XL': ['3XL', 'XXXL', 'XXXL+', '3X'],
  '4XL': ['4XL', '4XL+', 'XXXXL', '4X'],
};

type TagSize =
  | { kind: 'letter'; letter: string }
  | { kind: 'number'; value: number; eu: boolean; waist: boolean }
  | { kind: 'months'; months: number }
  | { kind: 'newborn' }
  | { kind: 'one_size' }
  | { kind: 'label'; text: string };

/**
 * The label of `labels` (a size group's list, in its order) that is the item's size, or `null`
 * when the item has no size or none of them is it.
 */
export function mercariSizeLabel(item: ItemSnapshot, labels: readonly string[]): string | null {
  const size = tagSize(item);
  if (size === null) return null;
  const parsed = labels.map((label) => ({ label, ...parts(label) }));
  const first = (test: (option: (typeof parsed)[number]) => boolean): string | null =>
    parsed.find(test)?.label ?? null;
  switch (size.kind) {
    case 'one_size':
      return first(({ title }) => /^one size$/i.test(title));
    case 'newborn':
      return first(({ title }) => /^newborn$/i.test(title));
    case 'letter': {
      const names = LETTER_NAMES[size.letter] ?? [size.letter];
      return first(({ title }) => names.some((name) => name.toUpperCase() === title.toUpperCase()));
    }
    case 'months':
      return first(({ title }) => {
        const range = /^(\d+)-(\d+) months$/i.exec(title);
        if (range?.[1] !== undefined && range[2] !== undefined) {
          return size.months > Number(range[1]) && size.months <= Number(range[2]);
        }
        const upTo = /^(\d+) months$/i.exec(title)?.[1];
        return upTo !== undefined && size.months > 18 && size.months <= Number(upTo);
      });
    case 'number': {
      if (size.eu) return first(({ inside }) => numberOf(inside) === size.value);
      const shown = String(size.value);
      if (size.waist) return first(({ title }) => title === `${shown} in.`);
      return (
        first(({ title }) => [shown, `${shown} in.`, `${shown}R`].includes(title)) ??
        first(({ title }) => [`${shown} & Up`, `${shown} and below`].includes(title)) ??
        first(({ inside }) => {
          if (inside === shown) return true;
          const range = /^(\d+)-(\d+)$/.exec(inside ?? '');
          if (range?.[1] === undefined || range[2] === undefined) return false;
          return size.value >= Number(range[1]) && size.value <= Number(range[2]);
        })
      );
    }
    case 'label': {
      const text = size.text.toUpperCase();
      const exact = first(
        ({ label, title }) => label.toUpperCase() === text || title.toUpperCase() === text,
      );
      if (exact !== null) return exact;
      // A bra's US cup (`34DD`) where Mercari names the band and its own cup (`34E (DD)`).
      const bra = /^(\d{2})([A-Z]{2,4})$/.exec(text.replaceAll(' ', ''));
      if (bra?.[1] === undefined || bra[2] === undefined) return null;
      const [, band, cup] = bra;
      return first(
        ({ title, inside }) =>
          title.startsWith(band) && (inside === `${band}${cup} US` || inside === cup),
      );
    }
  }
}

/** A size to pick: its label, and the list's part it is in when not the first one that has it. */
export interface MercariSize {
  label: string;
  /** The part of the list (`Petite`, `Tall`), or `null` for the first part with the label. */
  set: string | null;
}

/** The fits that have a part of their own in Mercari's lists. */
const FIT_SETS = { petite: 'Petite', tall: 'Tall' } as const;

/**
 * The size to pick in a size list with these parts (catalog's `sizeSets`), or `null` when the
 * item has no size or none of them is it.
 */
export function mercariSize(
  item: ItemSnapshot,
  sets: readonly { name: string; labels: readonly string[] }[],
): MercariSize | null {
  const adult = readAdultSize(item.sizeLabel);
  const fitSet = adult?.fit === 'petite' || adult?.fit === 'tall' ? FIT_SETS[adult.fit] : null;
  const part = sets.find((set) => set.name === fitSet);
  if (adult !== null && part !== undefined) {
    const label = byParts(item, adult, part.labels);
    if (label !== null) return { label, set: part.name };
  }
  const labels = [...new Set(sets.flatMap((set) => set.labels))];
  const label =
    mercariSizeLabel(item, labels) ??
    (adult === null ? null : byParts(item, adult, labels)) ??
    womensLetter(item, adult, labels);
  return label === null ? null : { label, set: null };
}

/**
 * Mercari's own ranges of women's sizes (its women's list: `XS (0-2)`, `S (4-6)`, ... `4XL
 * (28-30)`), for a women's numeric size on a list that has only letters and waists (adult pants:
 * a women's 4 is its `S`).
 */
const WOMENS_RANGES: readonly (readonly [low: number, high: number, letter: string])[] = [
  [0, 2, 'XS'],
  [4, 6, 'S'],
  [8, 10, 'M'],
  [12, 14, 'L'],
  [16, 18, 'XL'],
  [20, 22, 'XXL'],
  [24, 26, '3XL'],
  [28, 30, '4XL'],
];

function womensLetter(
  item: ItemSnapshot,
  adult: AdultSize | null,
  labels: readonly string[],
): string | null {
  if (item.department !== 'women' || item.sizeSystem === 'waist_inseam') return null;
  const number = adult?.number ?? /^(00|\d{1,2})$/.exec(item.sizeLabel?.trim() ?? '')?.[1];
  if (number === undefined) return null;
  const letter =
    number === '00'
      ? 'XXS'
      : WOMENS_RANGES.find(([low, high]) => Number(number) >= low && Number(number) <= high)?.[2];
  if (letter === undefined) return null;
  return mercariSizeLabel({ ...item, sizeLabel: letter, sizeSystem: 'letter' }, labels);
}

/** The label of `labels` that one of the size's parts is: its waist, number, or letter. */
function byParts(item: ItemSnapshot, adult: AdultSize, labels: readonly string[]): string | null {
  const reads: Pick<ItemSnapshot, 'sizeLabel' | 'sizeSystem'>[] = [
    ...(adult.waist === null ? [] : [{ sizeLabel: adult.waist, sizeSystem: 'waist_inseam' }]),
    ...(adult.number === null ? [] : [{ sizeLabel: adult.number, sizeSystem: 'numeric' }]),
    ...(adult.letter === null ? [] : [{ sizeLabel: adult.letter, sizeSystem: 'letter' }]),
  ];
  for (const read of reads) {
    const label = mercariSizeLabel({ ...item, ...read }, labels);
    if (label !== null) return label;
  }
  return null;
}

/** How a tag reads, as one of the kinds Mercari's lists hold. */
function tagSize(item: ItemSnapshot): TagSize | null {
  const label = item.sizeLabel?.trim() ?? '';
  if (label === '') return null;
  if (item.sizeSystem === 'uk') return null;
  if (item.sizeSystem === 'one_size' || /^(one\s*size|os|o\/s)$/i.test(label)) {
    return { kind: 'one_size' };
  }
  if (/^(nb|newborn|preemie)$/i.test(label)) return { kind: 'newborn' };
  // Months: `6M`, `6 mos`, `6-9 months` (the upper end).
  const months = /^(?:\d+\s*-\s*)?(\d{1,2})\s*(?:m|mo|mos|months?)$/i.exec(label)?.[1];
  if (months !== undefined) return { kind: 'months', months: Number(months) };
  // Waist and inseam (`32x30`, `W32 L30`): Mercari's pants sizes are the waist.
  const waist = /^w?\s*(\d{2})\s*(?:x|\/|\s)\s*l?\s*\d{2}$/i.exec(label)?.[1];
  if (waist !== undefined) return { kind: 'number', value: Number(waist), eu: false, waist: true };
  const letter = LETTERS[label.toLowerCase().replace(/[\s.-]+/g, '')];
  if (letter !== undefined) return { kind: 'letter', letter };
  // A number, with a shoe's half (`10 1/2`, `10½`, `10.5`) and the system's own marks.
  const number =
    /^(?:us|eu)?\s*(?:[mw]\s*)?(\d{1,2})(\s*(?:\.5|1\/2|½))?(?:\s*(?:us|eu|m|w))?$/i.exec(label);
  if (number?.[1] !== undefined) {
    const value = Number(number[1]) + (number[2] === undefined ? 0 : 0.5);
    // Women's `00` is Mercari's XXS (00).
    if (label === '00') return { kind: 'label', text: 'XXS' };
    return {
      kind: 'number',
      value,
      eu: item.sizeSystem === 'eu',
      waist: item.sizeSystem === 'waist_inseam',
    };
  }
  return { kind: 'label', text: label };
}

/** A label's own name and what its parentheses hold: `M (8-10)` is `M` and `8-10`. */
function parts(label: string): { title: string; inside: string | null } {
  const match = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(label.trim());
  if (match?.[1] === undefined || match[2] === undefined)
    return { title: label.trim(), inside: null };
  return { title: match[1].trim(), inside: match[2].trim() };
}

function numberOf(text: string | null): number | null {
  if (text === null || !/^\d+(\.\d+)?$/.test(text)) return null;
  return Number(text);
}
