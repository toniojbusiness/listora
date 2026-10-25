import { describe, expect, it } from 'vitest';

import { DailyCallBudget, type TradingUsage } from './budget.ts';

const signal = new AbortController().signal;
const HOUR = 60 * 60 * 1000;

function clock(start = Date.UTC(2026, 9, 24, 12)) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('DailyCallBudget', () => {
  it('keeps a reserve that only urgent calls may use', async () => {
    const time = clock();
    const budget = new DailyCallBudget({ dailyLimit: 100, reserveRatio: 0.1, now: time.now });
    for (let call = 0; call < 90; call += 1) {
      expect(await budget.take('normal', signal)).toEqual({ ok: true });
    }
    const refused = await budget.take('normal', signal);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.retryAfterMs).toBe(24 * HOUR);
    for (let call = 0; call < 10; call += 1) {
      expect(await budget.take('urgent', signal)).toEqual({ ok: true });
    }
    expect((await budget.take('urgent', signal)).ok).toBe(false);
  });

  it('starts a fresh window when the day is over', async () => {
    const time = clock();
    const budget = new DailyCallBudget({ dailyLimit: 100, now: time.now });
    for (let call = 0; call < 100; call += 1) await budget.take('urgent', signal);
    expect((await budget.take('urgent', signal)).ok).toBe(false);
    time.advance(24 * HOUR);
    expect(await budget.take('normal', signal)).toEqual({ ok: true });
    expect(budget.remaining).toBe(99);
  });

  it("follows eBay's reported usage, re-reading it on schedule and when short of calls", async () => {
    const time = clock();
    const reads: number[] = [];
    let reported: TradingUsage = {
      limit: 5_000,
      remaining: 4_000,
      resetAt: time.now() + 2 * HOUR,
      windowMs: 24 * HOUR,
    };
    const budget = new DailyCallBudget({
      dailyLimit: 5_000,
      now: time.now,
      syncIntervalMs: 10 * 60_000,
      usage: {
        read: () => {
          reads.push(time.now());
          return Promise.resolve(reported);
        },
      },
    });
    await budget.take('normal', signal);
    expect(budget.remaining).toBe(3_999);
    await budget.take('normal', signal);
    expect(reads).toHaveLength(1);

    // Other processes used most of the quota; the next scheduled read shows it.
    reported = { ...reported, remaining: 400 };
    time.advance(10 * 60_000);
    const refused = await budget.take('normal', signal);
    expect(reads).toHaveLength(2);
    expect(refused).toEqual({ ok: false, retryAfterMs: 2 * HOUR - 10 * 60_000 });
    expect(await budget.take('urgent', signal)).toEqual({ ok: true });

    // Short of calls, it re-reads sooner (but not more than once a minute).
    reported = { ...reported, remaining: 4_500 };
    time.advance(30_000);
    expect((await budget.take('normal', signal)).ok).toBe(false);
    time.advance(30_000);
    expect(await budget.take('normal', signal)).toEqual({ ok: true });
    expect(reads).toHaveLength(3);
  });

  it('counts locally when the usage cannot be read', async () => {
    const time = clock();
    const budget = new DailyCallBudget({
      dailyLimit: 200,
      now: time.now,
      usage: { read: () => Promise.reject(new Error('unreachable')) },
    });
    expect(await budget.take('normal', signal)).toEqual({ ok: true });
    expect(budget.remaining).toBe(199);
  });

  it('admits nothing after eBay says the limit is reached, until the reset', async () => {
    const time = clock();
    const budget = new DailyCallBudget({ dailyLimit: 100, now: time.now });
    await budget.take('normal', signal);
    time.advance(HOUR);
    expect(budget.exhausted()).toBe(23 * HOUR);
    expect((await budget.take('urgent', signal)).ok).toBe(false);
    time.advance(23 * HOUR);
    expect(await budget.take('urgent', signal)).toEqual({ ok: true });
  });
});
