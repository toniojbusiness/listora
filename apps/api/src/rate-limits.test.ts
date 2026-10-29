import { describe, expect, it } from 'vitest';

import { MAX_LIMITED_KEYS, RequestLimiter } from './rate-limits.ts';

describe('RequestLimiter', () => {
  it("lets a minute's worth through at once, then one per share of the minute", () => {
    let now = 0;
    const limiter = new RequestLimiter(3, () => now);
    expect([limiter.take('a'), limiter.take('a'), limiter.take('a')]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(limiter.take('a')).toEqual({ retryAfterSeconds: 20, first: true });
    expect(limiter.take('a')).toEqual({ retryAfterSeconds: 20, first: false });
    now += 15_000;
    expect(limiter.take('a')).toEqual({ retryAfterSeconds: 5, first: false });
    now += 5_000;
    expect(limiter.take('a')).toBeUndefined();
    expect(limiter.take('a')).toMatchObject({ first: true });
    // Never more than a minute's worth saved up.
    now += 3_600_000;
    for (let index = 0; index < 3; index += 1) expect(limiter.take('a')).toBeUndefined();
    expect(limiter.take('a')).toBeDefined();
  });

  it('remembers a bounded number of keys, forgetting the least recent', () => {
    const limiter = new RequestLimiter(1, () => 0);
    expect(limiter.take('first')).toBeUndefined();
    expect(limiter.take('first')).toBeDefined();
    for (let index = 0; index < MAX_LIMITED_KEYS; index += 1) limiter.take(`key-${String(index)}`);
    // Forgotten, so it starts again with a full minute.
    expect(limiter.take('first')).toBeUndefined();
  });
});
