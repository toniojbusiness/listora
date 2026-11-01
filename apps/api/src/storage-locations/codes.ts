/**
 * Bin codes (docs/features/storage-bins.md): the short code on a bin's sticker, `B-12`. The
 * seller types it, so it is stored one way (trimmed, single spaces, capitals) and two bins can
 * never differ only by case or spacing.
 */

export const MAX_CODE_LENGTH = 32;
export const FIRST_CODE = 'B-1';

const ALLOWED = /^[A-Z0-9 ./-]+$/;
const HAS_LETTER_OR_DIGIT = /[A-Z0-9]/;

export type CodeCheck = { ok: true; code: string } | { ok: false; message: string };

/** The code as stored, or why it can't be one. */
export function normalizeCode(raw: string): CodeCheck {
  const code = raw.trim().replaceAll(/\s+/g, ' ').toUpperCase();
  if (code === '') return { ok: false, message: 'must not be blank' };
  if (code.length > MAX_CODE_LENGTH) {
    return { ok: false, message: `must be at most ${String(MAX_CODE_LENGTH)} characters` };
  }
  if (!ALLOWED.test(code) || !HAS_LETTER_OR_DIGIT.test(code)) {
    return { ok: false, message: 'may use only letters, digits, spaces, and - . /' };
  }
  return { ok: true, code };
}

/** A label as stored: trimmed, and none when blank. */
export function normalizeLabel(raw: string | undefined): string | null {
  const label = raw?.trim().replaceAll(/\s+/g, ' ');
  return label === undefined || label === '' ? null : label;
}

const SERIES = /^(.*?)(\d+)$/;

/**
 * The code to offer for the next bin: the number after the highest of the newest bin's series
 * (`B-13` after `B-12`, `SHELF 3` after `SHELF 2`), as wide as that series writes its numbers
 * (`B-010` after `B-009`), and never a code that exists. `newestFirst` is every code, newest
 * bin first.
 */
export function nextCode(newestFirst: readonly string[]): string {
  const taken = new Set(newestFirst);
  const series = newestFirst.map((code) => SERIES.exec(code)).find((match) => match !== null);
  const prefix = series?.[1] ?? 'B-';
  const width = series?.[2]?.startsWith('0') === true ? series[2].length : 1;
  let highest = 0;
  for (const code of newestFirst) {
    const match = SERIES.exec(code);
    if (match?.[1] === prefix) highest = Math.max(highest, Number(match[2]));
  }
  for (let number = highest + 1; ; number += 1) {
    const candidate = `${prefix}${String(number).padStart(width, '0')}`;
    if (candidate.length > MAX_CODE_LENGTH) return FIRST_CODE;
    if (!taken.has(candidate)) return candidate;
  }
}

const CHUNKS = /\d+|\D+/g;

/** Orders codes as people read them: `B-2` before `B-12`, then `C-1`. */
export function compareCodes(left: string, right: string): number {
  const a = left.match(CHUNKS) ?? [];
  const b = right.match(CHUNKS) ?? [];
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const x = a[index] ?? '';
    const y = b[index] ?? '';
    const bothNumbers = /^\d/.test(x) && /^\d/.test(y);
    const order = bothNumbers ? Number(x) - Number(y) : x < y ? -1 : x > y ? 1 : 0;
    if (order !== 0) return order;
  }
  return a.length - b.length || (left < right ? -1 : left > right ? 1 : 0);
}
