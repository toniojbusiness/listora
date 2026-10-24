import { parseFibers } from './fiber.ts';
import { parseBarcodeGtins, parseOcrGtins } from './gtin.ts';
import { valueKey } from './keys.ts';
import { prepareLines } from './normalize.ts';
import { parseOrigins } from './origin.ts';
import { parseCaNumbers, parseRnNumbers } from './registration.ts';
import { parseSizes } from './size.ts';
import { parseStyleNumbers } from './style.ts';
import { TAG_FIELDS } from './types.ts';
import type {
  Parsed,
  TagFacts,
  TagField,
  TagTextInput,
  TagValueTypes,
  TagValues,
} from './types.ts';

/**
 * Parses OCR lines and barcode payloads from tag photos into tag facts. Pure and deterministic:
 * the same input always yields the same output, and nothing is looked up remotely.
 *
 * Each field lists distinct values, highest confidence first. A value found more than once
 * (a barcode and its printed digits, or a multilingual repeat) keeps its most confident source.
 */
export function parseTagText(input: TagTextInput): TagFacts {
  const lines = prepareLines(input.lines);
  return {
    rn: rank('rn', parseRnNumbers(lines)),
    ca: rank('ca', parseCaNumbers(lines)),
    gtin: rank('gtin', [...parseBarcodeGtins(input.barcodes ?? []), ...parseOcrGtins(lines)]),
    size: rank('size', parseSizes(lines)),
    fiber: rank('fiber', parseFibers(lines)),
    origin: rank('origin', parseOrigins(lines)),
    style: rank('style', parseStyleNumbers(lines)),
  };
}

/** Drops confidence and source, keeping each field's values in rank order. */
export function valuesOf(facts: TagFacts): TagValues {
  const pick = <F extends TagField>(field: F): readonly TagValueTypes[F][] =>
    facts[field].map((parsed) => parsed.value);
  return {
    rn: pick('rn'),
    ca: pick('ca'),
    gtin: pick('gtin'),
    size: pick('size'),
    fiber: pick('fiber'),
    origin: pick('origin'),
    style: pick('style'),
  };
}

export function emptyTagValues(): TagValues {
  return Object.fromEntries(TAG_FIELDS.map((field) => [field, []])) as unknown as TagValues;
}

function rank<F extends TagField>(
  field: F,
  found: readonly Parsed<TagValueTypes[F]>[],
): Parsed<TagValueTypes[F]>[] {
  const best = new Map<string, Parsed<TagValueTypes[F]>>();
  for (const parsed of found) {
    const key = valueKey(field, parsed.value);
    const existing = best.get(key);
    if (existing === undefined || parsed.confidence > existing.confidence) best.set(key, parsed);
  }
  // Stable sort: equal confidence keeps reading order.
  return [...best.values()].sort((a, b) => b.confidence - a.confidence);
}
