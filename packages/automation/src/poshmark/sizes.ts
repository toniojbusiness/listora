/**
 * An item's size as Poshmark's listing form takes it: one size from one of the category's size
 * sets (catalog.ts), for example `M` in Standard, `14W` in Plus, `XLT` in Big & Tall, `2T` in
 * Girls.
 *
 * `poshmarkSize` turns the tag's size into Poshmark's spelling deterministically (`Medium` → `M`,
 * `2XL` → `XXL`, `32x30` → `32`, `10 1/2` → `10.5`, `34DD` → `34E (DD)`, `S Petite` → `SP`,
 * `6-9 months` → `6-9 Months`, `Boys 8` → `8` in Boys) and keeps it only when one of the
 * category's size sets has it, so the form is never asked for a size it lacks. A one-size
 * category takes its one size, which the form chooses by itself. Juniors and Maternity are left
 * out: nothing on an item says it is either. A kids' size that Girls and Boys both have needs
 * the size to say which (`Girls 8`); without that it is not guessed.
 */
import { readAdultSize } from '../adapter/adult-size.ts';
import type { PoshmarkDepartment, SizeSets } from './catalog.ts';

export interface PoshmarkSize {
  /** The size set's tab in the size picker: `Standard`, `Plus`, `Petite`, `Big & Tall`, `Girls`. */
  set: string;
  /** Poshmark's id of the size: `M`, `14W`, `10.5`, `34E (DD)`, `2TG`. */
  size: string;
  /** What its button in the size picker shows: `M`, `Neck 15.5`, `Waist 32`, `2T`. */
  label: string;
  /** What the picker shows once it is chosen: `M`, `2T (Girl)`, `OS`. */
  chosen: string;
}

/** The sets Listora never picks: nothing on an item says it is a juniors' or maternity size. */
const UNTOLD_SETS = new Set(['Juniors', 'Maternity']);

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

/** Bedding sizes as Poshmark's ids write them. */
const BEDDING: Readonly<Record<string, string>> = {
  twin: 'TWIN',
  twinxl: 'TWINXL',
  full: 'FULL',
  double: 'FULL',
  queen: 'QUEEN',
  king: 'KING',
  calking: 'CALKING',
  californiaking: 'CALKING',
};

/**
 * Poshmark's size for the item's size label in a category with these size sets, or `null`. The
 * department decides how a kids' size is read.
 */
export function poshmarkSize(
  label: string | null,
  system: string | null,
  sets: SizeSets,
  department: PoshmarkDepartment,
): PoshmarkSize | null {
  const usable = sets.filter((set) => !UNTOLD_SETS.has(set.name));
  // A one-size category: the form chooses its size by itself (the first set's, for Kids).
  const [first] = usable;
  if (first !== undefined && usable.every((set) => set.sizes.length === 1)) {
    return sizeOf(first, 0);
  }
  const text = label?.trim() ?? '';
  if (text === '') return null;
  if (system === 'one_size' || /^(one\s*size|os|o\/s)$/i.test(text)) {
    return find(usable, (id) => id === 'OS' || /^OS(BB|B|G)$/.test(id));
  }
  // Poshmark's sizes are US sizes; a UK or EU size is never converted by guesswork.
  if (system === 'uk' || system === 'eu') return null;
  if (department === 'Kids') return kidsSize(text, usable);
  for (const candidate of [...candidates(text), ...adultCandidates(text)]) {
    const found = find(usable, (id) => id === candidate);
    if (found !== null) return found;
  }
  return null;
}

/**
 * An adult size with its fit or length written another way than Poshmark's (`PS`, `Petite M`,
 * `4S`, `0 Short`, `L Tall`), a waist in inches (`27"`, `W27`), or a waist and a size together
 * (`27/4`), in Poshmark's spelling: a petite size in its Petite set (`SP`, `4P`, `27P`), a plus
 * size in Plus (`16W`, `16`), and otherwise the size itself (women's sets have no Tall).
 */
function adultCandidates(text: string): string[] {
  const adult = readAdultSize(text);
  if (adult === null) return [];
  const sizes = [adult.waist, adult.number, adult.letter].flatMap((size) =>
    size === null ? [] : [size],
  );
  return sizes.flatMap((size) => {
    switch (adult.fit) {
      case 'petite':
        return candidates(`${size} petite`);
      case 'plus':
        return /^\d+$/.test(size) ? [`${size}W`, size] : candidates(size);
      case 'tall':
      case null:
        return candidates(size);
    }
  });
}

function sizeOf(set: SizeSets[number], index: number): PoshmarkSize | null {
  const entry = set.sizes[index];
  if (entry === undefined) return null;
  const [size, label, chosen] = entry;
  return { set: set.name, size, label, chosen };
}

/** The first size, in set order, whose id passes `matches`. */
function find(sets: SizeSets, matches: (id: string) => boolean): PoshmarkSize | null {
  for (const set of sets) {
    const index = set.sizes.findIndex(([id]) => matches(id));
    if (index >= 0) return sizeOf(set, index);
  }
  return null;
}

/**
 * A kids' size. Poshmark's kids' ids carry their set (`2TG`, `8B`, `6-9MB`, `5BB` for a baby's
 * shoe), so the tag's size is spelled with each set's mark. A size both Girls and Boys have needs
 * the label to name one (`Girls 8`, `8 Boys`, `Boy's M`).
 */
function kidsSize(text: string, sets: SizeSets): PoshmarkSize | null {
  const lower = text.toLowerCase();
  const named = /\bgirl'?s?\b/.test(lower) ? 'Girls' : /\bboy'?s?\b/.test(lower) ? 'Boys' : null;
  const bare = lower
    .replace(/\b(girl|boy)'?s?\b/g, '')
    .replace(/\b(toddler|little|big|kids?)\b/g, '')
    .trim();
  const months = /^(\d{1,2})(?:\s*-\s*(\d{1,2}))?\s*(?:m|mo|mos|months?)$/.exec(bare);
  if (months?.[1] !== undefined) {
    const id = months[2] === undefined ? `${months[1]}M` : `${months[1]}-${months[2]}M`;
    return find(sets, (candidate) => candidate === `${id}B`);
  }
  if (/^newborn$|^nb$/.test(bare)) return find(sets, (id) => id === 'Newborn');
  if (/^preemie$/.test(bare)) return find(sets, (id) => id === 'Preemie');
  const toddler = /^(\d)\s*t$/.exec(bare);
  const spellings = toddler?.[1] !== undefined ? [`${toddler[1]}T`] : candidates(bare);
  const marks: Readonly<Record<string, readonly string[]>> = {
    Girls: ['G'],
    Boys: ['B'],
    Baby: ['BB'],
  };
  const matches = sets.flatMap((set) => {
    if (named !== null && set.name !== named) return [];
    const index = set.sizes.findIndex(([id]) =>
      spellings.some((spelling) => (marks[set.name] ?? []).some((mark) => id === spelling + mark)),
    );
    const found = index < 0 ? null : sizeOf(set, index);
    return found === null ? [] : [found];
  });
  const [only, ...others] = matches;
  // Girls and Boys both have it, and the size doesn't say which: never guessed.
  return only !== undefined && others.length === 0 ? only : null;
}

/** The spellings a label may have on Poshmark, most likely first. */
function candidates(label: string): string[] {
  const token = label
    .toLowerCase()
    .replace(/^us\s*/, '')
    .replace(/^(neck|waist)\s+/, '');
  const compact = token.replace(/[\s.-]+/g, '');

  const bedding = BEDDING[compact];
  if (bedding !== undefined) return [bedding];

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
  const numeric = /^(00|0|[1-9]\d?)(w|p|x)?$/.exec(rest);
  if (numeric?.[1] !== undefined) {
    const mark = (numeric[2] ?? '').toUpperCase() || suffix;
    return [`${numeric[1]}${mark}`];
  }
  return [];
}

function spellings(letter: string): readonly string[] {
  return ALIASES[letter] ?? [letter];
}
