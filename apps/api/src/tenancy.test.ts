import { describe, expect, it } from 'vitest';

import { DEFAULT_SKU_PREFIX, skuPrefixFor } from './tenancy.ts';

describe('skuPrefixFor', () => {
  it.each([
    ['antonio.jenkins@example.com', 'AJ'],
    ['Maria_Lopez-Diaz@example.com', 'ML'],
    ['maria@example.com', 'MA'],
    ['j3ff@example.com', 'JF'],
    ['x@example.com', DEFAULT_SKU_PREFIX],
    ['12345@example.com', DEFAULT_SKU_PREFIX],
    [undefined, DEFAULT_SKU_PREFIX],
  ])('%s → %s', (email, prefix) => {
    expect(skuPrefixFor(email)).toBe(prefix);
  });
});
