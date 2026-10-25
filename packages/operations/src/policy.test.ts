import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RETRY_POLICY,
  delayAfterAttempt,
  maxAttempts,
  queuePollIntervalMs,
  RETRY_DELAYS_MS,
  scaledRetryPolicy,
  type RetryPolicy,
} from './policy.ts';

const exact = (random: number): RetryPolicy => ({ ...DEFAULT_RETRY_POLICY, random: () => random });

describe('retry policy', () => {
  it('follows the documented schedule: 30 s, 2 m, 10 m, 30 m, 2 h, 6 h', () => {
    expect(RETRY_DELAYS_MS).toEqual([
      30_000,
      2 * 60_000,
      10 * 60_000,
      30 * 60_000,
      2 * 3_600_000,
      6 * 3_600_000,
    ]);
    expect(maxAttempts(DEFAULT_RETRY_POLICY)).toBe(7);
    const midpoint = exact(0.5);
    expect([1, 2, 3, 4, 5, 6].map((attempt) => delayAfterAttempt(midpoint, attempt))).toEqual(
      RETRY_DELAYS_MS,
    );
  });

  it('keeps using the last delay after the schedule runs out', () => {
    expect(delayAfterAttempt(exact(0.5), 7)).toBe(6 * 3_600_000);
    expect(delayAfterAttempt(exact(0.5), 40)).toBe(6 * 3_600_000);
  });

  it('jitters each delay by at most 20% either way', () => {
    expect(delayAfterAttempt(exact(0), 1)).toBe(24_000);
    expect(delayAfterAttempt(exact(0.999_999), 1)).toBe(36_000);
    for (let index = 0; index < 200; index += 1) {
      const delay = delayAfterAttempt(DEFAULT_RETRY_POLICY, 2);
      expect(delay).toBeGreaterThanOrEqual(96_000);
      expect(delay).toBeLessThanOrEqual(144_000);
    }
  });

  it('honors Retry-After, capped at the longest delay', () => {
    expect(delayAfterAttempt(exact(0.5), 1, 90_000)).toBe(90_000);
    expect(delayAfterAttempt(exact(0.5), 1, 1_000)).toBe(30_000);
    expect(delayAfterAttempt(exact(0.5), 1, 7 * 24 * 3_600_000)).toBe(6 * 3_600_000);
  });

  it('scales every delay for local stacks, keeping the number of attempts', () => {
    const scaled = scaledRetryPolicy(0.1);
    expect(scaled.delaysMs).toEqual(RETRY_DELAYS_MS.map((delay) => delay / 10));
    expect(maxAttempts(scaled)).toBe(maxAttempts(DEFAULT_RETRY_POLICY));
    expect(scaledRetryPolicy(1).delaysMs).toEqual(RETRY_DELAYS_MS);
    for (const scale of [0, -1, 1.5, Number.NaN]) {
      expect(() => scaledRetryPolicy(scale)).toThrow(RangeError);
    }
  });

  it('polls the queue at a sixth of the shortest delay, between 2 s and 5 s', () => {
    expect(queuePollIntervalMs(DEFAULT_RETRY_POLICY)).toBe(5_000);
    expect(queuePollIntervalMs({ ...DEFAULT_RETRY_POLICY, delaysMs: [18_000] })).toBe(3_000);
    // The local stack's tenth-scale delays (3 s first) keep the 2 s floor.
    expect(queuePollIntervalMs(scaledRetryPolicy(0.1))).toBe(2_000);
    expect(queuePollIntervalMs({ ...DEFAULT_RETRY_POLICY, delaysMs: [600_000] })).toBe(5_000);
  });
});
