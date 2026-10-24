import { describe, expect, it } from 'vitest';

import { CURRENT_PRICE_TABLE } from './prices.ts';
import { InMemoryUsageStore, utcMonthRange, type UsageEventInput } from './usage-store.ts';

function event(overrides: Partial<UsageEventInput> = {}): UsageEventInput {
  return {
    accountId: 'account',
    userId: null,
    itemId: null,
    purpose: 'item_analysis',
    tier: 'standard',
    provider: 'fake',
    model: 'claude-haiku-5-5',
    usage: {
      inputTokens: 6_800,
      outputTokens: 1_500,
      cacheReadTokens: 100,
      cacheWriteTokens: 50,
      webSearches: 1,
    },
    images: 4,
    batch: false,
    costMicros: 11_430,
    priceTableVersion: CURRENT_PRICE_TABLE.version,
    latencyMs: 812,
    outcome: 'succeeded',
    errorCode: null,
    ...overrides,
  };
}

describe('utcMonthRange', () => {
  it.each([
    ['2026-10', '2026-10-01', '2026-11-01'],
    ['2026-12', '2026-12-01', '2027-01-01'],
    ['2028-02', '2028-02-01', '2028-03-01'],
    ['0999-01', '0999-01-01', '0999-02-01'],
  ])('spans %s', (month, start, end) => {
    expect(utcMonthRange(month)).toEqual({ start, end });
  });

  it.each(['2026-13', '2026-00', '2026-1', '26-10', '2026-10-01', ''])('rejects %j', (month) => {
    expect(() => utcMonthRange(month)).toThrow(RangeError);
  });
});

describe('InMemoryUsageStore.monthlyUsage', () => {
  it('sums the UTC calendar month, including both boundary instants, for one account', async () => {
    let now = new Date('2026-09-30T23:59:59.999Z');
    const store = new InMemoryUsageStore({ now: () => now });
    await store.record(event({ costMicros: 1 }));
    now = new Date('2026-10-01T00:00:00.000Z');
    await store.record(event());
    now = new Date('2026-10-31T23:59:59.999Z');
    await store.record(event({ outcome: 'failed', errorCode: 'truncated', costMicros: 4_680 }));
    await store.record(event({ accountId: 'other', costMicros: 7 }));
    now = new Date('2026-11-01T00:00:00.000Z');
    await store.record(event({ costMicros: 2 }));

    expect(await store.monthlyUsage('account', '2026-10')).toEqual({
      costMicros: 16_110,
      calls: 2,
      failedCalls: 1,
      inputTokens: 13_600,
      outputTokens: 3_000,
      cacheReadTokens: 200,
      cacheWriteTokens: 100,
      images: 8,
      webSearches: 2,
    });
    expect((await store.monthlyUsage('account', '2026-09')).costMicros).toBe(1);
    expect((await store.monthlyUsage('account', '2026-11')).costMicros).toBe(2);
  });

  it('reports zeros for a month without usage', async () => {
    expect(await new InMemoryUsageStore().monthlyUsage('account', '2026-10')).toEqual({
      costMicros: 0,
      calls: 0,
      failedCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      images: 0,
      webSearches: 0,
    });
  });
});
