import { lineConfidence, ocrSource, type PreparedLine } from './normalize.ts';
import type { Parsed, Size, SizeSystem } from './types.ts';

/*
 * Size tokens. A value is reported only with evidence that it is a size: an explicit system
 * ("US 8", "38 EU"), a waist/inseam form ("W32 L30"), a size label ("SIZE M", "TALLA: 8"), or
 * a line that holds nothing but size tokens ("S/P/CH"). Bare letters inside other text are
 * never sizes.
 */

const LABEL_WORDS = String.raw`(?:SIZE|SZ|TALLA|TAILLE|TAGLIA|GROSSE|GROESSE)`;
const SIZE_LABEL = new RegExp(String.raw`(?<![A-Z])${LABEL_WORDS}\b\.?`);
const LABEL_PREFIX = new RegExp(String.raw`^(?:[\s/:|.-]*${LABEL_WORDS}\b\.?)*[\s/:|.-]*`);

const SYSTEMS: Readonly<Record<string, SizeSystem>> = {
  US: 'us',
  U5: 'us',
  USA: 'us',
  UK: 'uk',
  EU: 'eu',
  EUR: 'eu',
  EUROPE: 'eu',
};
const SYSTEM_NUMBER = String.raw`([0-9]{1,2}(?:[.,]5)?)`;
/** A shoe width after a system size ("US 10.5 M", "9 US W") is part of it, not a letter size. */
const SHOE_WIDTH = String.raw`(?:\s*(?:[BDEMNW]|[2-6]E|EE|WW|XW)(?![A-Z0-9]))?`;
// `U5` is OCR's most common misread of `US` ahead of a number.
const SYSTEM_PREFIXED = new RegExp(
  String.raw`(?<![A-Z0-9])(US|U5|USA|UK|EUR|EUROPE|EU)\s*:?\s*${SYSTEM_NUMBER}(?![0-9]|[.,][0-9])${SHOE_WIDTH}`,
  'g',
);
const SYSTEM_SUFFIXED = new RegExp(
  String.raw`(?<![0-9A-Z.,])${SYSTEM_NUMBER}\s*(US|UK|EUR|EU)(?![A-Z])${SHOE_WIDTH}`,
  'g',
);
const SYSTEM_RANGES: Readonly<Record<'us' | 'uk' | 'eu', readonly [number, number]>> = {
  us: [0, 24],
  uk: [0, 30],
  eu: [15, 60],
};

const WAIST_INSEAM_PATTERNS: readonly { pattern: RegExp; explicit: boolean }[] = [
  {
    pattern: /(?<![A-Z0-9])W\s*:?\s*([0-9]{2})\s*[/,]?\s*L\s*:?\s*([0-9]{2})(?![0-9])/g,
    explicit: true,
  },
  { pattern: /(?<![0-9])([0-9]{2})\s*W\s*[/,X]?\s*([0-9]{2})\s*L(?![A-Z])/g, explicit: true },
  {
    pattern: /WAIST\s*:?\s*([0-9]{2})\s*[/,]?\s*(?:INSEAM|LENGTH|LEG)\s*:?\s*([0-9]{2})(?![0-9])/g,
    explicit: true,
  },
  { pattern: /(?<![0-9.])([0-9]{2})\s*[X×]\s*([0-9]{2})(?![0-9])/g, explicit: false },
];
const WAIST_RANGE = [22, 56] as const;
const INSEAM_RANGE = [24, 40] as const;

const ONE_SIZE = /(?<![A-Z])(?:ONE ?SIZE|OSFA|OSFM|O\/S)(?![A-Z])/g;

const LETTER_SIZES: Readonly<Record<string, string>> = {
  XXS: 'XXS',
  '2XS': 'XXS',
  XXSMALL: 'XXS',
  XS: 'XS',
  XSMALL: 'XS',
  S: 'S',
  SM: 'S',
  SMALL: 'S',
  M: 'M',
  MED: 'M',
  MEDIUM: 'M',
  L: 'L',
  LG: 'L',
  LRG: 'L',
  LARGE: 'L',
  XL: 'XL',
  XLG: 'XL',
  XLARGE: 'XL',
  XXL: 'XXL',
  '2XL': 'XXL',
  XXLARGE: 'XXL',
  XXXL: 'XXXL',
  '3XL': 'XXXL',
  XXXLARGE: 'XXXL',
  XXXXL: '4XL',
  '4XL': '4XL',
  '5XL': '5XL',
};

/** Tokens that share a size-only line with a letter size: Spanish/Mexican and fit markers. */
const SIZE_COMPANIONS = new Set([
  'P',
  'CH',
  'G',
  'EG',
  'XG',
  'T',
  'PT',
  'TALL',
  'PETITE',
  'REG',
  'REGULAR',
  'SHORT',
  'LONG',
]);

const NUMERIC = /^(?:00|[0-9]{1,2}(?:\.5)?)$/;
const BARE_NUMERIC_MAX = 24;
const LABELED_NUMERIC_MAX = 60;

const CONFIDENCE = {
  system: 0.9,
  waistInseamExplicit: 0.9,
  waistInseamLabeled: 0.85,
  waistInseamBare: 0.75,
  oneSize: 0.85,
  labeledLetter: 0.9,
  labeledNumeric: 0.85,
  sizeOnlyLetter: 0.8,
  bareNumeric: 0.6,
} as const;

interface Finding {
  readonly size: Size;
  readonly rule: number;
}

export function parseSizes(lines: readonly PreparedLine[]): Parsed<Size>[] {
  const results: Parsed<Size>[] = [];
  lines.forEach((line, position) => {
    const label = SIZE_LABEL.exec(line.text);
    let sourceLines = [line];
    let text = line.text;
    let labelEnd = label ? label.index + label[0].length : -1;
    // A label alone on its line ("SIZE" above "M") labels the next line.
    const next = lines[position + 1];
    if (label && text.slice(labelEnd).replace(LABEL_PREFIX, '') === '' && next) {
      sourceLines = [line, next];
      text = `${text} ${next.text}`;
      labelEnd = line.text.length;
    }
    for (const finding of findSizes(text, labelEnd)) {
      results.push({
        value: finding.size,
        confidence: lineConfidence(finding.rule, sourceLines),
        source: ocrSource(sourceLines),
      });
    }
  });
  return results;
}

/** `labelEnd` is the index just past a size label, or -1 when the text has none. */
function findSizes(original: string, labelEnd: number): Finding[] {
  const findings: Finding[] = [];
  const labeled = labelEnd >= 0;
  let text = expandLetterWords(original);

  // Twice: blanking one size can expose a label OCR glued to it ("UK 8EU 36").
  for (let pass = 0; pass < 2; pass += 1) {
    text = consume(text, SYSTEM_PREFIXED, (match) => addSystemSize(findings, match[1], match[2]));
  }
  text = consume(text, SYSTEM_SUFFIXED, (match) => addSystemSize(findings, match[2], match[1]));

  for (const { pattern, explicit } of WAIST_INSEAM_PATTERNS) {
    text = consume(text, pattern, (match, rest) => {
      const waist = Number(match[1]);
      const inseam = Number(match[2]);
      if (!inRange(waist, WAIST_RANGE) || !inRange(inseam, INSEAM_RANGE)) return false;
      if (!explicit && !labeled && sizeOnlyTokens(rest) === null) return false;
      const rule = explicit
        ? CONFIDENCE.waistInseamExplicit
        : labeled
          ? CONFIDENCE.waistInseamLabeled
          : CONFIDENCE.waistInseamBare;
      findings.push({
        size: { system: 'waist_inseam', value: `${String(waist)}x${String(inseam)}` },
        rule,
      });
      return true;
    });
  }

  text = consume(text, ONE_SIZE, () => {
    findings.push({ size: { system: 'one_size', value: 'OS' }, rule: CONFIDENCE.oneSize });
    return true;
  });

  if (labeled) {
    const first = tokensOf(text.slice(labelEnd).replace(LABEL_PREFIX, ''))[0];
    if (first !== undefined) {
      const letter = letterSize(first);
      if (letter !== null) {
        findings.push(letter.finding(CONFIDENCE.labeledLetter));
      } else if (NUMERIC.test(first) && Number(first) <= LABELED_NUMERIC_MAX) {
        findings.push(numeric(first, CONFIDENCE.labeledNumeric));
      }
    }
    return findings;
  }

  const tokens = sizeOnlyTokens(text);
  if (tokens === null) return findings;
  for (const token of tokens) {
    const letter = letterSize(token);
    if (letter !== null) findings.push(letter.finding(CONFIDENCE.sizeOnlyLetter));
  }
  const [only] = tokens;
  if (tokens.length === 1 && only !== undefined && isBareNumeric(only)) {
    findings.push(numeric(only, CONFIDENCE.bareNumeric));
  }
  return findings;
}

/** Joins spelled-out sizes into single tokens: "EXTRA LARGE" and "X-LARGE" become "XLARGE". */
function expandLetterWords(text: string): string {
  return text
    .replace(/\bEXTRA[- ](SMALL|LARGE)\b/g, (_, word: string) => `X${word}`)
    .replace(/\b(X{1,3})-(SMALL|LARGE)\b/g, (_, xs: string, word: string) => `${xs}${word}`);
}

/**
 * Runs `pattern` over `text` and blanks every match the callback accepts (returns true), so
 * later rules never read the same characters twice. Offsets stay stable. `rest` is the text
 * without the match.
 */
function consume(
  text: string,
  pattern: RegExp,
  onMatch: (match: RegExpExecArray, rest: string) => boolean,
): string {
  let result = text;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    const rest = `${result.slice(0, start)} ${result.slice(end)}`;
    if (!onMatch(match, rest)) continue;
    result = result.slice(0, start) + ' '.repeat(end - start) + result.slice(end);
  }
  return result;
}

/** Records a labeled-system size; returns false when the number is out of that system's range. */
function addSystemSize(
  findings: Finding[],
  systemName: string | undefined,
  rawNumber: string | undefined,
): boolean {
  if (systemName === undefined || rawNumber === undefined) return false;
  const system = SYSTEMS[systemName];
  if (system !== 'us' && system !== 'uk' && system !== 'eu') return false;
  const value = Number(rawNumber.replace(',', '.'));
  if (!inRange(value, SYSTEM_RANGES[system])) return false;
  findings.push({ size: { system, value: String(value) }, rule: CONFIDENCE.system });
  return true;
}

/** Splits size text into tokens, dropping parenthesized ranges and stray OCR punctuation. */
function tokensOf(text: string): string[] {
  return text
    .replace(/\([^)]*\)/g, ' ')
    .split(/[\s/,|-]+/)
    .map((token) => token.replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, ''))
    .filter((token) => token !== '');
}

/**
 * The tokens of a line that holds only sizes and size companions (`S/P/CH`, `M (8-10)`,
 * `XL TALL`), or null when anything else is on it.
 */
function sizeOnlyTokens(text: string): string[] | null {
  const tokens = tokensOf(text);
  const sizeLike = tokens.every(
    (token) =>
      letterSize(token) !== null ||
      SIZE_COMPANIONS.has(token) ||
      token === 'OS' ||
      (tokens.length === 1 && isBareNumeric(token)),
  );
  return sizeLike ? tokens : null;
}

/** OCR reads O and S in short size tokens as 0 and 5 ("0S", "X5"). */
const SIZE_LETTER_CONFUSIONS: Readonly<Record<string, string>> = { '0': 'O', '5': 'S' };

function letterSize(raw: string): { finding: (rule: number) => Finding } | null {
  const repaired = raw.replace(/[05]/g, (char) => SIZE_LETTER_CONFUSIONS[char] ?? char);
  // An exact token wins ("5XL"); a repair applies only to tokens that already contain a letter.
  const value =
    lookupLetterSize(raw) ?? (/[A-Z]/.test(raw) ? lookupLetterSize(repaired) : undefined);
  if (value === undefined) return null;
  const system: SizeSystem = value === 'OS' ? 'one_size' : 'letter';
  return { finding: (rule) => ({ size: { system, value }, rule }) };
}

function lookupLetterSize(token: string): string | undefined {
  return token === 'OS' ? 'OS' : LETTER_SIZES[token];
}

function isBareNumeric(token: string): boolean {
  return NUMERIC.test(token) && !token.includes('.') && Number(token) <= BARE_NUMERIC_MAX;
}

function numeric(token: string, rule: number): Finding {
  const value = token === '00' ? '00' : String(Number(token));
  return { size: { system: 'numeric', value }, rule };
}

function inRange(value: number, [min, max]: readonly [number, number]): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}
