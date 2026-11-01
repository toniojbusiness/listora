import { describe, expect, it } from 'vitest';

import { compareCodes, nextCode, normalizeCode, normalizeLabel } from './codes.ts';

describe('bin codes', () => {
  it('stores a typed code trimmed, with single spaces, in capitals', () => {
    expect(normalizeCode('  b-12 ')).toEqual({ ok: true, code: 'B-12' });
    expect(normalizeCode('shelf   3/a')).toEqual({ ok: true, code: 'SHELF 3/A' });
    expect(normalizeCode('Box 4.2')).toEqual({ ok: true, code: 'BOX 4.2' });
  });

  it('refuses a blank, too long, or odd code with words the seller can act on', () => {
    expect(normalizeCode('   ')).toEqual({ ok: false, message: 'must not be blank' });
    expect(normalizeCode('B'.repeat(33))).toEqual({
      ok: false,
      message: 'must be at most 32 characters',
    });
    expect(normalizeCode('B#12')).toMatchObject({ ok: false });
    expect(normalizeCode('B-12😀')).toMatchObject({ ok: false });
    expect(normalizeCode('--')).toMatchObject({ ok: false });
  });

  it('keeps a label trimmed, and none when blank', () => {
    expect(normalizeLabel('  Garage   shelf 3 ')).toBe('Garage shelf 3');
    expect(normalizeLabel('  ')).toBeNull();
    expect(normalizeLabel(undefined)).toBeNull();
  });

  it('offers B-1 first, then the number after the newest series highest', () => {
    expect(nextCode([])).toBe('B-1');
    expect(nextCode(['B-12', 'B-3'])).toBe('B-13');
    expect(nextCode(['B-3', 'B-12'])).toBe('B-13');
    expect(nextCode(['SHELF 2', 'B-40'])).toBe('SHELF 3');
    expect(nextCode(['B-009'])).toBe('B-010');
    expect(nextCode(['GARAGE'])).toBe('B-1');
    expect(nextCode(['GARAGE', 'B-1'])).toBe('B-2');
  });

  it('orders codes as people read them', () => {
    const codes = ['B-12', 'C-1', 'B-2', 'A', 'B-2A', 'B-1'];
    expect([...codes].sort(compareCodes)).toEqual(['A', 'B-1', 'B-2', 'B-2A', 'B-12', 'C-1']);
  });
});
