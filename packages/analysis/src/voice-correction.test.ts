import { AiCallError, AiGuardError } from '@listora/ai';
import { describe, expect, it } from 'vitest';

import { ACCOUNT, client } from './test-support.ts';
import {
  dollarsToCents,
  interpretVoiceCorrection,
  normalizeVoiceChanges,
  VOICE_CORRECTION_OUTPUT_NAME,
  VOICE_CORRECTION_SYSTEM,
  type VoiceCorrectionAnswer,
} from './voice-correction.ts';

const HASH = 'a'.repeat(64);
const ITEM = '00000000-0000-7000-8000-0000000000b1';

function input(transcript = 'the pattern is houndstooth and it is from the nineties') {
  return { accountId: ACCOUNT, userId: null, itemId: ITEM, photoSetHash: HASH, transcript };
}

function fixture(answer: unknown) {
  return { outputs: { [VOICE_CORRECTION_OUTPUT_NAME]: answer } };
}

async function rejection(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
}

describe('interpretVoiceCorrection', () => {
  it('sends only the transcript text on the standard tier and meters the call', async () => {
    const { ai, usageStore } = client({
      hash: HASH,
      fixture: fixture({
        changes: [
          { field: 'keywords', value: 'nineties' },
          { field: 'pattern', value: 'houndstooth' },
          { field: 'colors', value: 'Navy' },
        ],
      }),
    });
    const correction = await interpretVoiceCorrection(ai, input());
    // Houndstooth is no canonical pattern, so it is dropped; the color is matched to the
    // vocabulary.
    expect(correction).toEqual({
      changes: [
        { field: 'keywords', value: 'nineties' },
        { field: 'colors', value: 'navy' },
      ],
    });
    expect(usageStore.events).toHaveLength(1);
    expect(usageStore.events[0]).toMatchObject({
      accountId: ACCOUNT,
      itemId: ITEM,
      purpose: 'voice_correction',
      tier: 'standard',
      model: 'claude-haiku-5-5',
      images: 0,
      outcome: 'succeeded',
    });
    expect(usageStore.events[0]?.costMicros).toBeGreaterThan(0);
  });

  it('keeps per-request text out of the cached system prompt and names the vocabulary', () => {
    expect(VOICE_CORRECTION_SYSTEM).not.toContain('houndstooth');
    expect(VOICE_CORRECTION_SYSTEM).toContain('clothing/tops/t_shirts');
    expect(VOICE_CORRECTION_SYSTEM).toContain('pre_owned_good');
  });

  it('is refused before anything is sent once the daily budget is used up', async () => {
    const { ai, usageStore } = client({
      hash: HASH,
      fixture: fixture({ changes: [] }),
      dailyBudgetMicros: 0,
    });
    const error = await rejection(interpretVoiceCorrection(ai, input()));
    expect(error).toBeInstanceOf(AiGuardError);
    expect((error as AiGuardError).reason.kind).toBe('daily_budget');
    expect(usageStore.events).toHaveLength(0);
  });

  it('is refused while the kill switch is on', async () => {
    const { ai } = client({ hash: HASH, fixture: fixture({ changes: [] }), killSwitch: true });
    const error = await rejection(interpretVoiceCorrection(ai, input()));
    expect((error as AiGuardError).reason.kind).toBe('kill_switch');
  });

  it('fails visibly on an answer that breaks the schema, still metering it', async () => {
    const { ai, usageStore } = client({
      hash: HASH,
      fixture: fixture({ changes: [{ field: 'era', value: '1990s' }] }),
    });
    const error = await rejection(interpretVoiceCorrection(ai, input()));
    expect(error).toBeInstanceOf(AiCallError);
    expect((error as AiCallError).code).toBe('invalid_output');
    expect(usageStore.events).toMatchObject([{ outcome: 'failed', errorCode: 'invalid_output' }]);
  });
});

describe('normalizeVoiceChanges', () => {
  function normalize(changes: VoiceCorrectionAnswer['changes']) {
    return normalizeVoiceChanges({ changes });
  }

  it('turns dollar amounts into Money and drops amounts that are not', () => {
    expect(
      normalize([
        { field: 'cost', value: '$4.5' },
        { field: 'listPrice', value: '30' },
        { field: 'listPrice', value: 'thirty' },
        { field: 'listPrice', value: '0' },
        { field: 'cost', value: '0' },
      ]),
    ).toEqual([
      { field: 'cost', amount: { amountCents: 450, currency: 'USD' } },
      { field: 'listPrice', amount: { amountCents: 3000, currency: 'USD' } },
      { field: 'cost', amount: { amountCents: 0, currency: 'USD' } },
    ]);
  });

  it('matches canonical values loosely and drops ones outside the vocabulary', () => {
    expect(
      normalize([
        { field: 'condition', value: 'Pre-owned good' },
        { field: 'category', value: 'clothing/tops/t_shirts' },
        { field: 'category', value: 'clothing/tops' },
        { field: 'department', value: 'Women' },
        { field: 'sizeSystem', value: 'one size' },
        { field: 'materials', value: 'unobtainium' },
        { field: 'materials', value: 'wool' },
      ]),
    ).toEqual([
      { field: 'condition', value: 'pre_owned_good' },
      { field: 'category', value: 'clothing/tops/t_shirts' },
      { field: 'department', value: 'women' },
      { field: 'sizeSystem', value: 'one_size' },
      { field: 'materials', value: 'wool' },
    ]);
  });

  it('keeps text within its detail limit, trimmed, and each change once', () => {
    expect(
      normalize([
        { field: 'brand', value: '  Pendleton ' },
        { field: 'brand', value: 'Pendleton' },
        { field: 'brand', value: 'x'.repeat(121) },
        { field: 'flaws', value: 'Small hole near the hem' },
        { field: 'title', value: '   ' },
      ]),
    ).toEqual([
      { field: 'brand', value: 'Pendleton' },
      { field: 'flaws', value: 'Small hole near the hem' },
    ]);
  });

  it('keeps at most the contract limit of changes', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      field: 'keywords' as const,
      value: `word ${String(index)}`,
    }));
    expect(normalize(many)).toHaveLength(20);
  });
});

describe('dollarsToCents', () => {
  it.each([
    ['4', 400],
    ['$4', 400],
    ['4.5', 450],
    ['4.50', 450],
    ['29.99', 2999],
    ['1,200', 120_000],
    ['99999.99', 9_999_999],
  ])('reads %s as %d cents', (text, cents) => {
    expect(dollarsToCents(text)).toBe(cents);
  });

  it.each(['', 'four', '4.555', '-4', '100000', '1,20', '$'])('rejects %j', (text) => {
    expect(dollarsToCents(text)).toBeUndefined();
  });
});
