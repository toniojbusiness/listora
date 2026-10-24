import { COUNTRY_SPELLINGS, type CountryCode } from './countries.ts';
import {
  editDistance,
  lineConfidence,
  ocrSource,
  repairLetters,
  type PreparedLine,
} from './normalize.ts';
import type { Parsed } from './types.ts';

/*
 * Country of origin from "Made in ..." phrases in English, Spanish, French, Italian, and
 * German. Only a manufacturing phrase counts: "Designed in California" is not an origin. A
 * phrase that ends its line ("MADE IN" above "VIET NAM") continues on the next line.
 */

// The space inside a phrase is optional because OCR often drops it ("PRODUCTOF ITALY").
const ORIGIN_PHRASE =
  /(?<![A-Z])(?:MADE ?IN|ASSEMBLED ?IN|MANUFACTURED ?IN|PRODUCT ?OF|HECHO ?EN|FABRICADO ?EN|ELABORADO ?EN|FABRIQUE ?(?:EN|AU|AUX)|FATTO ?IN|PRODOTTO ?IN|HERGESTELLT ?IN)\b\s*:?\s*/g;

const CONFIDENCE = { exact: 0.95, wrapped: 0.85, approximate: 0.8 } as const;
const FUZZY_MIN_LENGTH = 5;

export function parseOrigins(lines: readonly PreparedLine[]): Parsed<CountryCode>[] {
  const results: Parsed<CountryCode>[] = [];
  lines.forEach((line, position) => {
    for (const match of line.text.matchAll(ORIGIN_PHRASE)) {
      let remainder = line.text.slice(match.index + match[0].length);
      let sourceLines = [line];
      const next = lines[position + 1];
      if (remainder.trim() === '' && next) {
        remainder = next.text;
        sourceLines = [line, next];
      }
      const country = matchCountry(remainder);
      if (country === null) continue;
      const rule = country.approximate
        ? CONFIDENCE.approximate
        : sourceLines.length > 1
          ? CONFIDENCE.wrapped
          : CONFIDENCE.exact;
      results.push({
        value: country.code,
        confidence: lineConfidence(rule, sourceLines),
        source: ocrSource(sourceLines),
      });
    }
  });
  return results;
}

/** Matches the country name that starts `text` ("U.S.A. OF IMPORTED FABRIC" -> US). */
export function matchCountry(text: string): { code: CountryCode; approximate: boolean } | null {
  const cleaned = text
    .replace(/\./g, '')
    .replace(/^\s*(?:THE|LA|LE|EL|L')\s+/, '')
    .trim();
  const tokens = cleaned.split(/[\s/,;]+/).map((token) => repairLetters(token));
  const words = tokens.map((token) => token.text);
  const repaired = tokens.slice(0, 4).some((token) => token.repaired);
  const joined = words.join(' ');
  for (const { code, name } of COUNTRY_SPELLINGS) {
    if (joined === name || joined.startsWith(`${name} `)) return { code, approximate: repaired };
  }
  const [first] = words;
  if (first === undefined || first.length < FUZZY_MIN_LENGTH) return null;
  const close = COUNTRY_SPELLINGS.filter(
    ({ name }) =>
      !name.includes(' ') && name.length >= FUZZY_MIN_LENGTH && editDistance(first, name, 1) <= 1,
  );
  const codes = new Set(close.map(({ code }) => code));
  const [code] = codes;
  return codes.size === 1 && code !== undefined ? { code, approximate: true } : null;
}
