import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { AiCallError, type AiClient, type AiTier, type OutputSchema } from '@listora/ai';
import {
  COUNTRY_NAMES,
  FIBER_PART_NAMES,
  MATERIAL_NAMES,
  valuesOf,
  type CountryCode,
  type FiberPart,
  type Material,
  type TagValues,
} from '@listora/tag-parse';

import {
  EvalProviderError,
  type EvalProvider,
  type EvalProviderInput,
  type EvalProviderResult,
} from './provider.ts';

function keysOf<K extends string>(record: Readonly<Record<K, unknown>>): [K, ...K[]] {
  return Object.keys(record) as [K, ...K[]];
}

/** The tag facts in the `@listora/tag-parse` value shapes, as the model must return them. */
export const tagValuesSchema = z
  .object({
    rn: z.array(z.string()),
    ca: z.array(z.string()),
    gtin: z.array(z.object({ format: z.enum(['upc_a', 'ean_13']), digits: z.string() })),
    size: z.array(
      z.object({
        system: z.enum(['letter', 'numeric', 'waist_inseam', 'us', 'uk', 'eu', 'one_size']),
        value: z.string(),
      }),
    ),
    fiber: z.array(
      z.object({
        part: z.enum(keysOf<FiberPart>(FIBER_PART_NAMES)).nullable(),
        material: z.enum(keysOf<Material>(MATERIAL_NAMES)),
        percent: z.number(),
      }),
    ),
    origin: z.array(z.enum(keysOf<CountryCode>(COUNTRY_NAMES))),
    style: z.array(z.string()),
  })
  .strict();

export const TAG_VALUES_OUTPUT: OutputSchema<TagValues> = {
  name: 'tag_values',
  schema: tagValuesSchema,
};

/** Stable instructions; providers cache them, so nothing per-item belongs here. */
export const TAG_EXTRACTION_SYSTEM = `You read garment tags and care labels for a reseller.
Report only facts printed on the tag in the photo. The on-device OCR lines, barcode reads, and
deterministic parser results that come with the photo are hints: they can contain OCR errors
or miss text, so check them against the image. Every field is a list; use an empty list when
the tag does not show that fact.

- rn: the RN (FTC Registered Identification Number) digits only, for example "141526".
- ca: the CA (Canada CA Identification Number) digits only. A US state "CA" before a ZIP code
  is part of an address, not a CA number.
- gtin: UPC-A barcodes as format "upc_a" with 12 digits (an EAN-13 with a leading 0 is the UPC-A
  it encodes), other EAN-13 barcodes as "ean_13" with 13 digits. Only codes with a valid check
  digit.
- size: system "letter" (XS to XXXL, value like "M" or "XL"), "numeric" (a bare number),
  "waist_inseam" (value like "32x30"), "us", "uk", or "eu" (explicitly labeled), or
  "one_size" with value "OS".
- fiber: one entry per material and garment part, with the percent as a number. part is null
  when the tag names no part.
- origin: the ISO 3166-1 alpha-2 code from a "Made in" line. "Designed in" is not an origin.
- style: style or model numbers, as printed.`;

export interface AiEvalProviderOptions {
  readonly id: string;
  readonly description: string;
  readonly client: AiClient;
  readonly tier: AiTier;
}

/**
 * Runs the harness's tag extraction through `AiClient`, so an eval exercises the production
 * path: the budget guards, the provider, and metering. Every call's metered cost is reported,
 * a failed call's included.
 */
export class AiEvalProvider implements EvalProvider {
  readonly id: string;
  readonly description: string;
  readonly #client: AiClient;
  readonly #tier: AiTier;

  constructor(options: AiEvalProviderOptions) {
    this.id = options.id;
    this.description = options.description;
    this.#client = options.client;
    this.#tier = options.tier;
  }

  async extract(input: EvalProviderInput): Promise<EvalProviderResult> {
    const data = new Uint8Array(await readFile(input.image.path));
    try {
      const result = await this.#client.generate({
        context: { accountId: 'eval', purpose: 'tag_eval' },
        tier: this.#tier,
        system: TAG_EXTRACTION_SYSTEM,
        prompt: tagPrompt(input),
        images: [
          {
            mediaType: input.image.mediaType,
            data,
            width: input.image.width,
            height: input.image.height,
          },
        ],
        output: TAG_VALUES_OUTPUT,
      });
      return {
        values: result.output,
        usage: {
          costMicros: result.costMicros,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        },
      };
    } catch (error) {
      if (error instanceof AiCallError) {
        throw new EvalProviderError(error.message, {
          usage: {
            costMicros: error.costMicros,
            inputTokens: error.usage.inputTokens,
            outputTokens: error.usage.outputTokens,
          },
          cause: error,
        });
      }
      throw error;
    }
  }
}

/** The per-item text: the on-device reads and the parser facts, as JSON. */
export function tagPrompt(input: EvalProviderInput): string {
  return JSON.stringify({
    ocrLines: input.ocr.lines.map((line) => line.text),
    barcodes: (input.ocr.barcodes ?? []).map((barcode) => barcode.payload),
    parserFacts: valuesOf(input.parsed),
  });
}
