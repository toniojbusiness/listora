import { describe, expect, it, vi } from 'vitest';

import { AiGuardError, type QuotaPolicy } from '@listora/ai';

import {
  ANALYSIS_QUOTA,
  AnalysisFailedError,
  analysisFailure,
  analyzeItem,
  MAX_ANALYSIS_ATTEMPTS,
} from './analyze.ts';
import { analysisFixture, answer, client, sequencedFixtures, tagInput } from './test-support.ts';

async function failure(work: Promise<unknown>): Promise<AnalysisFailedError> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(AnalysisFailedError);
  return error as AnalysisFailedError;
}

const input = tagInput();
const BAD_ANSWER = {
  ...answer(),
  variants: { ...answer().variants, ebay: { title: 'x'.repeat(81), description: 'too long' } },
};

describe('analyzeItem', () => {
  it('is deterministic with the fake provider: same photo set, same result and cost', async () => {
    const { ai, usageStore } = client();
    const first = await analyzeItem(ai, input, { tier: 'standard' });
    const second = await analyzeItem(ai, input, { tier: 'standard' });
    expect(second).toEqual(first);
    expect(first).toMatchObject({ model: 'claude-haiku-5-5', attempts: 1 });
    expect(first.costMicros).toBeGreaterThan(0);
    expect(first.result.details.rnNumber).toMatchObject({ value: '12345', provenance: 'ocr' });
    // Every call is metered with the analysis purpose, tier, and image count.
    expect(usageStore.events).toHaveLength(2);
    expect(usageStore.events[0]).toMatchObject({
      purpose: 'item_analysis',
      tier: 'standard',
      outcome: 'succeeded',
      images: 3,
      costMicros: first.costMicros,
    });
  });

  it('serves the premium tier with its own model', async () => {
    const { ai, usageStore } = client();
    const outcome = await analyzeItem(ai, input, {
      tier: 'premium',
      firstAnalysis: (await analyzeItem(ai, input, { tier: 'standard' })).result,
    });
    expect(outcome.model).toBe('claude-sonnet-5-5');
    expect(usageStore.events.map((event) => event.tier)).toEqual(['standard', 'premium']);
  });

  it('rejects an answer that breaks the schema and retries once, metering both calls', async () => {
    const { ai, usageStore } = client({
      fixtures: sequencedFixtures(input.photoSetHash, [
        analysisFixture(BAD_ANSWER),
        analysisFixture(answer()),
      ]),
    });
    const outcome = await analyzeItem(ai, input, { tier: 'standard' });
    expect(outcome.attempts).toBe(2);
    expect(usageStore.events.map((event) => [event.outcome, event.errorCode])).toEqual([
      ['failed', 'invalid_output'],
      ['succeeded', null],
    ]);
    expect(outcome.costMicros).toBe(
      usageStore.events.reduce((sum, event) => sum + event.costMicros, 0),
    );
  });

  it('fails visibly after a second schema violation, with what it cost', async () => {
    const { ai, usageStore } = client({ fixture: analysisFixture(BAD_ANSWER) });
    const error = await failure(analyzeItem(ai, input, { tier: 'standard' }));
    expect(error).toMatchObject({
      code: 'invalid_output',
      message: 'The AI gave an unusable answer twice in a row. Try again.',
      retryable: true,
      attempts: MAX_ANALYSIS_ATTEMPTS,
    });
    expect(usageStore.events).toHaveLength(MAX_ANALYSIS_ATTEMPTS);
    expect(error.costMicros).toBe(
      usageStore.events.reduce((sum, event) => sum + event.costMicros, 0),
    );
  });

  it('does not retry other failures', async () => {
    const { ai, usageStore } = client({
      fixture: { error: { code: 'rate_limited', retryable: true } },
    });
    const error = await failure(analyzeItem(ai, input, { tier: 'standard' }));
    expect(error).toMatchObject({ code: 'rate_limited', retryable: true, attempts: 1 });
    expect(usageStore.events).toHaveLength(1);

    const refused = client({ fixture: { error: { code: 'refusal' } } });
    expect(await failure(analyzeItem(refused.ai, input, { tier: 'standard' }))).toMatchObject({
      code: 'refusal',
      retryable: false,
    });
  });

  it('fails without calling the provider when a guard refuses', async () => {
    const killed = client({ killSwitch: true });
    expect(await failure(analyzeItem(killed.ai, input, { tier: 'standard' }))).toMatchObject({
      code: 'ai_unavailable',
      retryable: true,
      attempts: 1,
      costMicros: 0,
    });
    expect(killed.usageStore.events).toHaveLength(0);

    const broke = client({ dailyBudgetMicros: 0 });
    const budget = await failure(analyzeItem(broke.ai, input, { tier: 'standard' }));
    expect(budget.code).toBe('ai_budget_exceeded');
    expect(budget.message).toContain('2026-10-25T00:00:00.000Z');
  });

  it('uses up one plan unit per successful analysis: ai_items, or premium_identifications', async () => {
    const consume = vi.fn<QuotaPolicy['consume']>(() => Promise.resolve());
    const quota: QuotaPolicy = { check: () => Promise.resolve({ allowed: true }), consume };
    const { ai } = client({ quota });
    await analyzeItem(ai, input, { tier: 'standard' });
    await analyzeItem(ai, input, { tier: 'premium' });
    expect(consume.mock.calls.map(([context]) => context.charge)).toEqual([
      ANALYSIS_QUOTA.standard,
      ANALYSIS_QUOTA.premium,
    ]);

    const used: QuotaPolicy = {
      check: () => Promise.resolve({ allowed: false, used: 15, limit: 15 }),
      consume,
    };
    const refused = await failure(
      analyzeItem(client({ quota: used }).ai, input, { tier: 'premium' }),
    );
    expect(refused).toMatchObject({
      code: 'quota_exceeded',
      message: "This month's premium identifications in your plan are used up.",
      retryable: false,
    });
  });
});

describe('analysisFailure', () => {
  it('never shows an unexpected error to the user', () => {
    expect(analysisFailure(new Error('connection string postgres://secret'))).toEqual({
      code: 'internal_error',
      message: 'The analysis failed unexpectedly. Try again.',
      retryable: true,
    });
    expect(analysisFailure(new AiGuardError({ kind: 'kill_switch' })).code).toBe('ai_unavailable');
    expect(analysisFailure(new AiGuardError({ kind: 'account_blocked' }))).toEqual({
      code: 'ai_account_blocked',
      message: 'AI analysis is turned off for this account. Contact support.',
      retryable: false,
    });
  });
});
