/**
 * An item's size as Poshmark's listing form takes it: one size id from one of the category's
 * size sets (catalog.ts), for example `M` in Standard, `14W` in Plus, `XLT` in Big & Tall.
 *
 * `poshmarkSize` turns the tag's size into Poshmark's spelling deterministically (`Medium` → `M`,
 * `2XL` → `XXL`, `32x30` → `32`, `10 1/2` → `10.5`, `34DD` → `34E (DD)`, `S Petite` → `SP`) and
 * keeps it only when the category's size sets have it, so the form is never asked for a size it
 * lacks. One-size categories (bags, jewelry, accessories) always take `OS`.
 */
import type { SizeSets } from './catalog.ts';

export interface PoshmarkSize {
  /** The size set's name as the form shows it: `Standard`, `Plus`, `Petite`, `Big & Tall`. */
  set: string;
  /** The size id as the form shows it: `M`, `14W`, `10.5`, `34E (DD)`. */
  size: string;
}

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
  xxxl: '3XL',
  '3xl': '3XL',
  xxxxl: '4XL',
  '4xl': '4XL',
  '5xl': '5XL',
  '6xl': '6XL',
};

/** Spellings Poshmark uses for the same size in different sets (women's Plus has `XXXL`). */
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  '3XL': ['3XL', 'XXXL'],
  XXL: ['XXL', '2XL'],
};

/** Bra cups as Poshmark writes them. */
const CUPS: Readonly<Record<string, readonly string[]>> = {
  dd: ['E (DD)', 'DD'],
  e: ['E (DD)'],
  ddd: ['F (3D)', 'F'],
  f: ['F (3D)', 'F'],
  g: ['G (4D)', 'G'],
  h: ['H (5D)'],
};

/** Poshmark's size for the item's size label in a category with these size sets, or `null`. */
export function poshmarkSize(
  label: string | null,
  system: string | null,
  sets: SizeSets,
): PoshmarkSize | null {
  const all = Object.values(sets).flat();
  if (all.length > 0 && all.every((size) => size === 'OS')) return find(['OS'], sets);
  const text = label?.trim() ?? '';
  if (text === '') return null;
  if (system === 'one_size' || /^(one\s*size|os|o\/s)$/i.test(text)) return find(['OS'], sets);
  // Poshmark's sizes are US sizes; a UK or EU size is never converted by guesswork.
  if (system === 'uk' || system === 'eu') return null;
  return find(candidates(text), sets);
}

/** The spellings a label may have on Poshmark, most likely first. */
function candidates(label: string): string[] {
  const token = label.toLowerCase().replace(/^us\s*/, '');
  const compact = token.replace(/[\s.-]+/g, '');

  // Waist and inseam (`32x30`, `W32 L30`): Poshmark sizes jeans and pants by the waist.
  const waistInseam = /^w?\s*(\d{2})\s*(?:x|\/|\s)\s*l?\s*(\d{2})$/i.exec(token);
  if (waistInseam?.[1] !== undefined) return [waistInseam[1], `${waistInseam[1]}BT`];

  // A bra size: band and cup.
  const bra = /^(\d{2})\s*(aa|a|b|c|d|dd|ddd|e|f|g|h)$/.exec(compact);
  if (bra?.[1] !== undefined && bra[2] !== undefined) {
    const band = bra[1];
    const cups = CUPS[bra[2]] ?? [bra[2].toUpperCase()];
    return cups.map((cup) => `${band}${cup}`);
  }

  // A suit or blazer size: chest and length (`40R`, `42 Long`).
  const suit = /^(\d{2})\s*(s|short|r|regular|l|long)$/.exec(token);
  if (suit?.[1] !== undefined && suit[2] !== undefined) {
    return [`${suit[1]}${suit[2].charAt(0).toUpperCase()}`];
  }

  // A half size (shoes, a shirt's neck): `10.5`, `10 1/2`, `15½`.
  const half = /^(\d{1,2})\s*(\.5|1\/2|½)$/.exec(token);
  if (half?.[1] !== undefined) return [`${String(Number(half[1]))}.5`];
  // A shoe size with its department: `M 9`, `Women's 8.5`.
  const shoe = /^(?:men'?s|women'?s|m|w)\s+(\d{1,2}(?:\.5)?)$/.exec(token);
  if (shoe?.[1] !== undefined) return [shoe[1]];
  // Men's big sizes: `36BT`, `17.5 BT`.
  const big = /^(\d{2}(?:\.5)?)\s*bt$/.exec(token);
  if (big?.[1] !== undefined) return [`${big[1]}BT`];

  // Petite, tall, and plus written out or as a suffix: `S Petite`, `MP`, `XLT`, `2X`, `14W`.
  let rest = compact;
  let suffix = '';
  for (const [word, mark] of [
    ['petite', 'P'],
    ['tall', 'T'],
  ] as const) {
    if (rest.endsWith(word)) {
      rest = rest.slice(0, -word.length);
      suffix = mark;
    }
  }
  if (rest.endsWith('plus')) rest = rest.slice(0, -'plus'.length);
  const plus = /^([0-6])x$/.exec(rest);
  if (plus?.[1] !== undefined) return [`${plus[1]}X`];
  const letter = LETTERS[rest];
  if (letter !== undefined) {
    // Poshmark writes men's tall XXL as `2XLT`.
    return spellings(letter).map((spelling) =>
      suffix === 'T' && spelling === 'XXL' ? '2XLT' : `${spelling}${suffix}`,
    );
  }
  const suffixed = /^(.+?)([pt])$/.exec(rest);
  const suffixedLetter = suffixed?.[1] === undefined ? undefined : LETTERS[suffixed[1]];
  if (suffixedLetter !== undefined && suffixed?.[2] !== undefined) {
    const mark = suffixed[2].toUpperCase();
    // Poshmark writes men's tall XXL as `2XLT`.
    const base = mark === 'T' && suffixedLetter === 'XXL' ? '2XL' : suffixedLetter;
    return [`${base}${mark}`];
  }
  const numeric = /^(00|0|[1-9]\d?)(w|p)?$/.exec(rest);
  if (numeric?.[1] !== undefined) {
    const mark = (numeric[2] ?? '').toUpperCase() || suffix;
    return [`${numeric[1]}${mark}`];
  }
  return [];
}

function spellings(letter: string): readonly string[] {
  return ALIASES[letter] ?? [letter];
}

/** The first candidate one of the size sets has, with its set. */
function find(candidates: readonly string[], sets: SizeSets): PoshmarkSize | null {
  for (const size of candidates) {
    for (const [set, sizes] of Object.entries(sets)) {
      if (sizes.includes(size)) return { set, size };
    }
  }
  return null;
}
