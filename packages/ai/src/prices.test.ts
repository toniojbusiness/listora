import { describe, expect, it } from 'vitest';

import {
  costMicros,
  CURRENT_PRICE_TABLE,
  PRICE_TABLES,
  priceTable,
  UnpricedModelError,
  type BillableUsage,
} from './prices.ts';

const table = CURRENT_PRICE_TABLE;

function usage(fields: Partial<BillableUsage>): BillableUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    webSearches: 0,
    ...fields,
  };
}

describe('costMicros', () => {
  it('prices the plan per-item estimate for the Fast tier (Haiku 5.5)', () => {
    // Plan section 5.3: 6,800 input and 1,500 output tokens, about $0.0014.
    // 6,800 x $0.10/M = $0.00068 and 1,500 x $0.50/M = $0.00075.
    expect(
      costMicros(table, 'claude-haiku-5-5', usage({ inputTokens: 6_800, outputTokens: 1_500 })),
    ).toBe(1_430);
  });

  it('prices the Premium tier (Sonnet 5.5)', () => {
    // 7,800 x $2/M + 3,000 x $10/M = $0.0156 + $0.03.
    expect(
      costMicros(table, 'claude-sonnet-5-5', usage({ inputTokens: 7_800, outputTokens: 3_000 })),
    ).toBe(45_600);
  });

  it('prices every token category and web searches separately', () => {
    const fields = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    };
    expect(costMicros(table, 'claude-sonnet-5-5', usage({ inputTokens: 1_000_000 }))).toBe(
      2_000_000,
    );
    expect(costMicros(table, 'claude-sonnet-5-5', usage({ cacheReadTokens: 1_000_000 }))).toBe(
      100_000,
    );
    expect(costMicros(table, 'claude-sonnet-5-5', usage({ cacheWriteTokens: 1_000_000 }))).toBe(
      2_500_000,
    );
    expect(costMicros(table, 'claude-opus-5-5', usage(fields))).toBe(
      4_000_000 + 20_000_000 + 200_000 + 5_000_000,
    );
    // $10 per 1,000 searches.
    expect(costMicros(table, 'claude-sonnet-5-5', usage({ webSearches: 3 }))).toBe(30_000);
  });

  it('applies the Haiku long-context prices when the whole prompt is over 100K tokens', () => {
    const atThreshold = usage({
      inputTokens: 60_000,
      cacheReadTokens: 40_000,
      outputTokens: 1_000,
    });
    // 60,000 x $0.10/M + 40,000 x $0.01/M + 1,000 x $0.50/M
    expect(costMicros(table, 'claude-haiku-5-5', atThreshold)).toBe(6_000 + 400 + 500);

    const over = usage({ inputTokens: 60_001, cacheReadTokens: 40_000, outputTokens: 1_000 });
    // Every token of the request pays the higher prices: $0.50, $0.05, and $2.50 per M.
    expect(costMicros(table, 'claude-haiku-5-5', over)).toBe(Math.ceil(30_000.5) + 2_000 + 2_500);
  });

  it('halves token prices for Batch API calls but not web searches', () => {
    const tokens = { inputTokens: 6_800, outputTokens: 1_500 };
    expect(costMicros(table, 'claude-haiku-5-5', usage({ ...tokens, batch: true }))).toBe(715);
    expect(
      costMicros(
        table,
        'claude-sonnet-5-5',
        usage({ inputTokens: 1_000, batch: true, webSearches: 1 }),
      ),
    ).toBe(1_000 + 10_000);
  });

  it('rounds the total up to the next micro-dollar, once', () => {
    // One Haiku input token is a tenth of a micro-dollar.
    expect(costMicros(table, 'claude-haiku-5-5', usage({ inputTokens: 1 }))).toBe(1);
    // Ten such tokens are exactly one micro-dollar; rounding per category would give more.
    expect(
      costMicros(table, 'claude-haiku-5-5', usage({ inputTokens: 5, cacheReadTokens: 50 })),
    ).toBe(1);
    expect(costMicros(table, 'claude-haiku-5-5', usage({}))).toBe(0);
  });

  it('rejects unpriced models and invalid usage', () => {
    expect(() => costMicros(table, 'claude-unknown', usage({ inputTokens: 1 }))).toThrow(
      UnpricedModelError,
    );
    expect(() => costMicros(table, 'toString', usage({}))).toThrow(UnpricedModelError);
    expect(() => costMicros(table, 'claude-haiku-5-5', usage({ inputTokens: -1 }))).toThrow(
      RangeError,
    );
    expect(() => costMicros(table, 'claude-haiku-5-5', usage({ outputTokens: 1.5 }))).toThrow(
      RangeError,
    );
  });
});

describe('price tables', () => {
  it('finds a table by version and rejects unknown versions', () => {
    expect(priceTable(CURRENT_PRICE_TABLE.version)).toBe(CURRENT_PRICE_TABLE);
    expect(() => priceTable('1999-01-01')).toThrow(RangeError);
  });

  it('keeps every version unique and every price an integer', () => {
    const versions = PRICE_TABLES.map((candidate) => candidate.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect(PRICE_TABLES).toContain(CURRENT_PRICE_TABLE);
    for (const candidate of PRICE_TABLES) {
      for (const prices of Object.values(candidate.models)) {
        const all = [prices, ...(prices.longContext ? [prices.longContext.prices] : [])];
        for (const tier of all) {
          for (const value of [tier.input, tier.output, tier.cacheRead, tier.cacheWrite]) {
            expect(Number.isSafeInteger(value) && value > 0).toBe(true);
          }
        }
      }
    }
  });
});
