import {
  DIGITISH,
  lineConfidence,
  ocrSource,
  repairDigits,
  type PreparedLine,
} from './normalize.ts';
import type { Parsed } from './types.ts';

/*
 * Registered identification numbers printed on US and Canadian garment labels.
 *
 * - RN: FTC Registered Identification Number, "RN 12345" or "RN#123456" (5 or 6 digits).
 * - CA: Canadian CA Identification Number, "CA 12345" or "CA#12345" (5 digits).
 *
 * These parsers only read the number. Listora never looks numbers up in the FTC RN database
 * (an interactive system marked CUI); RN-to-brand knowledge comes from the model and from
 * mappings the user confirms.
 */

const LABEL_TAIL = String.raw`(?: ?(?:NO\.?|NUMBER|#|:))*\s*#?\s*`;
const RN_PATTERN = new RegExp(
  String.raw`(?<![A-Z0-9])R\.? ?N\.?${LABEL_TAIL}(${DIGITISH}{5,6})(?![0-9A-Z])`,
  'g',
);
const CA_PATTERN = new RegExp(
  String.raw`(?<![A-Z0-9])C\.? ?A\.?${LABEL_TAIL}(${DIGITISH}{5})(?![0-9A-Z]|-[0-9])`,
  'g',
);

/** At least this many characters of the number must be real digits, not OCR confusions. */
const MIN_REAL_DIGITS = 3;

const RN_LABEL_AT_END = new RegExp(String.raw`(?<![A-Z0-9])R\.? ?N\.?${LABEL_TAIL}$`);
const CA_LABEL_AT_END = new RegExp(String.raw`(?<![A-Z0-9])C\.? ?A\.?${LABEL_TAIL}$`);

export function parseRnNumbers(lines: readonly PreparedLine[]): Parsed<string>[] {
  return parseNumbers(lines, {
    pattern: RN_PATTERN,
    labelAtEnd: RN_LABEL_AT_END,
    confidence: RN_CONFIDENCE,
    accept: () => true,
  });
}

export function parseCaNumbers(lines: readonly PreparedLine[]): Parsed<string>[] {
  return parseNumbers(lines, {
    pattern: CA_PATTERN,
    labelAtEnd: CA_LABEL_AT_END,
    confidence: CA_CONFIDENCE,
    accept: isNotAddress,
  });
}

const RN_CONFIDENCE = { clean: 0.95, repaired: 0.8, wrapped: 0.85 } as const;
const CA_CONFIDENCE = { clean: 0.9, repaired: 0.75, wrapped: 0.8 } as const;

/**
 * A "CA 90012" that follows a comma ("LOS ANGELES, CA 90012") or precedes "USA" is a
 * California ZIP code in an address, not a CA number.
 */
function isNotAddress(text: string, start: number, end: number): boolean {
  const before = text.slice(0, start).trimEnd();
  const after = text.slice(end);
  return !before.endsWith(',') && !/^\s*,?\s*U\.?S\.?A\b/.test(after);
}

interface NumberRule {
  readonly pattern: RegExp;
  /** Matches a label that ends its line, so the number is on the next line ("RN" | "12345"). */
  readonly labelAtEnd: RegExp;
  readonly confidence: {
    readonly clean: number;
    readonly repaired: number;
    readonly wrapped: number;
  };
  readonly accept: (text: string, start: number, end: number) => boolean;
}

function parseNumbers(lines: readonly PreparedLine[], rule: NumberRule): Parsed<string>[] {
  const results: Parsed<string>[] = [];
  lines.forEach((line, position) => {
    const next = lines[position + 1];
    const wrapped = next !== undefined && rule.labelAtEnd.test(line.text);
    const sourceLines = wrapped ? [line, next] : [line];
    const text = wrapped ? `${line.text} ${next.text}` : line.text;
    for (const match of text.matchAll(rule.pattern)) {
      const raw = match[1];
      if (raw === undefined) continue;
      const end = match.index + match[0].length;
      // In a joined pair, only a match that crosses the line break is new.
      const crossesBreak = match.index < line.text.length && end > line.text.length;
      if (wrapped && !crossesBreak) continue;
      const number = repairDigits(raw);
      if (number === null || countDigits(raw) < MIN_REAL_DIGITS) continue;
      if (!rule.accept(text, match.index, end)) continue;
      const confidence = wrapped
        ? rule.confidence.wrapped
        : number.repaired
          ? rule.confidence.repaired
          : rule.confidence.clean;
      results.push({
        value: number.text,
        confidence: lineConfidence(confidence, sourceLines),
        source: ocrSource(sourceLines),
      });
    }
    // A wrapped label can share its line with a complete number ("CA 12345 RN").
    if (wrapped) results.push(...parseNumbers([line], rule));
  });
  return results;
}

function countDigits(text: string): number {
  return text.replace(/[^0-9]/g, '').length;
}
