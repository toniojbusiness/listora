import { describe, expect, it } from 'vitest';

import { parseUtcDay, usagePeriodRange } from './reports.ts';

describe('usagePeriodRange', () => {
  it('covers one UTC day, across month and year ends', () => {
    expect(usagePeriodRange({ kind: 'day', day: '2026-10-24' })).toEqual({
      start: '2026-10-24',
      end: '2026-10-25',
    });
    expect(usagePeriodRange({ kind: 'day', day: '2026-12-31' })).toEqual({
      start: '2026-12-31',
      end: '2027-01-01',
    });
    expect(usagePeriodRange({ kind: 'day', day: '2028-02-29' })).toEqual({
      start: '2028-02-29',
      end: '2028-03-01',
    });
  });

  it('covers one UTC calendar month', () => {
    expect(usagePeriodRange({ kind: 'month', month: '2026-12' })).toEqual({
      start: '2026-12-01',
      end: '2027-01-01',
    });
  });

  it.each(['2026-02-30', '2027-02-29', '2026-13-01', '2026-1-01', '20261024', 'today', ''])(
    'rejects the day %j',
    (day) => {
      expect(() => parseUtcDay(day)).toThrow(RangeError);
      expect(() => usagePeriodRange({ kind: 'day', day })).toThrow(RangeError);
    },
  );

  it('rejects a month that is not YYYY-MM', () => {
    expect(() => usagePeriodRange({ kind: 'month', month: '2026-13' })).toThrow(RangeError);
  });
});
