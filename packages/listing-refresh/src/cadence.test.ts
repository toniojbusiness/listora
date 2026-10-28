import { describe, expect, it } from 'vitest';

import { useMarketplaceFeatures } from '@listora/marketplaces';

import {
  dueAt,
  effectiveCadence,
  formatClock,
  inQuietWindow,
  intervalHours,
  localMinutes,
  nextRefreshAt,
  outsideQuietWindow,
  parseClock,
} from './cadence.ts';
import { canRefresh, listingRefresh, type RefreshFact } from './schedule.ts';

const HOUR = 60 * 60_000;
// 15:00 UTC is 11:00 in New York (EDT, UTC-4) on this day.
const NOW = new Date('2026-10-25T15:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const NIGHT = {
  start: parseClock('22:00') ?? 0,
  end: parseClock('07:00') ?? 0,
  timeZone: 'America/New_York',
};

describe('cadences', () => {
  it('gives each choice its hours, a custom one its own, and none when off', () => {
    expect(intervalHours({ cadence: 'every_72_hours', customHours: null })).toBe(72);
    expect(intervalHours({ cadence: 'daily', customHours: null })).toBe(24);
    expect(intervalHours({ cadence: 'every_few_days', customHours: null })).toBe(120);
    expect(intervalHours({ cadence: 'weekly', customHours: null })).toBe(168);
    expect(intervalHours({ cadence: 'custom', customHours: 36 })).toBe(36);
    expect(intervalHours({ cadence: 'off', customHours: null })).toBeNull();
  });

  it("lets an item's own cadence win over the account's", () => {
    const account = { cadence: 'every_72_hours', customHours: null } as const;
    expect(effectiveCadence(null, account)).toBe(account);
    const off = { cadence: 'off', customHours: null } as const;
    expect(effectiveCadence(off, account)).toBe(off);
  });

  it('is due its interval after the listing was last fresh', () => {
    expect(dueAt(ago(72 * HOUR), 72)).toEqual(NOW);
  });
});

describe('the quiet window', () => {
  it("reads the seller's local time", () => {
    expect(localMinutes(NOW, 'America/New_York')).toBe(11 * 60);
    expect(localMinutes(NOW, 'UTC')).toBe(15 * 60);
  });

  it('runs past midnight when it ends before it starts', () => {
    const at = (iso: string) => inQuietWindow(new Date(iso), NIGHT);
    expect(at('2026-10-26T02:30:00.000Z')).toBe(true); // 22:30 in New York
    expect(at('2026-10-26T10:59:00.000Z')).toBe(true); // 06:59
    expect(at('2026-10-26T11:00:00.000Z')).toBe(false); // 07:00, its end
    expect(at('2026-10-26T01:59:00.000Z')).toBe(false); // 21:59
    expect(inQuietWindow(NOW, null)).toBe(false);
  });

  it('within one day too', () => {
    const lunch = { start: 12 * 60, end: 13 * 60, timeZone: 'UTC' };
    expect(inQuietWindow(new Date('2026-10-25T12:30:00.000Z'), lunch)).toBe(true);
    expect(inQuietWindow(new Date('2026-10-25T13:00:00.000Z'), lunch)).toBe(false);
  });

  it('moves a time inside it to its end', () => {
    expect(outsideQuietWindow(new Date('2026-10-26T02:30:20.000Z'), NIGHT)).toEqual(
      new Date('2026-10-26T11:00:00.000Z'),
    );
    expect(outsideQuietWindow(NOW, NIGHT)).toBe(NOW);
  });
});

describe('the next refresh', () => {
  it('is when it is due, or now once it is overdue, never in the quiet window', () => {
    expect(nextRefreshAt(ago(24 * HOUR), 72, null, NOW)).toEqual(
      new Date(NOW.getTime() + 48 * HOUR),
    );
    expect(nextRefreshAt(ago(100 * HOUR), 72, null, NOW)).toEqual(NOW);
    // Due at 23:00 in New York: it waits for 07:00.
    const freshAt = new Date('2026-10-23T03:00:00.000Z');
    expect(nextRefreshAt(freshAt, 72, NIGHT, NOW)).toEqual(new Date('2026-10-26T11:00:00.000Z'));
  });
});

describe('clock times', () => {
  it('reads and writes HH:MM', () => {
    expect(parseClock('07:05')).toBe(425);
    expect(parseClock('24:00')).toBeNull();
    expect(parseClock('7:05')).toBeNull();
    expect(formatClock(425)).toBe('07:05');
    expect(formatClock(0)).toBe('00:00');
  });
});

describe("a listing's refresh", () => {
  const fact: RefreshFact = {
    listingId: 'listing-1',
    itemId: 'item-1',
    marketplace: 'poshmark',
    connection: { id: 'connection-1', mode: 'automation', status: 'connected', readOnly: false },
    testMode: false,
    freshAt: ago(24 * HOUR),
    lastRefreshedAt: ago(24 * HOUR),
    itemCadence: null,
    busy: false,
  };
  const account = { cadence: 'every_72_hours', customHours: null } as const;

  it('is scheduled under a session Listora can use, with its next and last', () => {
    expect(listingRefresh(fact, account, null, NOW)).toEqual({
      state: 'scheduled',
      nextAt: new Date(NOW.getTime() + 48 * HOUR),
      lastAt: ago(24 * HOUR),
    });
  });

  it('is off when its item or the account turned it off', () => {
    const off = { cadence: 'off', customHours: null } as const;
    expect(listingRefresh({ ...fact, itemCadence: off }, account, null, NOW).state).toBe('off');
    expect(listingRefresh(fact, off, null, NOW).state).toBe('off');
    // An item's own cadence turns it back on for that item.
    const daily = { cadence: 'daily', customHours: null } as const;
    expect(listingRefresh({ ...fact, itemCadence: daily }, off, null, NOW)).toMatchObject({
      state: 'scheduled',
      nextAt: NOW,
    });
  });

  it('is unavailable everywhere until a refresh passes live (verified-features.md)', () => {
    useMarketplaceFeatures('verified');
    try {
      expect(canRefresh(fact)).toBe(false);
      expect(listingRefresh(fact, account, null, NOW).state).toBe('unavailable');
    } finally {
      useMarketplaceFeatures('all');
    }
  });

  it('is unavailable on eBay, without a session, or with one waiting to be relinked', () => {
    expect(canRefresh(fact)).toBe(true);
    expect(canRefresh({ ...fact, marketplace: 'ebay' })).toBe(false);
    expect(canRefresh({ ...fact, connection: null })).toBe(false);
    // A read-only connection (a real shop that must not change) is never refreshed.
    const readOnly = { id: 'c', mode: 'automation', status: 'connected', readOnly: true } as const;
    expect(canRefresh({ ...fact, connection: readOnly })).toBe(false);
    expect(
      canRefresh({
        ...fact,
        connection: { id: 'c', mode: 'assisted', status: 'connected', readOnly: false },
      }),
    ).toBe(false);
    expect(
      listingRefresh(
        {
          ...fact,
          connection: { id: 'c', mode: 'automation', status: 'reauth_required', readOnly: false },
        },
        account,
        null,
        NOW,
      ),
    ).toEqual({ state: 'unavailable', lastAt: ago(24 * HOUR) });
  });
});
