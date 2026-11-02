/**
 * The thrift scan's brand pulse (docs/features/thrift-scan.md, "Brand pulse"): what the wider
 * web says of a brand, the way a seller asks a chatbot that searches "is this brand worth
 * picking up?": fashion and trend coverage, resale market reports, collector and community
 * discussion, and the brand's own news (a discontinued line, a revival). The answer is a verdict
 * (in demand, steady, or slow) with a one-line reason, the lines or eras that ask more, and the
 * pages it came from; only pages the search really returned count. It is web info, never sales,
 * and it is per brand, so it is kept by the brand alone.
 */
import { AiCallError, type AiClient, type OutputSchema, type WebSource } from '@listora/ai';
import { z } from 'zod';

import {
  clipped,
  dedupeSites,
  returnedPage,
  SOLD_WORDS,
  type ResearchSource,
} from './web-pages.ts';

/** `ai_usage_event.purpose` of every brand pulse call. */
export const BRAND_PULSE_PURPOSE = 'thrift_scan_brand_pulse';

/** The output schema's name; the fake provider's fixtures key their answer by it. */
export const BRAND_PULSE_OUTPUT_NAME = 'thrift_scan_brand_pulse';

/** Searches one pulse may make (the prompt says once); each costs $0.01 (`webSearchMicros`). */
export const MAX_PULSE_SEARCHES = 1;

/** Provider calls one pulse makes at most: an answer that breaks the schema is sent once more. */
export const MAX_PULSE_ATTEMPTS = 2;

/** The verdicts a pulse can give; `unknown` when the pages say too little. */
export const BRAND_PULSE_VERDICTS = ['in_demand', 'steady', 'slow', 'unknown'] as const;
export type BrandPulseVerdict = (typeof BRAND_PULSE_VERDICTS)[number];

/**
 * What the card shows at most. As with the web research, the answer's schema allows more
 * (`ANSWER_SLACK`) and `verifiedPulse` cuts it, so an answer a few characters long never costs a
 * second search.
 */
export const MAX_PULSE_REASON_LENGTH = 110;
export const MAX_PULSE_PREMIUM_LENGTH = 60;
/**
 * The lengths the prompt asks for, under the card's: the model's sentences run a little long,
 * and at 100 asked most reasons came back over it and were cut (backtest, 2026-11-02).
 */
const ASKED_REASON_LENGTH = 80;
const ASKED_PREMIUM_LENGTH = 50;
const MAX_SOURCES = 3;
const ANSWER_SLACK = 4;

const pulseAnswerSchema = z
  .object({
    verdict: z
      .enum(BRAND_PULSE_VERDICTS)
      .describe('How much secondhand buyers want the brand now, by what the pages say'),
    reason: z
      .string()
      .trim()
      .max(MAX_PULSE_REASON_LENGTH * ANSWER_SLACK)
      .describe(
        `Why, in one plain sentence under ${String(ASKED_REASON_LENGTH)} characters; "" when unknown`,
      ),
    premium: z
      .string()
      .trim()
      .max(MAX_PULSE_PREMIUM_LENGTH * ANSWER_SLACK)
      .describe(
        `The lines, eras, or pieces the pages say ask more, under ${String(ASKED_PREMIUM_LENGTH)} characters; "" (not "None") when they name none`,
      ),
    sourceUrls: z
      .array(z.string().trim().max(500))
      .max(MAX_SOURCES * ANSWER_SLACK)
      .describe(`The exact URLs of the pages it rests on, at most ${String(MAX_SOURCES)}`),
  })
  .strict();
export type BrandPulseAnswer = z.infer<typeof pulseAnswerSchema>;

/** The schema travels in the prompt: the answer comes after the search, as text. */
export const BRAND_PULSE_OUTPUT: OutputSchema<BrandPulseAnswer> = {
  name: BRAND_PULSE_OUTPUT_NAME,
  schema: pulseAnswerSchema,
  enforcement: 'prompt',
};

/** Stable instructions of every pulse call: no per-request values, so they cache. */
export const BRAND_PULSE_SYSTEM = `You help a reseller at a thrift store decide whether a brand is worth picking up to resell. The request names a brand. Search the web once, across reputable sources beyond the resale marketplaces' listings: fashion and trend coverage, resale market reports, collector and community discussion (forums, Reddit), and news of the brand itself (a discontinued line, a revival, a closure, a collaboration). Then say how much secondhand buyers want the brand right now:
- in_demand: the pages say it is popular, trending, collected, or sought after secondhand.
- steady: a known brand that resells, with no sign of a rise or a fall.
- slow: the pages say it is everywhere secondhand, out of fashion, or hard to resell.
- unknown: the pages say too little about this brand.

Rules:
- Use only what the search results say. Never guess. A URL must be one of the pages your search returned, copied exactly.
- reason: one short plain sentence, under ${String(ASKED_REASON_LENGTH)} characters, for example "Y2K coverage has its 2000s velour tracksuits trending again."
- premium: what asks more, under ${String(ASKED_PREMIUM_LENGTH)} characters, for example "Vintage 90s pieces and the Big E line"; "" when the pages name nothing.
- No prices or dollar amounts in reason or premium: the card shows prices on their own.
- This is web info, not sales: never write "sold" or "comps".

Answer last, after your search, with the JSON object only.`;

export interface BrandPulseInput {
  readonly accountId: string;
  readonly userId: string | null;
  /** The brand key's SHA-256, as the fake provider's fixtures key their answers. */
  readonly keyHash: string;
  readonly brand: string;
  readonly signal?: AbortSignal;
}

/** What the wider web says of a brand, with the pages it came from. */
export interface BrandPulse {
  readonly verdict: BrandPulseVerdict;
  /** One line of why; empty with `unknown`. */
  readonly reason: string;
  /** The lines or eras that ask more, when the pages name any. */
  readonly premium: string | null;
  readonly sources: readonly ResearchSource[];
}

export interface BrandPulseOutcome {
  readonly pulse: BrandPulse;
  readonly model: string;
  readonly attempts: number;
  readonly costMicros: number;
  readonly searches: number;
}

/** A pulse that got no usable answer; it carries what the attempts cost. */
export class BrandPulseFailedError extends Error {
  readonly attempts: number;
  readonly costMicros: number;

  constructor(spent: { attempts: number; costMicros: number }, options: ErrorOptions) {
    const cause = options.cause instanceof Error ? options.cause.message : String(options.cause);
    super(`the brand pulse failed: ${cause}`, options);
    this.name = 'BrandPulseFailedError';
    this.attempts = spent.attempts;
    this.costMicros = spent.costMicros;
  }
}

/**
 * Asks the wider web about one brand with a standard-tier call and one search through
 * `AiClient`, so the kill switch, account blocks, daily budget, and metering apply. An answer
 * that breaks the schema is sent once more; any other failure throws `BrandPulseFailedError`
 * with the cost of every attempt.
 */
export async function researchBrandPulse(
  client: AiClient,
  input: BrandPulseInput,
): Promise<BrandPulseOutcome> {
  let attempts = 0;
  let costMicros = 0;
  let searches = 0;
  for (;;) {
    attempts += 1;
    try {
      const answer = await client.generate({
        context: { accountId: input.accountId, userId: input.userId, purpose: BRAND_PULSE_PURPOSE },
        tier: 'standard',
        system: BRAND_PULSE_SYSTEM,
        prompt: JSON.stringify({ brand: input.brand }),
        photoSetHash: input.keyHash,
        images: [],
        output: BRAND_PULSE_OUTPUT,
        webSearch: { maxUses: MAX_PULSE_SEARCHES },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      costMicros += answer.costMicros;
      searches += answer.usage.webSearches;
      return {
        pulse: verifiedPulse(answer.output, answer.webSources),
        model: answer.model,
        attempts,
        costMicros,
        searches,
      };
    } catch (error) {
      if (error instanceof AiCallError) {
        costMicros += error.costMicros;
        if (error.code === 'invalid_output' && attempts < MAX_PULSE_ATTEMPTS) continue;
      }
      throw new BrandPulseFailedError({ attempts, costMicros }, { cause: error });
    }
  }
}

/** A dollar amount: prices stay with the card's prices, never in the pulse's premium. */
const PRICE = /\$\s?\d/;

/** A premium that names nothing, as the model sometimes writes it instead of "". */
const NOTHING = /^\s*(none|n\/a|nothing|no premium|-)?\s*\.?\s*$/i;

const UNKNOWN: BrandPulse = { verdict: 'unknown', reason: '', premium: null, sources: [] };

/**
 * The answer, holding only to the pages the search returned: a verdict with no returned page,
 * or with no reason, or whose reason calls anything sold, is `unknown`; a premium that calls
 * anything sold, or names a price, is dropped alone. Texts are cut to the card's lengths at a word.
 */
export function verifiedPulse(answer: BrandPulseAnswer, found: readonly WebSource[]): BrandPulse {
  const page = returnedPage(found);
  const sources = dedupeSites(
    answer.sourceUrls.flatMap((address) => {
      const source = page(address);
      return source === undefined ? [] : [source];
    }),
  ).slice(0, MAX_SOURCES);
  const reason = answer.reason.trim();
  if (
    answer.verdict === 'unknown' ||
    sources.length === 0 ||
    reason === '' ||
    SOLD_WORDS.test(reason)
  ) {
    return UNKNOWN;
  }
  const premium = NOTHING.test(answer.premium) ? '' : answer.premium.trim();
  return {
    verdict: answer.verdict,
    reason: clipped(reason, MAX_PULSE_REASON_LENGTH),
    premium:
      premium === '' || SOLD_WORDS.test(premium) || PRICE.test(premium)
        ? null
        : clipped(premium, MAX_PULSE_PREMIUM_LENGTH),
    sources,
  };
}
