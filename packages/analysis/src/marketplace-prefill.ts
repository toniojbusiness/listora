/**
 * The AI half of the marketplace pre-fill (docs/features/marketplace-prefill.md): the questions
 * Listora's own mapping can't settle (which of Mercari's 3,233 categories a toy goes in, whether a
 * kids' tee is for girls or boys, which US size a UK 10 is), each with a short list Listora
 * ranked from the marketplace's real category tree or size list, answered in one call of the
 * cheap tier. The model only picks from the lists, with how sure it is; the pre-fill uses a pick
 * when it is sure and asks the seller otherwise.
 */
import type { AiClient, AiResult, OutputSchema } from '@listora/ai';
import { z } from 'zod';

/** `ai_usage_event.purpose` of the call. */
export const MARKETPLACE_PREFILL_PURPOSE = 'marketplace_prefill';

/** The output schema's name; the fake provider's fixtures key their answer by it. */
export const MARKETPLACE_PREFILL_OUTPUT_NAME = 'marketplace_prefill';

/** At most this many questions go in one call (an item has at most a handful). */
export const MAX_PREFILL_QUESTIONS = 12;

const answerSchema = z
  .object({
    picks: z
      .array(
        z
          .object({
            question: z.string().describe('The question id, as given'),
            option: z
              .number()
              .int()
              .min(0)
              .describe('The number of the option that fits; 0 when none fits or you cannot tell'),
            confidence: z.number().min(0).max(1),
          })
          .strict(),
      )
      .max(MAX_PREFILL_QUESTIONS),
  })
  .strict();
export type MarketplacePrefillAnswer = z.infer<typeof answerSchema>;

export const MARKETPLACE_PREFILL_OUTPUT: OutputSchema<MarketplacePrefillAnswer> = {
  name: MARKETPLACE_PREFILL_OUTPUT_NAME,
  schema: answerSchema,
};

/**
 * The stable instructions of every call (nothing per item, so they cache). The answer is small
 * enough for strict structured output, which holds the model to the schema.
 */
export const MARKETPLACE_PREFILL_SYSTEM = [
  'You help a reseller list one secondhand item on resale marketplaces (Depop, Poshmark,',
  "Mercari). Each marketplace's sell form needs its own category and size, picked from its own",
  "lists. The user message is JSON: `item`, the item's details as the seller's review has them,",
  'and `questions`, each with an `id`, what is being chosen, and numbered `options` taken from',
  "the marketplace's real lists. For each question, pick the one option that fits the item.",
  'Rules:',
  '- Answer every question once, with its id. `option` is the number of the option you pick, or',
  '  0 when none of them fits or the details do not tell. Never invent an option.',
  '- `confidence` is 0 to 1: how sure you are that a careful seller would pick the same. Below 0.7',
  '  means the seller should choose, so use it when the details leave it open (a plain tee is',
  "  not for girls or for boys), and 0.9 or more only when the item's own words say so.",
  '- A category is where buyers of this kind of item look: the most specific option that is',
  "  true of the item. Prefer the item's department (women, men, kids); an option outside it is",
  '  right only for items that are not clothing for a person (toys, home, electronics).',
  '- A size is the label of the marketplace that is the same size as the tag. A UK or EU size',
  '  may be converted to the US size it is when the conversion is standard (a UK women 10 is a',
  '  US 6); otherwise answer 0.',
  "- Girls or boys: only when the item's words, its kind, or its description say who it is for.",
].join('\n');

/** One question, as the pre-fill states it (a `PrefillDecision` of @listora/automation). */
export interface PrefillQuestion {
  readonly key: string;
  readonly question: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}

/** The item's details the model reads: text only, never photos. */
export interface PrefillItemFacts {
  readonly title: string | null;
  readonly productName: string | null;
  readonly brand: string | null;
  readonly category: string | null;
  readonly department: string | null;
  readonly sizeLabel: string | null;
  readonly sizeSystem: string | null;
  readonly colors: readonly string[];
  readonly keywords: readonly string[];
  readonly description: string | null;
}

export interface PrefillPickInput {
  readonly accountId: string;
  readonly userId: string | null;
  readonly itemId: string;
  /** The item's photo-set hash: the call is about the item those photos show. */
  readonly photoSetHash: string;
  readonly item: PrefillItemFacts;
  readonly questions: readonly PrefillQuestion[];
  readonly signal?: AbortSignal;
}

/** The model's pick for a question: the option's value, or `null` when it picked none. */
export interface PrefillQuestionPick {
  readonly value: string | null;
  readonly confidence: number;
}

/** How much of the description the model reads: enough to say what the item is. */
const DESCRIPTION_CHARS = 600;

/**
 * Asks the questions in one call of the standard (cheap) tier through `AiClient`, so the guards
 * and metering apply and the cost counts in the daily budget; it uses no plan quota. Text only,
 * no images. Every question gets a pick: one the model left out, or answered with a number off
 * its list, is a pick of none (`value: null`), so the seller is asked. Throws what
 * `AiClient.generate` throws (`AiGuardError`, `AiCallError`).
 */
export async function pickPrefillOptions(
  client: AiClient,
  input: PrefillPickInput,
): Promise<{
  picks: Map<string, PrefillQuestionPick>;
  result: AiResult<MarketplacePrefillAnswer>;
}> {
  const questions = input.questions.slice(0, MAX_PREFILL_QUESTIONS);
  const result = await client.generate({
    context: {
      accountId: input.accountId,
      userId: input.userId,
      itemId: input.itemId,
      purpose: MARKETPLACE_PREFILL_PURPOSE,
    },
    tier: 'standard',
    system: MARKETPLACE_PREFILL_SYSTEM,
    prompt: prefillPrompt(input.item, questions),
    photoSetHash: input.photoSetHash,
    images: [],
    output: MARKETPLACE_PREFILL_OUTPUT,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return { picks: readPicks(questions, result.output), result };
}

/** The user message: the item's details and the numbered questions, as JSON. */
export function prefillPrompt(
  item: PrefillItemFacts,
  questions: readonly PrefillQuestion[],
): string {
  const description = item.description?.trim() ?? '';
  return JSON.stringify({
    item: {
      title: item.title,
      productName: item.productName,
      brand: item.brand,
      category: item.category,
      department: item.department,
      size: item.sizeLabel,
      sizeSystem: item.sizeSystem,
      colors: item.colors,
      keywords: item.keywords,
      description:
        description.length > DESCRIPTION_CHARS
          ? `${description.slice(0, DESCRIPTION_CHARS)}...`
          : description,
    },
    questions: questions.map((question) => ({
      id: question.key,
      choose: question.question,
      options: question.options.map((option, index) => `${String(index + 1)}. ${option.label}`),
    })),
  });
}

/** Each question's pick from the answer; a missing or out-of-range one is no pick. */
export function readPicks(
  questions: readonly PrefillQuestion[],
  answer: MarketplacePrefillAnswer,
): Map<string, PrefillQuestionPick> {
  const picks = new Map<string, PrefillQuestionPick>();
  for (const question of questions) {
    const pick = answer.picks.find((entry) => entry.question === question.key);
    const option = pick === undefined ? undefined : question.options[pick.option - 1];
    picks.set(question.key, {
      value: option?.value ?? null,
      confidence: option === undefined || pick === undefined ? 0 : pick.confidence,
    });
  }
  return picks;
}
