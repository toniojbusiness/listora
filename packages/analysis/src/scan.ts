/**
 * The thrift scan's AI read (docs/features/thrift-scan.md): one shot of an item at the store,
 * an optional tag close-up, and the seller's note, answered with a short identity, a labeled
 * price guess, and flags. It is far smaller than the item analysis (no listing copy), so it
 * is fast and cheap enough to run on every item the seller picks up.
 */
import { AiCallError, type AiClient, type AiImage, type OutputSchema } from '@listora/ai';
import { z } from 'zod';

import { AI_ESTIMATE_LABEL } from './result.ts';
import { CATEGORY_TREE, CONDITIONS, DEPARTMENTS } from './vocabulary.ts';

/** `ai_usage_event.purpose` of every scan call. */
export const SCAN_PURPOSE = 'thrift_scan';

/** The output schema's name; the fake provider's fixtures key their answer by it. */
export const SCAN_OUTPUT_NAME = 'thrift_scan';

/** At most the item shot and one tag close-up. */
export const MAX_SCAN_IMAGES = 2;

/** Provider calls one scan makes at most: an answer that breaks the schema is sent once more. */
export const MAX_SCAN_ATTEMPTS = 2;

const MAX_NOTE_LENGTH = 500;

const CATEGORY_PATHS = Object.entries(CATEGORY_TREE).flatMap(([category, subcategories]) =>
  subcategories.map((subcategory) => `${category}/${subcategory}`),
) as [string, ...string[]];

const NOT_FOUND = '';
const cents = z.int().min(0).max(100_000_000);

/** The answer as the model sends it: flat, every property present, `""` when not found. */
const scanAnswerSchema = z
  .object({
    brand: z.string().trim().max(120).describe('The maker as printed; empty when unsure'),
    item: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .describe('A short name of the item, for example "black high-rise straight jeans"'),
    line: z
      .string()
      .trim()
      .max(60)
      .describe(
        'The exact model or line, as printed or unmistakable ("501", "Align"); empty when unsure',
      ),
    styleNumber: z
      .string()
      .trim()
      .max(40)
      .describe('The style or model number printed on a tag or label; empty when none is readable'),
    era: z
      .string()
      .trim()
      .max(30)
      .describe(
        'When it was made, where that changes what it is: "current", "vintage 1990s"; empty when unsure',
      ),
    material: z
      .string()
      .trim()
      .max(40)
      .describe('The main material, as the tag or item shows it; empty when unsure'),
    category: z.enum([NOT_FOUND, ...CATEGORY_PATHS]),
    department: z.enum([NOT_FOUND, ...DEPARTMENTS]),
    sizeLabel: z.string().trim().max(32),
    condition: z.enum([NOT_FOUND, ...CONDITIONS]),
    identityConfidence: z
      .number()
      .min(0)
      .max(1)
      .describe('How sure you are of the brand and item together, 0 to 1'),
    priceEstimate: z
      .object({ lowCents: cents, midCents: cents, highCents: cents })
      .strict()
      .describe('What a buyer would pay for it on Depop, in US cents; all zero when unsure'),
    retailPriceCents: cents.describe(
      'The original retail price printed on a price tag shown in an image, in US cents; 0 when none is shown',
    ),
    style: z
      .string()
      .trim()
      .max(40)
      .describe(
        'A style or era buyers search by, such as "Y2K" or "gorpcore"; empty when none clearly applies',
      ),
    searchWords: z
      .string()
      .trim()
      .max(100)
      .describe('The words a buyer would search to find items like it'),
    flags: z
      .object({
        visibleDamage: z.boolean(),
        lotOrBundle: z.boolean(),
        counterfeitProne: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((answer, ctx) => {
    const { lowCents, midCents, highCents } = answer.priceEstimate;
    const noPrice = lowCents === 0 && midCents === 0 && highCents === 0;
    if (!noPrice && !(lowCents >= 1 && lowCents <= midCents && midCents <= highCents)) {
      ctx.addIssue({
        code: 'custom',
        path: ['priceEstimate'],
        message: 'must have 1 <= lowCents <= midCents <= highCents, or all zero',
      });
    }
  });
export type ScanAnswer = z.infer<typeof scanAnswerSchema>;

export const SCAN_OUTPUT: OutputSchema<ScanAnswer> = {
  name: SCAN_OUTPUT_NAME,
  schema: scanAnswerSchema,
};

/** Stable instructions of every scan call: no per-request values, so they cache. */
export const SCAN_SYSTEM = `You help a reseller at a thrift store decide in seconds whether an item is worth buying to resell, mainly on Depop in the US.
Answer with one JSON object that follows the schema exactly.

Evidence
- The first image is the item as the seller holds it; a second image, when there is one, is a
  close-up of its tag. The request may add the seller's spoken note and the text the phone read
  on the tag; OCR misreads characters, so check them against the images.
- Use "" for anything you cannot tell. A missing value is far better than a guess.

Identity
- brand: the maker as printed or as the item clearly shows it. item: a short name a buyer would
  recognize (color, style, item type).
- line: the exact model or line ("501", "550", "Align", "Synchilla", "Air Force 1") only when
  printed or unmistakable: one brand makes many models, so never guess one. styleNumber: a
  style or model number printed on a tag or label. era: "current", or "vintage" with its decade,
  when that changes what the item is. material: the main material ("wool", "cotton",
  "leather"). "" for any of them when unsure.
- category, as <category>/<subcategory>, from: ${CATEGORY_PATHS.join(', ')}.
- department: ${DEPARTMENTS.join(', ')}. sizeLabel: the size as on the tag, short ("M", "28").
- condition: ${CONDITIONS.join(', ')}; judge only what the images show. new_with_tags only
  when the store's or the maker's price tag is still attached.
- style: a style or era buyers search by ("Y2K", "gorpcore", "90s vintage", "coquette") only
  when the item clearly is one; otherwise "".
- identityConfidence: how sure you are of the brand and item together, 0 to 1. Use less than 0.6
  when the brand is not readable or the item could be several things.

Price
- priceEstimate: what a buyer would pay for this item on Depop (the item price, without
  shipping), as low, mid, and high in US cents, from the brand, item, era, and condition. It
  is shown as "${AI_ESTIMATE_LABEL}", so never claim it rests on sales.
  Use all zeros when you cannot tell.
- retailPriceCents: the original retail price printed on a price tag you can read in an image
  (the maker's or a store's original tag, not a thrift store's own sticker), in US cents; 0 when
  no such price is readable. Never guess it.
- searchWords: brand and item type plus at most two words that narrow it (style, era, size).

Flags
- visibleDamage: a stain, hole, tear, or heavy wear a buyer would mind. lotOrBundle: several
  items sold as one. counterfeitProne: a brand often faked whose authenticity the images cannot
  show.`;

/** One scan: who it is for, the images, and what the seller said. */
export interface ScanInput {
  readonly accountId: string;
  readonly userId: string | null;
  /** The photo-set hash of the scan's images, as the fake provider's fixtures key them. */
  readonly photoSetHash: string;
  /** The item shot, then an optional tag close-up. */
  readonly images: readonly AiImage[];
  /** What the seller said about the item, as text. */
  readonly note?: string;
  /** Text the phone read on the tag. */
  readonly tagText?: readonly string[];
  readonly signal?: AbortSignal;
}

/** A scan's read, with `null` for what the AI could not tell. */
export interface ThriftScan {
  readonly brand: string | null;
  readonly item: string;
  /** The exact model or line ("501"), its printed style number, its era, and the main material; null when unsure. */
  readonly line: string | null;
  readonly styleNumber: string | null;
  readonly era: string | null;
  readonly material: string | null;
  readonly category: string | null;
  readonly department: (typeof DEPARTMENTS)[number] | null;
  readonly sizeLabel: string | null;
  readonly condition: (typeof CONDITIONS)[number] | null;
  readonly identityConfidence: number;
  /** Labeled "AI estimate - not based on sold listings" wherever it is shown. */
  readonly aiEstimate: {
    readonly lowCents: number;
    readonly midCents: number;
    readonly highCents: number;
  } | null;
  /** The original retail price read off a price tag in the images; null when none was readable. */
  readonly retailPriceCents: number | null;
  /** A style or era buyers search by ("Y2K"), the AI's read; null when none clearly applies. */
  readonly style: string | null;
  readonly searchWords: string;
  readonly flags: ScanAnswer['flags'];
}

export interface ScanOutcome {
  readonly scan: ThriftScan;
  readonly model: string;
  /** Provider calls made, failed ones included. */
  readonly attempts: number;
  /** Metered cost of every call made, in micro-dollars. */
  readonly costMicros: number;
}

/** A scan that got no usable answer; it carries what the attempts cost. */
export class ScanFailedError extends Error {
  readonly attempts: number;
  readonly costMicros: number;

  constructor(spent: { attempts: number; costMicros: number }, options: ErrorOptions) {
    const cause = options.cause instanceof Error ? options.cause.message : String(options.cause);
    super(`the scan failed: ${cause}`, options);
    this.name = 'ScanFailedError';
    this.attempts = spent.attempts;
    this.costMicros = spent.costMicros;
  }
}

/**
 * Reads one scan with a standard-tier call through `AiClient`, so the kill switch, account
 * blocks, daily budget, and metering apply. It uses no item quota: a scan is not an AI item.
 * An answer that breaks the schema is sent once more; any other failure, or a second bad
 * answer, throws `ScanFailedError` with the cost of every attempt.
 */
export async function scanItem(client: AiClient, input: ScanInput): Promise<ScanOutcome> {
  if (input.images.length === 0 || input.images.length > MAX_SCAN_IMAGES) {
    throw new RangeError(`a scan has 1 to ${String(MAX_SCAN_IMAGES)} images`);
  }
  let attempts = 0;
  let costMicros = 0;
  for (;;) {
    attempts += 1;
    try {
      const answer = await client.generate({
        context: { accountId: input.accountId, userId: input.userId, purpose: SCAN_PURPOSE },
        tier: 'standard',
        system: SCAN_SYSTEM,
        prompt: scanPrompt(input),
        photoSetHash: input.photoSetHash,
        images: input.images,
        output: SCAN_OUTPUT,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      costMicros += answer.costMicros;
      return { scan: decodeScanAnswer(answer.output), model: answer.model, attempts, costMicros };
    } catch (error) {
      if (error instanceof AiCallError) {
        costMicros += error.costMicros;
        if (error.code === 'invalid_output' && attempts < MAX_SCAN_ATTEMPTS) continue;
      }
      throw new ScanFailedError({ attempts, costMicros }, { cause: error });
    }
  }
}

/** The per-request text: which image is which, the note, and the tag text. */
export function scanPrompt(input: ScanInput): string {
  const note = input.note?.trim().slice(0, MAX_NOTE_LENGTH);
  return JSON.stringify({
    images: input.images.map((_, index) => (index === 0 ? 'item' : 'tag_close_up')),
    ...(note === undefined || note === '' ? {} : { note }),
    ...(input.tagText === undefined || input.tagText.length === 0
      ? {}
      : { tagText: input.tagText }),
  });
}

/** The answer with `null` for what was not found. */
export function decodeScanAnswer(answer: ScanAnswer): ThriftScan {
  const orNull = <V extends string>(value: V): Exclude<V, typeof NOT_FOUND> | null =>
    value === NOT_FOUND ? null : (value as Exclude<V, typeof NOT_FOUND>);
  const price = answer.priceEstimate;
  return {
    brand: orNull(answer.brand),
    item: answer.item,
    line: answer.line === '' ? null : answer.line,
    styleNumber: answer.styleNumber === '' ? null : answer.styleNumber,
    era: answer.era === '' ? null : answer.era,
    material: answer.material === '' ? null : answer.material,
    category: orNull(answer.category),
    department: orNull(answer.department),
    sizeLabel: orNull(answer.sizeLabel),
    condition: orNull(answer.condition),
    identityConfidence: answer.identityConfidence,
    aiEstimate:
      price.lowCents === 0 && price.midCents === 0 && price.highCents === 0 ? null : price,
    retailPriceCents: answer.retailPriceCents === 0 ? null : answer.retailPriceCents,
    style: answer.style === '' ? null : answer.style,
    searchWords: answer.searchWords,
    flags: answer.flags,
  };
}
