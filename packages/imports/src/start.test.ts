/**
 * Where Listora imports from (docs/features/imports.md): only marketplaces whose reads carry each
 * listing's photos and details, and of those only the ones whose imports passed live, except in
 * the owner's Test mode. Vinted's import is built (Vinted plan M4) and hidden until its live
 * import on the captain's test account.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { SELLER_FEATURES, useMarketplaceFeatures } from '@listora/marketplaces';

import { importableMarketplaces, importsFrom } from './start.ts';

describe('importsFrom', () => {
  afterEach(() => {
    useMarketplaceFeatures('all');
  });

  it('keeps Vinted hidden from a seller until its import passes live', () => {
    useMarketplaceFeatures('verified');
    expect(importsFrom('vinted', SELLER_FEATURES)).toBe(false);
    expect(importableMarketplaces(SELLER_FEATURES)).not.toContain('vinted');
  });

  it("offers Vinted in the owner's Test mode, where its live import runs", () => {
    useMarketplaceFeatures('verified');
    expect(importsFrom('vinted', { testMode: true })).toBe(true);
    expect(importableMarketplaces({ testMode: true })).toEqual([
      'depop',
      'poshmark',
      'mercari',
      'vinted',
    ]);
  });

  it('never imports from eBay, whose rows carry no photos or details', () => {
    expect(importsFrom('ebay', { testMode: true })).toBe(false);
  });
});
