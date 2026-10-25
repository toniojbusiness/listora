import { describe, expect, it } from 'vitest';

import { abortableSleep, Pacing } from './pacing.ts';

const SETTINGS = {
  actionDelayMs: [800, 2500],
  keystrokeDelayMs: [60, 180],
  sessionGapMs: [5_000, 20_000],
} as const;

describe('Pacing', () => {
  it('picks every delay at random inside its range', () => {
    const at = (random: number) => new Pacing(SETTINGS, { random: () => random });
    expect(at(0).delayMs('action')).toBe(800);
    expect(at(0.5).delayMs('action')).toBe(1650);
    expect(at(0.999_999).delayMs('action')).toBe(2500);
    expect(at(0.5).delayMs('keystroke')).toBe(120);
    expect(at(0.5).delayMs('session')).toBe(12_500);
    const real = new Pacing(SETTINGS);
    const delays = Array.from({ length: 200 }, () => real.delayMs('action'));
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(800);
    expect(Math.max(...delays)).toBeLessThanOrEqual(2500);
    expect(new Set(delays).size).toBeGreaterThan(20);
  });

  it('waits each delay, and only the rest of one already partly waited', async () => {
    const waited: number[] = [];
    const pacing = new Pacing(SETTINGS, {
      random: () => 0,
      sleep: (ms) => {
        waited.push(ms);
        return Promise.resolve();
      },
    });
    const signal = new AbortController().signal;
    await pacing.wait('action', signal);
    await pacing.wait('keystroke', signal);
    await pacing.waitFor(1_200, signal);
    await pacing.waitFor(-5, signal);
    expect(waited).toEqual([800, 60, 1_200]);
  });

  it('refuses ranges that run backwards or below zero', () => {
    expect(() => new Pacing({ ...SETTINGS, actionDelayMs: [10, 5] })).toThrow(RangeError);
    expect(() => new Pacing({ ...SETTINGS, sessionGapMs: [-1, 5] })).toThrow(RangeError);
  });
});

describe('abortableSleep', () => {
  it('stops waiting when its signal aborts', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const sleeping = abortableSleep(10_000, controller.signal);
    controller.abort(new Error('stop'));
    await expect(sleeping).rejects.toThrow('stop');
    expect(Date.now() - started).toBeLessThan(1_000);
    await expect(abortableSleep(10, controller.signal)).rejects.toThrow('stop');
  });
});
