/**
 * The schema of the one structured answer an analysis call returns. It is the single source
 * of truth: the provider sends the JSON schema derived from it, and every answer is
 * validated against it, including the rules JSON Schema cannot state (a subcategory of the
 * chosen category, a UPC check digit, Depop's description rules, price order). An answer that
 * breaks any rule is rejected as `invalid_output` and the call is retried once.
 */
import { isValidGtin } from '@listora/tag-parse';
import { z } from 'zod';

import type { OutputSchema } from '@listora/ai';

import {
  depopDescription,
  EMAIL_ADDRESS,
  HASHTAG,
  MARKETPLACE_COPY_LIMITS as LIMITS,
} from './marketplace-copy.ts';
import {
  CATEGORIES,
  COLORS,
  CONDITIONS,
  DEPARTMENTS,
  isSubcategoryOf,
  MATERIALS,
  PATTERNS,
  SIZE_SYSTEMS,
  SUBCATEGORIES,
} from './vocabulary.ts';

/** The output schema's name; fake provider fixtures answer it under this key. */
export const ITEM_ANALYSIS_OUTPUT_NAME = 'item_analysis';

const confidence = z
  .number()
  .min(0)
  .max(1)
  .describe('0 to 1: how sure you are. Below 0.6 means a person should check it.');

/**
 * Where the evidence for a value is: `photo` (seen in a photo), `tag_text` (printed on a tag
 * or label, as in the OCR lines or a tag crop), or `barcode` (a scanned barcode).
 */
export const EVIDENCE_SOURCES = ['photo', 'tag_text', 'barcode'] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

/**
 * The answer is flat, with no unions or optional properties: each detail is a plain value,
 * empty when not found (`""`, `[]`, or an all-zero price), with its confidence in a parallel
 * object, and `decodeAnalysisAnswer` turns it into the `null`-for-absent form the rest of
 * the analysis works with. Every property is always present, so an answer is easy to write
 * and to check.
 *
 * The schema travels in the system prompt (`enforcement: 'prompt'`), not as a strict
 * structured-output grammar: Anthropic compiles a strict schema into a grammar and refused
 * this one as too large ("The compiled grammar is too large", HTTP 400) even in this flat
 * form (live probes, 2026-10-24). Validation against this schema, and the one retry of an
 * answer that fails it, hold the model to it instead.
 */
const NOT_FOUND = '';

/** Text that is empty when not found. */
const optionalText = (maxLength: number) => z.string().trim().max(maxLength);
const text = (maxLength: number) => z.string().trim().min(1).max(maxLength);
/** One of `values`, or empty when not found. */
const choice = <const V extends readonly [string, ...string[]]>(values: V) =>
  z.enum([NOT_FOUND, ...values]);

/**
 * The details, flat: one plain value per detail, empty when not found. Lengths follow
 * `ItemDetails` in the API contract, so an applied value always fits.
 */
const attributesSchema = z
  .object({
    brand: optionalText(120),
    productName: optionalText(200).describe(
      'The product or style name, for example "501 Original"',
    ),
    styleNumber: optionalText(64),
    rnNumber: z
      .string()
      .regex(/^(\d{5,6})?$/)
      .describe('RN digits only'),
    upc: z
      .string()
      .regex(/^(\d{12}|\d{13})?$/)
      .describe('UPC-A (12) or EAN-13 (13) digits with a valid check digit'),
    department: choice(DEPARTMENTS),
    category: choice(CATEGORIES),
    subcategory: choice(SUBCATEGORIES).describe('One of the chosen category'),
    sizeLabel: optionalText(32).describe('The size as printed, for example "M" or "32x30"'),
    sizeSystem: choice(SIZE_SYSTEMS),
    colors: z.array(z.enum(COLORS)).max(10),
    pattern: choice(PATTERNS),
    materials: z.array(z.enum(MATERIALS)).max(10),
    condition: choice(CONDITIONS),
    conditionNotes: optionalText(2_000),
    flaws: z.array(text(200)).max(20),
    keywords: z.array(text(64)).max(30),
  })
  .strict()
  .describe('Use an empty value (an empty string or list) for anything you cannot tell');

type AttributeKey = keyof z.infer<typeof attributesSchema>;
const ATTRIBUTE_KEYS = Object.keys(attributesSchema.shape) as AttributeKey[];

const confidenceSchema = z
  .object({
    ...(Object.fromEntries(ATTRIBUTE_KEYS.map((key) => [key, confidence])) as Record<
      AttributeKey,
      typeof confidence
    >),
    title: confidence,
    description: confidence,
  })
  .strict()
  .describe('How sure you are of each value, 0 to 1; 0 for a value you left empty');

/**
 * Details read off a tag or label (their provenance is checked against the phone's reads) or,
 * for the UPC, off a barcode; every other detail is judged from the photos.
 */
const READ_FROM_TAG: ReadonlySet<AttributeKey> = new Set([
  'brand',
  'productName',
  'styleNumber',
  'rnNumber',
  'sizeLabel',
  'sizeSystem',
  'materials',
]);

const LIST_KEYS: ReadonlySet<AttributeKey> = new Set(['colors', 'materials', 'flaws', 'keywords']);

function evidenceOf(key: AttributeKey): EvidenceSource {
  if (key === 'upc') return 'barcode';
  return READ_FROM_TAG.has(key) ? 'tag_text' : 'photo';
}

const copy = (title: number, description: number) =>
  z.object({ title: text(title), description: text(description) }).strict();

const variantsSchema = z
  .object({
    ebay: copy(LIMITS.ebay.title, LIMITS.ebay.description).describe(
      'Keyword title: brand, item type, key attributes, size; no filler words',
    ),
    depop: z
      .object({
        title: text(LIMITS.depop.title),
        description: text(LIMITS.depop.description),
        hashtags: z.array(z.string().regex(HASHTAG)).max(LIMITS.depop.hashtags),
      })
      .strict()
      .describe('Style-forward, casual copy; hashtags without the #'),
    poshmark: copy(LIMITS.poshmark.title, LIMITS.poshmark.description).describe(
      'Fashion copy: brand, style, fit, and how to wear it',
    ),
    mercari: copy(LIMITS.mercari.title, LIMITS.mercari.description).describe('Plain, factual copy'),
  })
  .strict();

const cents = z.int().min(0).max(100_000_000);

/** What the model returns: the wire form, validated by the API's grammar and by Zod. */
export const itemAnalysisSchema = z
  .object({
    attributes: attributesSchema,
    confidence: confidenceSchema,
    title: text(120),
    description: text(4_000),
    variants: variantsSchema,
    priceEstimate: z
      .object({ lowCents: cents, midCents: cents, highCents: cents, confidence })
      .strict()
      .describe('A resale price guess in US cents; all zero when you cannot tell'),
    looksVintage: z.boolean(),
    looksDesigner: z.boolean(),
    needsEscalation: z.boolean().describe('True when a stronger model should identify the item'),
    escalationReason: optionalText(500).describe('Why to escalate; empty when not escalating'),
  })
  .strict()
  .superRefine((answer, ctx) => {
    const { category, subcategory, upc } = answer.attributes;
    if (category !== NOT_FOUND && subcategory !== NOT_FOUND) {
      if (!isSubcategoryOf(category, subcategory)) {
        ctx.addIssue({
          code: 'custom',
          path: ['attributes', 'subcategory'],
          message: `${subcategory} is not a subcategory of ${category}`,
        });
      }
    } else if (subcategory !== NOT_FOUND) {
      ctx.addIssue({
        code: 'custom',
        path: ['attributes', 'subcategory'],
        message: 'a subcategory needs its category',
      });
    }
    if (upc !== NOT_FOUND && !isValidGtin(upc)) {
      ctx.addIssue({
        code: 'custom',
        path: ['attributes', 'upc'],
        message: 'has no valid check digit',
      });
    }
    const depop = answer.variants.depop;
    if (depopDescription(depop.description, depop.hashtags).length > LIMITS.depop.description) {
      ctx.addIssue({
        code: 'custom',
        path: ['variants', 'depop', 'description'],
        message: `with its hashtags must fit in ${String(LIMITS.depop.description)} characters`,
      });
    }
    if (EMAIL_ADDRESS.test(depop.description)) {
      ctx.addIssue({
        code: 'custom',
        path: ['variants', 'depop', 'description'],
        message: 'must not contain an email address',
      });
    }
    const { lowCents, midCents, highCents } = answer.priceEstimate;
    const noPrice = lowCents === 0 && midCents === 0 && highCents === 0;
    if (!noPrice && !(lowCents >= 1 && lowCents <= midCents && midCents <= highCents)) {
      ctx.addIssue({
        code: 'custom',
        path: ['priceEstimate'],
        message: 'must have 1 <= lowCents <= midCents <= highCents, or all zero',
      });
    }
    if (answer.needsEscalation && answer.escalationReason === NOT_FOUND) {
      ctx.addIssue({
        code: 'custom',
        path: ['escalationReason'],
        message: 'is required when needsEscalation is true',
      });
    }
  });

/** The answer as the model sends it. */
export type ItemAnalysisAnswer = z.infer<typeof itemAnalysisSchema>;
type WireAttributes = ItemAnalysisAnswer['attributes'];

/** A found detail with its confidence and the kind of evidence it rests on, or null. */
type Decoded<V> = V extends readonly (infer I)[]
  ? { values: I[]; confidence: number; source: EvidenceSource } | null
  : { value: Exclude<V, typeof NOT_FOUND>; confidence: number; source: EvidenceSource } | null;

export type AnalyzedAttributes = { [K in AttributeKey]: Decoded<WireAttributes[K]> };

/** The answer decoded: what was not found is null, and each value carries its confidence. */
export interface ItemAnalysisOutput {
  attributes: AnalyzedAttributes;
  title: { value: string; confidence: number };
  description: { value: string; confidence: number };
  variants: ItemAnalysisAnswer['variants'];
  priceEstimate: ItemAnalysisAnswer['priceEstimate'] | null;
  looksVintage: boolean;
  looksDesigner: boolean;
  needsEscalation: boolean;
  escalationReason: string | null;
}

export function decodeAnalysisAnswer(answer: ItemAnalysisAnswer): ItemAnalysisOutput {
  const attributes = Object.fromEntries(
    ATTRIBUTE_KEYS.map((key) => {
      const value: string | readonly string[] = answer.attributes[key];
      const base = { confidence: answer.confidence[key], source: evidenceOf(key) };
      if (Array.isArray(value)) return [key, value.length > 0 ? { values: value, ...base } : null];
      return [key, value === NOT_FOUND ? null : { value, ...base }];
    }),
  ) as AnalyzedAttributes;
  const price = answer.priceEstimate;
  return {
    attributes,
    title: { value: answer.title, confidence: answer.confidence.title },
    description: { value: answer.description, confidence: answer.confidence.description },
    variants: answer.variants,
    priceEstimate:
      price.lowCents === 0 && price.midCents === 0 && price.highCents === 0 ? null : price,
    looksVintage: answer.looksVintage,
    looksDesigner: answer.looksDesigner,
    needsEscalation: answer.needsEscalation,
    escalationReason: answer.escalationReason === NOT_FOUND ? null : answer.escalationReason,
  };
}

/** The wire form of a decoded answer, for fixtures the fake provider answers with. */
export function encodeAnalysisAnswer(output: ItemAnalysisOutput): ItemAnalysisAnswer {
  const confidences: Record<string, number> = {
    title: output.title.confidence,
    description: output.description.confidence,
  };
  const attributes: Record<string, unknown> = {};
  for (const key of ATTRIBUTE_KEYS) {
    const entry: { value?: unknown; values?: unknown; confidence: number } | null =
      output.attributes[key];
    attributes[key] =
      entry === null ? (LIST_KEYS.has(key) ? [] : NOT_FOUND) : (entry.values ?? entry.value);
    confidences[key] = entry?.confidence ?? 0;
  }
  return {
    attributes: attributes as WireAttributes,
    confidence: confidences as ItemAnalysisAnswer['confidence'],
    title: output.title.value,
    description: output.description.value,
    variants: output.variants,
    priceEstimate: output.priceEstimate ?? {
      lowCents: 0,
      midCents: 0,
      highCents: 0,
      confidence: 0,
    },
    looksVintage: output.looksVintage,
    looksDesigner: output.looksDesigner,
    needsEscalation: output.needsEscalation,
    escalationReason: output.escalationReason ?? NOT_FOUND,
  };
}

export const ITEM_ANALYSIS_OUTPUT: OutputSchema<ItemAnalysisAnswer> = {
  name: ITEM_ANALYSIS_OUTPUT_NAME,
  schema: itemAnalysisSchema,
  enforcement: 'prompt',
};
