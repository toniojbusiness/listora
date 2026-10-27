/**
 * An adult clothing size label read into its parts, for the size labels each marketplace's own
 * size reader (`depop/sizes.ts`, `poshmark/sizes.ts`, `mercari/sizes.ts`) doesn't read by itself:
 * a fit written with the size (`4P`, `S Petite`, `PS`, `16W`, `2X`, `XL Tall`), a length mark
 * (`4S`, `0 Short`, `10L`: the inseam, not the size), a waist in inches (`27"`, `27 in.`,
 * `Waist 27`), or the waist and the size together, as Abercrombie & Fitch's women's jeans
 * label them (`27/4`, `25/0S`). Each marketplace then looks the parts up in its own lists.
 *
 * Plus sizes in X (`0X` to `6X`) read as the size they span: `0X` is a women's 14, `1X` an XL
 * (`16-18`, as Mercari's `1X (16-18)` and `XL (16-18)` say), `2X` an XXL, `3X` a 3XL, and so on.
 */
export type AdultFit = 'petite' | 'plus' | 'tall';

export interface AdultSize {
  /** A letter size: `XXS`, `XS`, `S`, `M`, `L`, `XL`, `XXL`, `3XL` to `6XL`. */
  letter: string | null;
  /** A women's numeric size: `00`, `0`, `2`, ... `24`. */
  number: string | null;
  /** A waist in inches: `27`. */
  waist: string | null;
  fit: AdultFit | null;
}

const LETTERS: Readonly<Record<string, string>> = {
  xxs: 'XXS',
  '2xs': 'XXS',
  xs: 'XS',
  s: 'S',
  small: 'S',
  m: 'M',
  medium: 'M',
  l: 'L',
  large: 'L',
  xl: 'XL',
  xxl: 'XXL',
  '2xl': 'XXL',
  xxxl: '3XL',
  '3xl': '3XL',
  '4xl': '4XL',
  '5xl': '5XL',
  '6xl': '6XL',
};

/** Plus sizes in X, as the sizes they span. */
const PLUS_X: Readonly<Record<string, { letter: string | null; number: string | null }>> = {
  '0': { letter: null, number: '14' },
  '1': { letter: 'XL', number: null },
  '2': { letter: 'XXL', number: null },
  '3': { letter: '3XL', number: null },
  '4': { letter: '4XL', number: null },
  '5': { letter: '5XL', number: null },
  '6': { letter: '6XL', number: null },
};

const FIT_WORDS: readonly (readonly [RegExp, AdultFit])[] = [
  [/\bpetites?\b/, 'petite'],
  [/\bplus(?:\s*size)?\b/, 'plus'],
  [/\btall\b/, 'tall'],
];
/** An inseam length written with the size: `8 Short`, `10 Long`. */
const LENGTH_WORDS = /\b(?:short|regular|reg|long)\b/;
const NUMBER = String.raw`(00|0|[1-9]|1\d|2[0-4])`;
const WAIST_RANGE = [20, 60] as const;

/**
 * The parts of an adult clothing size label, or `null` when the label is a plain size (`M`, `8`,
 * `32x30`), which each marketplace's reader reads by itself, or not an adult clothing size.
 */
export function readAdultSize(label: string | null): AdultSize | null {
  let text = (label ?? '').trim().toLowerCase();
  if (text === '') return null;
  let fit: AdultFit | null = null;
  let marked = false;
  for (const [pattern, word] of FIT_WORDS) {
    if (!pattern.test(text)) continue;
    fit = word;
    marked = true;
    text = text.replace(pattern, ' ');
  }
  if (LENGTH_WORDS.test(text)) {
    marked = true;
    text = text.replace(LENGTH_WORDS, ' ');
  }
  text = text.replace(/\s+/g, ' ').trim();
  const size = (parts: Partial<AdultSize>): AdultSize => ({
    letter: null,
    number: null,
    waist: null,
    fit,
    ...parts,
  });

  // A waist in inches: `27"`, `27 in.`, `27in`, `W27`, `Waist 27`.
  const waist =
    /^(\d{2})\s*(?:"|''|in\.?|inch(?:es)?)$/.exec(text)?.[1] ??
    /^(?:w|waist)\s*(\d{2})$/.exec(text)?.[1];
  if (waist !== undefined) return inRange(waist) ? size({ waist }) : null;

  // The waist and the size: `27/4`, `25 / 0S` (a length mark after the size).
  const pair = new RegExp(String.raw`^(\d{2})\s*/\s*${NUMBER}\s*[srl]?$`).exec(text);
  if (pair?.[1] !== undefined && pair[2] !== undefined && inRange(pair[1])) {
    return size({ waist: pair[1], number: pair[2] });
  }

  // Women's plus sizes: `16W` to `36W`.
  const womens = /^(1[2-9]|2\d|3[0-6])\s*w$/.exec(text)?.[1];
  if (womens !== undefined) {
    fit = 'plus';
    return size({ number: womens });
  }

  // A number with its mark: `4P` (petite), `4S` / `4R` / `4L` (an inseam length).
  const numbered = new RegExp(String.raw`^${NUMBER}\s*([psrl])?$`).exec(text);
  if (numbered?.[1] !== undefined) {
    const mark = numbered[2];
    if (mark === undefined && !marked) return null;
    if (mark === 'p') fit = 'petite';
    return size({ number: numbered[1] });
  }

  // Plus sizes in X: `1X`, `2x`.
  const plusX = /^([0-6])\s*x$/.exec(text)?.[1];
  const spanned = plusX === undefined ? undefined : PLUS_X[plusX];
  if (spanned !== undefined) {
    fit = 'plus';
    return size(spanned);
  }

  // Letters with a petite or tall mark: `PS`, `P/M`, `SP`, `XSP`, `LT`, `XLT`.
  const compact = text.replace(/[\s./-]+/g, '');
  const petiteFirst = /^p(xxs|xs|s|m|l|xl|xxl)$/.exec(compact)?.[1];
  const marks = /^(xxs|xs|s|m|l|xl|xxl|2xl|3xl)([pt])$/.exec(compact);
  if (petiteFirst !== undefined) {
    fit = 'petite';
    return size({ letter: LETTERS[petiteFirst] ?? null });
  }
  if (marks?.[1] !== undefined && marks[2] !== undefined) {
    fit = marks[2] === 'p' ? 'petite' : 'tall';
    return size({ letter: LETTERS[marks[1]] ?? null });
  }
  const letter = LETTERS[compact];
  return letter !== undefined && marked ? size({ letter }) : null;
}

function inRange(waist: string): boolean {
  const value = Number(waist);
  return value >= WAIST_RANGE[0] && value <= WAIST_RANGE[1];
}
