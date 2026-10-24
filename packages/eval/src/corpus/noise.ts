import type { BarcodeRead, OcrLine } from '@listora/tag-parse';

import { humanReadable } from './barcode.ts';
import type { Random } from './random.ts';
import { MATERIAL_DISPLAY } from './vocabulary.ts';

/*
 * Simulated on-device reads of a printed tag. The model reproduces errors Vision makes on real
 * labels, at fixed rates, so parsers are measured against realistic input rather than clean text:
 *
 * - digit/letter confusions inside numbers and fiber words (O/0, I/1, S/5, B/8);
 * - dropped or added spaces around `#`, `:`, and `%`;
 * - lines split at a natural break ("MADE IN" | "CHINA") or merged with their neighbor;
 * - barcode bars that fail to decode, and human-readable digits that OCR garbles.
 *
 * Most misreads leave enough evidence to recover the fact. A few, at low fixed rates, do not
 * (`UNRECOVERABLE_RATES`): a dropped `%`, a country name misread in two letters, a barcode whose
 * bars fail and whose digits are garbled. A perfect parser therefore scores a little under 100%,
 * which keeps the accuracy figure honest and leaves room to measure improvements.
 *
 * Vision reports a UPC-A barcode as a 13-digit EAN-13 with a leading 0, and so does this model.
 */

export type LineRole =
  | 'brand'
  | 'rn'
  | 'ca'
  | 'rnca'
  | 'style'
  | 'size_labeled'
  | 'size_bare'
  | 'fiber'
  | 'fiber_header'
  | 'origin'
  | 'care'
  | 'price'
  | 'distractor';

export type GenBlock =
  | { readonly kind: 'line'; readonly text: string; readonly role: LineRole }
  | { readonly kind: 'barcode'; readonly digits: string; readonly valid: boolean };

interface NoisyLine {
  text: string;
  role: LineRole | 'barcode_digits';
  noisy: boolean;
}

export const NOISE_RATES = {
  digitConfusion: 0.12,
  percentConfusion: 0.05,
  materialConfusion: 0.06,
  spacing: 0.15,
  split: 0.1,
  merge: 0.07,
  lowercase: 0.05,
  barcodeUnread: 0.1,
  barcodeDigitsGarbled: 0.15,
} as const;

export const UNRECOVERABLE_RATES = {
  percentDropped: 0.015,
  countryMisread: 0.015,
  barcodeLost: 0.03,
} as const;

/** Roles whose line can be joined to the following line without changing what it means. */
const MERGE_SAFE = new Set<NoisyLine['role']>([
  'brand',
  'rn',
  'ca',
  'rnca',
  'style',
  'size_labeled',
  'origin',
  'care',
  'price',
]);
const MERGE_AFTER_FIBER = new Set<NoisyLine['role']>(['origin', 'rn', 'ca', 'rnca', 'care']);

export function simulateOcr(
  blocks: readonly GenBlock[],
  random: Random,
): { lines: OcrLine[]; barcodes: BarcodeRead[] } {
  const lines: NoisyLine[] = [];
  const barcodes: BarcodeRead[] = [];
  for (const block of blocks) {
    if (block.kind === 'barcode') {
      readBarcode(block, random, lines, barcodes);
      continue;
    }
    lines.push(...noisyLines(block.text, block.role, random));
  }
  return {
    lines: mergeLines(lines, random).map(({ text, noisy }) => ({
      text,
      confidence: noisy ? 0.5 : 1,
    })),
    barcodes,
  };
}

function readBarcode(
  block: Extract<GenBlock, { kind: 'barcode' }>,
  random: Random,
  lines: NoisyLine[],
  barcodes: BarcodeRead[],
): void {
  const lost = block.valid && random.chance(UNRECOVERABLE_RATES.barcodeLost);
  // A scanner verifies the check digit, so an invalid code never decodes.
  const decoded = block.valid && !lost && !random.chance(NOISE_RATES.barcodeUnread);
  if (decoded) {
    barcodes.push({
      payload: block.digits.length === 12 ? `0${block.digits}` : block.digits,
      symbology: 'VNBarcodeSymbologyEAN13',
    });
  }
  let text = humanReadable(block.digits);
  let noisy = false;
  // Garble the printed digits only when the bars were read, so every valid code stays readable.
  if (lost || (decoded && random.chance(NOISE_RATES.barcodeDigitsGarbled))) {
    const position = random.pick([...text.matchAll(/[0-9]/g)].map((match) => match.index));
    const digit = Number(text[position]);
    text = `${text.slice(0, position)}${String((digit + random.int(1, 9)) % 10)}${text.slice(position + 1)}`;
    noisy = true;
  }
  lines.push({ text, role: 'barcode_digits', noisy });
}

function noisyLines(original: string, role: LineRole, random: Random): NoisyLine[] {
  let text = original;
  let noisy = false;
  const apply = (rate: number, change: (value: string) => string): void => {
    if (!random.chance(rate)) return;
    const changed = change(text);
    if (changed !== text) noisy = true;
    text = changed;
  };

  if (role === 'rn' || role === 'ca' || role === 'rnca' || role === 'style') {
    apply(NOISE_RATES.digitConfusion, (value) => confuseDigit(value, random));
  }
  if (role === 'fiber') {
    apply(NOISE_RATES.percentConfusion, (value) =>
      value.replace(/\b(100|[1-9]0)%/, (match) => match.replace(/0/, 'O')),
    );
    apply(NOISE_RATES.materialConfusion, (value) => confuseWord(value, random));
    apply(UNRECOVERABLE_RATES.percentDropped, (value) => value.replace(/([0-9])%/, '$1'));
  }
  if (role === 'origin') {
    apply(UNRECOVERABLE_RATES.countryMisread, (value) => misreadCountry(value));
  }
  apply(NOISE_RATES.spacing, (value) => respace(value, random));
  if (role !== 'size_bare') {
    apply(NOISE_RATES.lowercase, (value) => value.toLowerCase());
  }

  const parts = random.chance(NOISE_RATES.split) ? split(text, role) : [text];
  if (parts.length > 1) noisy = true;
  return parts.map((part) => ({ text: part, role, noisy }));
}

const DIGIT_LOOKALIKES: Readonly<Record<string, readonly string[]>> = {
  '0': ['O'],
  '1': ['I', 'l'],
  '5': ['S'],
  '8': ['B'],
};

/**
 * Replaces one digit in a 5+ character run of digits (an RN, CA, or numeric style segment)
 * with a lookalike letter. At most one per run, as a single misread character.
 */
function confuseDigit(text: string, random: Random): string {
  const runs = [...text.matchAll(/(?<![A-Za-z0-9])[0-9]{3,}(?![A-Za-z0-9])/g)];
  const candidates = runs.flatMap((run) =>
    Array.from(run[0]).flatMap((char, offset) =>
      DIGIT_LOOKALIKES[char] === undefined ? [] : [run.index + offset],
    ),
  );
  if (candidates.length === 0) return text;
  const position = random.pick(candidates);
  const lookalike = random.pick(DIGIT_LOOKALIKES[text[position] ?? ''] ?? ['']);
  return `${text.slice(0, position)}${lookalike}${text.slice(position + 1)}`;
}

/**
 * Misreads one letter of a material name of six or more letters: an O as a zero, or one
 * similar-shape letter. Part labels and other words are left alone.
 */
function confuseWord(text: string, random: Random): string {
  const words = [...text.matchAll(/[A-Za-z]{6,}/g)].filter((word) =>
    CONFUSABLE_MATERIALS.has(word[0].toUpperCase()),
  );
  if (words.length === 0) return text;
  const word = random.pick(words);
  const offset = random.int(1, word[0].length - 2);
  const position = word.index + offset;
  const char = text[position] ?? '';
  const swaps: Readonly<Record<string, string>> = {
    O: '0',
    o: '0',
    E: 'F',
    e: 'c',
    N: 'H',
    n: 'm',
    C: 'G',
    c: 'e',
    T: 'I',
    t: 'f',
    R: 'P',
    r: 'n',
  };
  const replacement = swaps[char];
  if (replacement === undefined) return text;
  return `${text.slice(0, position)}${replacement}${text.slice(position + 1)}`;
}

const CONFUSABLE_MATERIALS = new Set(
  Object.values(MATERIAL_DISPLAY)
    .flatMap(({ en, fr, es }) => [...en, fr, es])
    .filter((name) => /^[A-Z]{6,}$/.test(name)),
);

/** Corrupts two letters of the word after "IN"/"EN"/"OF", beyond what fuzzy matching accepts. */
function misreadCountry(text: string): string {
  return text.replace(
    /(\b(?:IN|In|in|EN|En|en|OF|Of|of) )([A-Za-z])([A-Za-z])([A-Za-z])/,
    (_, phrase: string, first: string, second: string, third: string) =>
      `${phrase}${first}${second === 'X' ? 'Q' : 'X'}${third === 'Q' ? 'X' : 'Q'}`,
  );
}

function respace(text: string, random: Random): string {
  switch (random.int(0, 2)) {
    case 0:
      return text.replace(/([#:]) /, '$1');
    case 1:
      return text.replace(/% /, '%');
    default:
      return text.replace(/ /, '  ');
  }
}

/** Splits at a break OCR commonly makes: after "MADE IN", after a size label, between fibers. */
function split(text: string, role: LineRole): string[] {
  if (role === 'origin') {
    const match = /^(.*?\b(?:MADE|Made|made) (?:IN|In|in))\s+(.+)$/.exec(text);
    if (match?.[1] !== undefined && match[2] !== undefined && !match[2].includes('/')) {
      return [match[1], match[2]];
    }
  }
  if (role === 'rn' || role === 'ca') {
    const match = /^((?:RN|CA|R\.N\.)\D*?)\s*([0-9].*)$/i.exec(text);
    if (match?.[1] !== undefined && match[2] !== undefined) return [match[1], match[2]];
  }
  if (role === 'size_labeled') {
    const match = /^((?:SIZE|Size|size):?)\s+(\S+)$/.exec(text);
    if (match?.[1] !== undefined && match[2] !== undefined) return [match[1], match[2]];
  }
  if (role === 'fiber' && /^[0-9]/.test(text)) {
    const match = /^(.*?%\s*[^%]+?)[\s,/]+([0-9]{1,3}%.*)$/.exec(text);
    if (match?.[1] !== undefined && match[2] !== undefined) return [match[1], match[2]];
  }
  return [text];
}

function mergeLines(lines: readonly NoisyLine[], random: Random): NoisyLine[] {
  const merged: NoisyLine[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const next = lines[i + 1];
    if (line === undefined) continue;
    const safe =
      next !== undefined &&
      ((MERGE_SAFE.has(line.role) && MERGE_SAFE.has(next.role)) ||
        (line.role === 'fiber' && MERGE_AFTER_FIBER.has(next.role))) &&
      !endsWithBreak(line.text);
    if (safe && random.chance(NOISE_RATES.merge)) {
      merged.push({ text: `${line.text} ${next.text}`, role: next.role, noisy: true });
      i += 1;
      continue;
    }
    merged.push(line);
  }
  return merged;
}

/** A split fragment such as "MADE IN", "SIZE", or "RN#" must stay at the end of its line. */
function endsWithBreak(text: string): boolean {
  return /(?:\b(?:IN|In|in)|(?:SIZE|Size|size):?|\b(?:RN|CA|rn|ca|R\.N\.)\W*)$/.test(text);
}
