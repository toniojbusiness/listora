import type { OcrLine, ValueSource } from './types.ts';

/** An OCR line prepared for matching. Matching runs on `text`; sources keep the original. */
export interface PreparedLine {
  readonly index: number;
  readonly line: OcrLine;
  /** Uppercase ASCII with diacritics removed, symbols dropped, and whitespace collapsed. */
  readonly text: string;
}

/**
 * Normalizes OCR text for matching: compatibility forms (full-width `％`), accents (`ALGODÓN`),
 * trademark symbols, and Unicode dashes all reduce to plain uppercase ASCII.
 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[®™©]/g, ' ')
    .replace(/[‐-―−]/g, '-')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function prepareLines(lines: readonly OcrLine[]): PreparedLine[] {
  return lines.map((line, index) => ({ index, line, text: normalizeText(line.text) }));
}

/** Characters OCR commonly reads in place of a digit, and the digit they stand for. */
const DIGIT_CONFUSIONS: Readonly<Record<string, string>> = {
  O: '0',
  Q: '0',
  D: '0',
  I: '1',
  L: '1',
  '|': '1',
  '!': '1',
  Z: '2',
  S: '5',
  B: '8',
};

/** Characters OCR commonly reads in place of a letter, and the letter they stand for. */
const LETTER_CONFUSIONS: Readonly<Record<string, string>> = {
  '0': 'O',
  '1': 'I',
  '5': 'S',
  '8': 'B',
};

/** A character class matching a digit or a character OCR confuses with one. */
export const DIGITISH = '[0-9OQDILZSB|!]';

export interface Repaired {
  readonly text: string;
  /** True when at least one character was substituted. */
  readonly repaired: boolean;
}

/**
 * Reads a token that should be all digits, undoing OCR confusions (`I2345` -> `12345`).
 * Returns null unless at least half the characters are real digits, so words never become numbers.
 */
export function repairDigits(token: string): Repaired | null {
  let digits = '';
  let real = 0;
  for (const char of token) {
    if (char >= '0' && char <= '9') {
      digits += char;
      real += 1;
      continue;
    }
    const replacement = DIGIT_CONFUSIONS[char];
    if (replacement === undefined) return null;
    digits += replacement;
  }
  if (real * 2 < token.length) return null;
  return { text: digits, repaired: real !== token.length };
}

/** Undoes digit-for-letter confusions in a mostly alphabetic word (`C0TTON` -> `COTTON`). */
export function repairLetters(word: string): Repaired {
  let letters = 0;
  for (const char of word) if (char >= 'A' && char <= 'Z') letters += 1;
  if (letters * 2 <= word.length) return { text: word, repaired: false };
  let text = '';
  for (const char of word) text += LETTER_CONFUSIONS[char] ?? char;
  return { text, repaired: text !== word };
}

/** Levenshtein distance, stopping early once it exceeds `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) return max + 1;
    previous = current;
  }
  return previous[b.length] ?? max + 1;
}

export function ocrSource(lines: readonly PreparedLine[]): ValueSource {
  const photoId = lines[0]?.line.photoId;
  return {
    kind: 'ocr',
    lineIndexes: lines.map((line) => line.index),
    text: lines.map((line) => line.line.text).join('\n'),
    ...(photoId === undefined ? {} : { photoId }),
  };
}

/**
 * Final confidence for a value: the rule's confidence scaled by the OCR confidence of the
 * lowest-confidence line it came from, rounded to three decimals.
 */
export function lineConfidence(rule: number, lines: readonly PreparedLine[]): number {
  const ocr = Math.min(1, ...lines.map((line) => clampUnit(line.line.confidence ?? 1)));
  return Math.round(rule * ocr * 1000) / 1000;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
