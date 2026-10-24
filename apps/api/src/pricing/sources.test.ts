import { knownSoldDataSourceValues } from '@listora/api-contract';
import { PRICING_SOURCES } from '@listora/db';
import { PRICING_SNAPSHOT_SOURCES, REAL_SOLD_DATA_SOURCES } from '@listora/pricing';
import { describe, expect, it } from 'vitest';

// The pricing rules, the database CHECK, and the contract name the same sources.
describe('pricing sources', () => {
  it('match the database values and the contract', () => {
    expect([...PRICING_SNAPSHOT_SOURCES].sort()).toEqual([...PRICING_SOURCES].sort());
    expect(REAL_SOLD_DATA_SOURCES).toEqual(knownSoldDataSourceValues);
  });
});
