import { readFile } from 'node:fs/promises';

import { photoSetHashOfImages, type AiClient, type AiImage, type AiTier } from '@listora/ai';
import {
  AnalysisFailedError,
  analyzeItem,
  MARKETPLACE_COPY_LIMITS,
  type AnalysisInput,
  type ItemAnalysisOutput,
} from '@listora/analysis';
import type { AnalysisResult } from '@listora/api-contract';
import { tagCrop } from '@listora/photos';
import { toGtin, type SizeSystem, type TagField, type TagValues } from '@listora/tag-parse';

import {
  EvalProviderError,
  type EvalProvider,
  type EvalProviderInput,
  type EvalProviderResult,
} from './provider.ts';

/** The tag facts an analysis result reports, and so the fields the analysis is scored on. */
export const ANALYSIS_FIELDS = [
  'rn',
  'gtin',
  'size',
  'style',
] as const satisfies readonly TagField[];

const SIZE_SYSTEMS: readonly SizeSystem[] = [
  'letter',
  'numeric',
  'waist_inseam',
  'us',
  'uk',
  'eu',
  'one_size',
];

export interface AnalysisEvalProviderOptions {
  readonly id: string;
  readonly description: string;
  readonly client: AiClient;
  readonly tier: AiTier;
}

/**
 * Runs the production item analysis (`analyzeItem` from @listora/analysis) on each corpus
 * tag: the same prompt, strict schema, retry of a schema-violating answer, provenance rules,
 * and metering as an item in the app, with the tag as the item's one `tag` photo. The result
 * is scored on the tag facts it reports, and every call's metered cost is counted, a failed
 * analysis's included.
 */
export class AnalysisEvalProvider implements EvalProvider {
  readonly id: string;
  readonly description: string;
  readonly task = 'analysis';
  readonly fields = ANALYSIS_FIELDS;
  /** An item has one value per detail, even when its tag prints several sizes. */
  readonly scoring = 'one_of';
  readonly #client: AiClient;
  readonly #tier: AiTier;

  constructor(options: AnalysisEvalProviderOptions) {
    this.id = options.id;
    this.description = options.description;
    this.#client = options.client;
    this.#tier = options.tier;
  }

  async extract(input: EvalProviderInput): Promise<EvalProviderResult> {
    try {
      const outcome = await analyzeItem(this.#client, await analysisInput(input), {
        tier: this.#tier,
      });
      return { values: tagValuesOf(outcome.result), usage: { costMicros: outcome.costMicros } };
    } catch (error) {
      if (error instanceof AnalysisFailedError) {
        // An eval is read by operators: keep the provider's own reason next to the user's one.
        const detail = error.cause instanceof Error ? ` (${error.cause.message})` : '';
        throw new EvalProviderError(`${error.code}: ${error.message}${detail}`, {
          usage: { costMicros: error.costMicros },
          cause: error,
        });
      }
      throw error;
    }
  }
}

/** A corpus case as an item with one tag photo, read on the phone as the corpus says. */
export async function analysisInput(input: EvalProviderInput): Promise<AnalysisInput> {
  const data = new Uint8Array(await readFile(input.image.path));
  const crop = await tagCrop(data);
  const tagCropImage: AiImage | undefined =
    crop === undefined
      ? undefined
      : { mediaType: 'image/jpeg', data: crop.bytes, width: crop.width, height: crop.height };
  return {
    accountId: 'eval',
    userId: null,
    itemId: null,
    // The corpus image is the upload itself, so this is the photo set's real hash.
    photoSetHash: photoSetHashOfImages([{ data }]),
    photos: [
      {
        photoId: input.caseId,
        role: 'tag',
        image: {
          mediaType: input.image.mediaType,
          data,
          width: input.image.width,
          height: input.image.height,
        },
        ...(tagCropImage === undefined ? {} : { tagCrop: tagCropImage }),
        ocrLines: input.ocr.lines.map((line) => ({
          text: line.text,
          confidence: line.confidence ?? 1,
        })),
        barcodes: (input.ocr.barcodes ?? []).map((barcode) => ({
          symbology: barcode.symbology ?? 'unknown',
          payload: barcode.payload,
        })),
      },
    ],
  };
}

/** The tag facts an analysis result reports, in the `@listora/tag-parse` shapes. */
export function tagValuesOf(result: AnalysisResult): Partial<TagValues> {
  const { rnNumber, upc, sizeLabel, sizeSystem, styleNumber } = result.details;
  const gtin = upc === undefined ? null : toGtin(upc.value);
  const system = SIZE_SYSTEMS.find((known) => known === sizeSystem?.value);
  return {
    rn: rnNumber === undefined ? [] : [rnNumber.value],
    gtin: gtin === null ? [] : [gtin],
    size:
      sizeLabel === undefined || system === undefined ? [] : [{ system, value: sizeLabel.value }],
    style: styleNumber === undefined ? [] : [styleNumber.value],
  };
}

/**
 * The fake provider's `item_analysis` answer for a corpus tag, from its ground truth: what a
 * model that reads the tag perfectly would say. An analysis reports one value per detail, so
 * a tag that prints two RN numbers is answered with the first.
 */
export function fakeAnalysisAnswer(caseId: string, truth: TagValues): ItemAnalysisOutput {
  const first = <T>(values: readonly T[]): T | undefined => values[0];
  const rn = first(truth.rn);
  const gtin = first(truth.gtin);
  const size = first(truth.size);
  const style = first(truth.style);
  const materials = [...new Set(truth.fiber.map((fiber) => fiber.material))].slice(0, 10);
  const label = `Synthetic tag ${caseId}`;
  return {
    attributes: {
      brand: null,
      productName: null,
      styleNumber:
        style === undefined ? null : { value: style, confidence: 0.9, source: 'tag_text' },
      rnNumber: rn === undefined ? null : { value: rn, confidence: 0.9, source: 'tag_text' },
      upc: gtin === undefined ? null : { value: gtin.digits, confidence: 0.9, source: 'tag_text' },
      department: null,
      category: null,
      subcategory: null,
      sizeLabel:
        size === undefined ? null : { value: size.value, confidence: 0.9, source: 'tag_text' },
      sizeSystem:
        size === undefined ? null : { value: size.system, confidence: 0.9, source: 'tag_text' },
      colors: null,
      pattern: null,
      materials:
        materials.length === 0 ? null : { values: materials, confidence: 0.9, source: 'tag_text' },
      condition: null,
      conditionNotes: null,
      flaws: null,
      keywords: null,
    },
    title: { value: label, confidence: 0.5 },
    description: { value: `${label}, read from its care label.`, confidence: 0.5 },
    variants: {
      ebay: { title: label.slice(0, MARKETPLACE_COPY_LIMITS.ebay.title), description: label },
      depop: { title: label, description: label, hashtags: [] },
      poshmark: { title: label, description: label },
      mercari: { title: label, description: label },
    },
    priceEstimate: null,
    looksVintage: false,
    looksDesigner: false,
    needsEscalation: false,
    escalationReason: null,
  };
}
