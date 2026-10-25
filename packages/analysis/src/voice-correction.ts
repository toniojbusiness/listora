import type { AiClient, OutputSchema } from '@listora/ai';
import {
  knownVoiceCorrectionFieldValues,
  type KnownVoiceCorrectionField,
  type VoiceCorrection,
  type VoiceCorrectionChange,
} from '@listora/api-contract';
import { z } from 'zod';

import {
  CATEGORY_TREE,
  COLORS,
  CONDITIONS,
  DEPARTMENTS,
  MATERIALS,
  PATTERNS,
  SIZE_SYSTEMS,
} from './vocabulary.ts';

/** `ai_usage_event.purpose` of a spoken correction the app could not parse itself. */
export const VOICE_CORRECTION_PURPOSE = 'voice_correction';

/** The output schema's name; the fake provider's fixtures key their answer by it. */
export const VOICE_CORRECTION_OUTPUT_NAME = 'voice_correction';

/** The contract's limits (`VoiceCorrectionRequest`, `VoiceCorrection`). */
export const MAX_VOICE_TRANSCRIPT_LENGTH = 500;
export const MAX_VOICE_CHANGES = 20;
const MAX_VALUE_LENGTH = 200;

/**
 * The model's answer: each change as a field and its value as text, money as dollars ("4.50").
 * It is kept loose on purpose (no lengths or vocabulary), so a value the app could not use is
 * dropped by `normalizeVoiceChanges` instead of failing the whole answer.
 */
const voiceCorrectionAnswerSchema = z
  .object({
    changes: z.array(
      z
        .object({
          field: z.enum(
            knownVoiceCorrectionFieldValues as readonly KnownVoiceCorrectionField[] as [
              KnownVoiceCorrectionField,
              ...KnownVoiceCorrectionField[],
            ],
          ),
          value: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export type VoiceCorrectionAnswer = z.infer<typeof voiceCorrectionAnswerSchema>;

export const VOICE_CORRECTION_OUTPUT: OutputSchema<VoiceCorrectionAnswer> = {
  name: VOICE_CORRECTION_OUTPUT_NAME,
  schema: voiceCorrectionAnswerSchema,
};

const CATEGORY_PATHS: readonly string[] = Object.entries(CATEGORY_TREE).flatMap(
  ([category, subcategories]) => subcategories.map((subcategory) => `${category}/${subcategory}`),
);

/** The canonical values of each canonical field; any other field is free text. */
const CANONICAL: Partial<Record<KnownVoiceCorrectionField, readonly string[]>> = {
  category: CATEGORY_PATHS,
  department: DEPARTMENTS,
  sizeSystem: SIZE_SYSTEMS,
  colors: COLORS,
  pattern: PATTERNS,
  materials: MATERIALS,
  condition: CONDITIONS,
};

/** `ItemDetails`' own limits where they are below a change's 200 characters. */
const TEXT_LIMITS: Partial<Record<KnownVoiceCorrectionField, number>> = {
  brand: 120,
  sizeLabel: 32,
  styleNumber: 64,
  keywords: 64,
};

const MONEY_FIELDS: ReadonlySet<KnownVoiceCorrectionField> = new Set(['cost', 'listPrice']);

/**
 * The stable instructions of every voice-correction call (no per-request values, so they
 * cache), with the canonical vocabulary the canonical fields must use.
 */
export const VOICE_CORRECTION_SYSTEM = [
  'You help a reseller correct the details of one secondhand item on a review screen.',
  'The user message is JSON with `transcript`: what the seller said, transcribed on their',
  "phone. Only phrases the app's own parser could not map are sent. Map each phrase to the",
  'item detail it changes. Rules:',
  '- Propose only what the seller actually said. Never guess, infer from other details, or add',
  '  anything. Ignore filler, chatter, and anything that is not about this item; answer',
  '  `{"changes": []}` when nothing maps.',
  '- One change per detail and value, in the order said. For colors, materials, keywords, and',
  '  flaws, give one change per entry: the colors (or materials) said together replace the',
  '  item\'s, and each keyword or flaw is added (a flaw as a short phrase, like "Small hole',
  '  near the hem").',
  '- These fields take only these canonical values (snake_case, exactly as written):',
  `  category (as <category>/<subcategory>): ${CATEGORY_PATHS.join(', ')}`,
  `  department: ${DEPARTMENTS.join(', ')}`,
  `  sizeSystem: ${SIZE_SYSTEMS.join(', ')}`,
  `  colors: ${COLORS.join(', ')}`,
  `  pattern: ${PATTERNS.join(', ')}`,
  `  materials: ${MATERIALS.join(', ')}`,
  `  condition: ${CONDITIONS.join(', ')}`,
  '  When a phrase has no canonical value that fits, leave it out.',
  '- cost is what the seller paid for the item, listPrice the price to list it at; give either',
  '  as a dollar amount with digits only, like "4" or "29.99". purchaseSource is where they',
  '  bought it ("Goodwill").',
  '- title, brand, productName, sizeLabel, styleNumber, conditionNotes, and keywords are text,',
  '  written the way they would appear on a listing.',
].join('\n');

export interface VoiceCorrectionInput {
  readonly accountId: string;
  readonly userId: string | null;
  readonly itemId: string;
  /** The item's photo-set hash: the call is about the item those photos show. */
  readonly photoSetHash: string;
  /** The phrases the app could not parse, as text; never audio. */
  readonly transcript: string;
  readonly signal?: AbortSignal;
}

/**
 * Maps a spoken correction's text to proposed changes with one call of the standard (cheap)
 * tier through `AiClient`, so the guards and metering apply and the cost counts in the daily
 * budget. It uses no plan quota. Nothing is retried and nothing is stored: the app shows the
 * proposal for the seller to accept. Throws what `AiClient.generate` throws (`AiGuardError`,
 * `AiCallError`).
 */
export async function interpretVoiceCorrection(
  client: AiClient,
  input: VoiceCorrectionInput,
): Promise<VoiceCorrection> {
  const answer = await client.generate({
    context: {
      accountId: input.accountId,
      userId: input.userId,
      itemId: input.itemId,
      purpose: VOICE_CORRECTION_PURPOSE,
    },
    tier: 'standard',
    system: VOICE_CORRECTION_SYSTEM,
    prompt: JSON.stringify({ transcript: input.transcript }),
    photoSetHash: input.photoSetHash,
    images: [],
    output: VOICE_CORRECTION_OUTPUT,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return { changes: normalizeVoiceChanges(answer.output) };
}

/**
 * The model's changes the app can use, as the contract's: canonical values matched to the
 * vocabulary, amounts in cents, text within its detail's limit. Anything else is dropped (the
 * model was told to leave out what it could not map), and repeated changes are kept once.
 */
export function normalizeVoiceChanges(answer: VoiceCorrectionAnswer): VoiceCorrectionChange[] {
  const changes: VoiceCorrectionChange[] = [];
  const seen = new Set<string>();
  for (const { field, value } of answer.changes) {
    const change = normalizeChange(field, value.trim());
    if (change === undefined) continue;
    const key = JSON.stringify(change);
    if (seen.has(key)) continue;
    seen.add(key);
    changes.push(change);
    if (changes.length === MAX_VOICE_CHANGES) break;
  }
  return changes;
}

function normalizeChange(
  field: KnownVoiceCorrectionField,
  value: string,
): VoiceCorrectionChange | undefined {
  if (value === '') return undefined;
  if (MONEY_FIELDS.has(field)) {
    const amountCents = dollarsToCents(value);
    if (amountCents === undefined || (field === 'listPrice' && amountCents === 0)) return undefined;
    return { field, amount: { amountCents, currency: 'USD' } };
  }
  const canonical = CANONICAL[field];
  if (canonical !== undefined) {
    const id = value.toLowerCase().replace(/[\s-]+/g, '_');
    return canonical.includes(id) ? { field, value: id } : undefined;
  }
  const limit = TEXT_LIMITS[field] ?? MAX_VALUE_LENGTH;
  return value.length <= limit ? { field, value } : undefined;
}

/** "4", "$4.5", "29.99", "1,200" as cents; anything else (or over $99,999.99) is undefined. */
export function dollarsToCents(text: string): number | undefined {
  const match = /^\$?(\d{1,3}(?:,\d{3})+|\d{1,5})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (match?.[1] === undefined) return undefined;
  const whole = Number(match[1].replaceAll(',', ''));
  if (whole > 99_999) return undefined;
  const fraction = Number((match[2] ?? '').padEnd(2, '0'));
  return whole * 100 + fraction;
}
