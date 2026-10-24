import { describe, expect, it } from 'vitest';

import {
  describePeriod,
  formatCount,
  formatQuantity,
  formatFields,
  formatMicros,
  formatShare,
  formatTable,
} from './format.ts';

describe('formatMicros', () => {
  it.each([
    [0, '$0.000000'],
    [1, '$0.000001'],
    [1_430, '$0.001430'],
    [1_000_000, '$1.000000'],
    [1_234_567_890, '$1,234.567890'],
    [-2_500, '-$0.002500'],
  ])('formats %d micro-dollars as %s', (micros, text) => {
    expect(formatMicros(micros)).toBe(text);
  });
});

describe('formatting helpers', () => {
  it('formats counts, shares, and periods', () => {
    expect(formatCount(12_345)).toBe('12,345');
    expect(formatQuantity(1, 'call')).toBe('1 call');
    expect(formatQuantity(0, 'call')).toBe('0 calls');
    expect(formatQuantity(1_200, 'blocked account')).toBe('1,200 blocked accounts');
    expect(formatShare(1, 3)).toBe('33.3%');
    expect(formatShare(0, 0)).toBe('-');
    expect(describePeriod({ kind: 'day', day: '2026-10-24' })).toBe('2026-10-24 (UTC day)');
    expect(describePeriod({ kind: 'month', month: '2026-10' })).toBe('2026-10 (UTC month)');
  });

  it('pads table columns, aligns number columns (and their headers) right, and leaves no trailing spaces', () => {
    expect(
      formatTable(
        ['Name', 'Cost', 'Note'],
        [
          ['Alpha', '$1.000000', ''],
          ['Bo', '$10.000000', 'big'],
        ],
        [1],
      ),
    ).toBe(['Name         Cost  Note', 'Alpha   $1.000000', 'Bo     $10.000000  big'].join('\n'));
  });

  it('lines up label/value fields', () => {
    expect(
      formatFields([
        ['cost', '$1.000000'],
        ['web searches', '0'],
      ]),
    ).toBe('cost          $1.000000\nweb searches  0');
  });
});
