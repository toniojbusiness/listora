import { lineConfidence, ocrSource, repairDigits, type PreparedLine } from './normalize.ts';
import type { Parsed } from './types.ts';

/*
 * Style and product numbers, read only after an explicit label ("STYLE # 41872",
 * "ART. NO. AB1234", "MODEL: CW2288-111"). Unlabeled alphanumerics are too ambiguous to report.
 * A value must contain at least two digits, so "STYLE MEETS COMFORT" yields nothing.
 */

const STYLE_LABEL = String.raw`(?:STYLE(?: ?(?:NO\.?|NUMBER|#))?|STY\.?|ART(?:ICLE)?\.? ?(?:NO\.?|NR\.?|#|NUMBER)|ITEM ?(?:NO\.?|NUMBER|#)|PROD(?:UCT)?\.? ?(?:NO\.?|NUMBER|#|CODE|ID)|MODEL(?: ?(?:NO\.?|NUMBER|#))?|REF\.?(?: ?NO\.?)?)`;
const STYLE_PATTERN = new RegExp(
  String.raw`(?<![A-Z])${STYLE_LABEL}[\s:#.]*([A-Z0-9|][A-Z0-9|\-./]*[A-Z0-9|])`,
  'g',
);
const MIN_DIGITS = 2;
const MIN_LENGTH = 3;
const MAX_LENGTH = 24;

const CONFIDENCE = { clean: 0.85, repaired: 0.7 } as const;

export function parseStyleNumbers(lines: readonly PreparedLine[]): Parsed<string>[] {
  const results: Parsed<string>[] = [];
  for (const line of lines) {
    for (const match of line.text.matchAll(STYLE_PATTERN)) {
      const raw = match[1];
      if (raw === undefined) continue;
      const value = repairStyle(raw.replace(/[-./]+$/, ''));
      if (value === null) continue;
      results.push({
        value: value.text,
        confidence: lineConfidence(value.repaired ? CONFIDENCE.repaired : CONFIDENCE.clean, [line]),
        source: ocrSource([line]),
      });
    }
  }
  return results;
}

/**
 * Repairs OCR confusions in numeric segments (`CW22B8-11l` -> `CW2288-111`). In the first
 * segment, letters before the first real digit are a prefix and stay letters (`SI4205`); a
 * segment after a separator is a numeric code, so it is repaired whole (`DY7227-O97`).
 */
function repairStyle(raw: string): { text: string; repaired: boolean } | null {
  let repaired = false;
  const segments = raw.split(/([-./])/).map((segment, index) => {
    const firstDigit = segment.search(/[0-9]/);
    if (firstDigit < 0) return segment;
    const start = index === 0 ? firstDigit : 0;
    const digits = repairDigits(segment.slice(start));
    if (digits === null) return segment;
    repaired ||= digits.repaired;
    return `${segment.slice(0, start)}${digits.text}`;
  });
  const text = segments.join('');
  const digitCount = text.replace(/[^0-9]/g, '').length;
  if (digitCount < MIN_DIGITS || text.length < MIN_LENGTH || text.length > MAX_LENGTH) return null;
  return { text, repaired };
}
