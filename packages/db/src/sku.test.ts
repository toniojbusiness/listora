import { describe, expect, it } from 'vitest';

import { parseSafeInteger } from './database.ts';
import { formatSku, MAX_SKU_NUMBER } from './sku.ts';

describe('formatSku', () => {
  it('formats the prefix and a zero-padded 6-digit counter (decision D12)', () => {
    expect(formatSku('AJ', 184)).toBe('AJ-000184');
    expect(formatSku('ABCD', 1)).toBe('ABCD-000001');
    expect(formatSku('XYZ', MAX_SKU_NUMBER)).toBe('XYZ-999999');
  });

  it.each([0, -1, 1.5, MAX_SKU_NUMBER + 1, Number.NaN])('rejects the number %s', (number) => {
    expect(() => formatSku('AJ', number)).toThrow(RangeError);
  });

  it.each(['A', 'ABCDE', 'aj', 'A1', ''])('rejects the prefix %j', (prefix) => {
    expect(() => formatSku(prefix, 1)).toThrow(RangeError);
  });
});

describe('parseSafeInteger', () => {
  it('parses bigint text within the safe range', () => {
    expect(parseSafeInteger('0')).toBe(0);
    expect(parseSafeInteger('-42')).toBe(-42);
    expect(parseSafeInteger(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('throws instead of losing precision', () => {
    expect(() => parseSafeInteger('9007199254740993')).toThrow(RangeError);
  });
});
