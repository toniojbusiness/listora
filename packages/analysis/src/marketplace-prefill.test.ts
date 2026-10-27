import { AiCallError } from '@listora/ai';
import { describe, expect, it } from 'vitest';

import {
  MARKETPLACE_PREFILL_OUTPUT_NAME,
  MAX_PREFILL_QUESTIONS,
  pickPrefillOptions,
  prefillPrompt,
  readPicks,
  type PrefillItemFacts,
  type PrefillQuestion,
} from './marketplace-prefill.ts';
import { ACCOUNT, client } from './test-support.ts';

const HASH = 'b'.repeat(64);
const ITEM_ID = '00000000-0000-7000-8000-0000000000c1';

const ITEM: PrefillItemFacts = {
  title: 'LEGO Star Wars X-wing building set',
  productName: null,
  brand: 'LEGO',
  category: 'other/other',
  department: 'kids',
  sizeLabel: null,
  sizeSystem: null,
  colors: ['gray'],
  keywords: ['lego', 'building blocks'],
  description: 'Complete set with instructions. '.repeat(40),
};

const QUESTIONS: PrefillQuestion[] = [
  {
    key: 'mercari.category',
    question: 'Mercari category',
    options: [
      {
        value: 'Toys & Collectibles > Building Toys > Toy Building Blocks',
        label: 'Toy Building Blocks',
      },
      { value: 'Toys & Collectibles > Building Toys > LEGO Toys', label: 'LEGO Toys' },
    ],
  },
  {
    key: 'kids_gender',
    question: "Is this kids' item for girls or for boys?",
    options: [
      { value: 'girls', label: 'Girls' },
      { value: 'boys', label: 'Boys' },
    ],
  },
];

function input() {
  return {
    accountId: ACCOUNT,
    userId: null,
    itemId: ITEM_ID,
    photoSetHash: HASH,
    item: ITEM,
    questions: QUESTIONS,
  };
}

describe('pickPrefillOptions', () => {
  it('asks every question in one text-only call on the standard tier and meters it', async () => {
    const { ai, usageStore } = client({
      hash: HASH,
      fixture: {
        outputs: {
          [MARKETPLACE_PREFILL_OUTPUT_NAME]: {
            picks: [
              { question: 'mercari.category', option: 2, confidence: 0.95 },
              { question: 'kids_gender', option: 0, confidence: 0.2 },
            ],
          },
        },
      },
    });
    const { picks, result } = await pickPrefillOptions(ai, input());
    expect(picks.get('mercari.category')).toEqual({
      value: 'Toys & Collectibles > Building Toys > LEGO Toys',
      confidence: 0.95,
    });
    // "None fits" is a pick of none, so the seller is asked.
    expect(picks.get('kids_gender')).toEqual({ value: null, confidence: 0 });
    expect(usageStore.events).toHaveLength(1);
    expect(usageStore.events[0]).toMatchObject({
      purpose: 'marketplace_prefill',
      tier: 'standard',
      model: 'claude-haiku-5-5',
      images: 0,
      outcome: 'succeeded',
    });
    expect(result.costMicros).toBeGreaterThan(0);
    // A few hundred tokens: a fraction of a cent per item.
    expect(result.costMicros).toBeLessThan(1_000);
  });

  it('meters a failed call and throws it', async () => {
    const { ai, usageStore } = client({
      hash: HASH,
      fixture: { outputs: {}, error: { code: 'truncated', retryable: false } },
    });
    await expect(pickPrefillOptions(ai, input())).rejects.toBeInstanceOf(AiCallError);
    expect(usageStore.events[0]).toMatchObject({ outcome: 'failed' });
  });
});

describe('the pre-fill prompt and its answer', () => {
  it('numbers each question’s options and cuts a long description', () => {
    const prompt = JSON.parse(prefillPrompt(ITEM, QUESTIONS)) as {
      item: { description: string };
      questions: { id: string; options: string[] }[];
    };
    expect(prompt.questions[0]).toMatchObject({
      id: 'mercari.category',
      options: ['1. Toy Building Blocks', '2. LEGO Toys'],
    });
    expect(prompt.item.description.length).toBeLessThanOrEqual(603);
  });

  it('reads an option off the list, or a missing pick, as no pick', () => {
    const picks = readPicks(QUESTIONS, {
      picks: [{ question: 'mercari.category', option: 7, confidence: 0.9 }],
    });
    expect(picks.get('mercari.category')).toEqual({ value: null, confidence: 0 });
    expect(picks.get('kids_gender')).toEqual({ value: null, confidence: 0 });
    expect(MAX_PREFILL_QUESTIONS).toBeGreaterThanOrEqual(7);
  });
});
