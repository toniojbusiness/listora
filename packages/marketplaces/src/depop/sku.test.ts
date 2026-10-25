import { describe, expect, it } from 'vitest';

import { depopProductPath, depopProductRef, depopSku, nextDepopSku } from './sku.ts';

describe('Depop SKUs', () => {
  it("names a listing by the item's SKU and its generation", () => {
    expect(depopSku('AJ-000184', 1)).toBe('AJ-000184-D1');
    expect(depopSku('AJ-000184', 12)).toBe('AJ-000184-D12');
    expect(() => depopSku('AJ-000184', 0)).toThrow(RangeError);
    expect(() => depopSku('X'.repeat(48), 1)).toThrow('at most 50 characters');
  });

  it('never gives an item a SKU it had before, and ignores other items and slugs', () => {
    expect(nextDepopSku('AJ-000184', [])).toBe('AJ-000184-D1');
    expect(
      nextDepopSku('AJ-000184', [
        'AJ-000184-D1',
        'AJ-000184-D3',
        'AJ-000185-D9',
        'levis-trucker-jacket-7000001',
        'AJ-000184-D02',
      ]),
    ).toBe('AJ-000184-D4');
  });

  it('addresses Listora SKUs by SKU and linked listings by slug', () => {
    expect(depopProductRef('AJ-000184-D2')).toEqual({ by: 'sku', value: 'AJ-000184-D2' });
    expect(depopProductRef('levis-trucker-7000001')).toEqual({
      by: 'slug',
      value: 'levis-trucker-7000001',
    });
    expect(depopProductPath({ by: 'sku', value: 'AJ-000184-D2' }, 'mark-as-sold/')).toBe(
      '/api/v1/products/by-sku/AJ-000184-D2/mark-as-sold/',
    );
    expect(depopProductPath({ by: 'sku', value: 'A/B C' })).toBe(
      '/api/v1/products/by-sku/A%2FB%20C/',
    );
  });
});
