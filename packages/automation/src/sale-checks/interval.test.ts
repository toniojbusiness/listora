import { describe, expect, it } from 'vitest';

import { nextSaleCheckDelay } from './interval.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SETTINGS = {
  defaultIntervalMs: 12 * HOUR,
  minIntervalMs: 2 * HOUR,
  maxIntervalMs: 24 * HOUR,
};
/** A Wednesday, 12:00 UTC. */
const NOW = new Date('2026-10-21T12:00:00Z');

const ago = (ms: number) => new Date(NOW.getTime() - ms);

/** Sales every `everyHours` over the last `days` days, starting at `offsetHours`. */
function steady(days: number, everyHours: number, offsetHours = 0.5): Date[] {
  const sales: Date[] = [];
  for (let hours = offsetHours; hours < days * 24; hours += everyHours)
    sales.push(ago(hours * HOUR));
  return sales;
}

/** One sale each evening at `hourUtc` for `days` days. */
function evenings(days: number, hourUtc: number, from = NOW): Date[] {
  return Array.from({ length: days }, (_, day) => {
    const date = new Date(from.getTime() - (day + 1) * DAY);
    date.setUTCHours(hourUtc, 10, 0, 0);
    return date;
  });
}

describe('nextSaleCheckDelay', () => {
  it('checks every 12 hours until the seller has a history to adapt to', () => {
    expect(nextSaleCheckDelay(NOW, [], SETTINGS)).toEqual({ delayMs: 12 * HOUR, basis: 'default' });
    expect(nextSaleCheckDelay(NOW, steady(30, 200), SETTINGS)).toEqual({
      delayMs: 12 * HOUR,
      basis: 'default',
    });
    // Sales older than the history window do not count.
    expect(nextSaleCheckDelay(NOW, steady(400, 24, 100 * 24), SETTINGS).basis).toBe('default');
  });

  it('keeps about the default for sales spread evenly at a steady pace', () => {
    const { delayMs, basis } = nextSaleCheckDelay(NOW, steady(84, 7), SETTINGS);
    expect(basis).toBe('history');
    expect(delayMs).toBeGreaterThan(10 * HOUR);
    expect(delayMs).toBeLessThan(14 * HOUR);
  });

  it('checks sooner ahead of the hours sales usually happen, later in quiet hours', () => {
    const history = evenings(60, 20);
    const beforeTheEvening = nextSaleCheckDelay(
      new Date('2026-10-21T18:00:00Z'),
      history,
      SETTINGS,
    );
    const afterTheEvening = nextSaleCheckDelay(new Date('2026-10-21T22:00:00Z'), history, SETTINGS);
    expect(beforeTheEvening.delayMs).toBeLessThan(afterTheEvening.delayMs);
    expect(beforeTheEvening.delayMs).toBeLessThan(6 * HOUR);
  });

  it('checks sooner while items are hot, and later when sales went idle', () => {
    const base = steady(84, 24, 30 * 24);
    const hot = [...base, ...steady(3, 4)];
    const normal = [...base, ...steady(30, 24)];
    const hotDelay = nextSaleCheckDelay(NOW, hot, SETTINGS).delayMs;
    const normalDelay = nextSaleCheckDelay(NOW, normal, SETTINGS).delayMs;
    const idleDelay = nextSaleCheckDelay(NOW, base, SETTINGS).delayMs;
    expect(hotDelay).toBeLessThan(normalDelay);
    expect(idleDelay).toBeGreaterThan(normalDelay);
  });

  it('always stays within the configured minimum and maximum', () => {
    const bounds = {
      defaultIntervalMs: 6 * HOUR,
      minIntervalMs: 3 * HOUR,
      maxIntervalMs: 9 * HOUR,
    };
    let seed = 42;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let trial = 0; trial < 200; trial += 1) {
      const count = Math.floor(random() * 80);
      const sales = Array.from({ length: count }, () => ago(random() * random() * 84 * DAY));
      const now = new Date(NOW.getTime() + random() * 7 * DAY);
      const { delayMs } = nextSaleCheckDelay(now, sales, bounds);
      expect(delayMs).toBeGreaterThanOrEqual(3 * HOUR);
      expect(delayMs).toBeLessThanOrEqual(9 * HOUR);
    }
    // A flood of sales just now checks sooner, and still never under the minimum.
    const flood = nextSaleCheckDelay(NOW, steady(2, 0.25), bounds).delayMs;
    expect(flood).toBeLessThan(6 * HOUR);
    expect(flood).toBeGreaterThanOrEqual(3 * HOUR);
  });
});
