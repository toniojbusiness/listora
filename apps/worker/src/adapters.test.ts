import { describe, expect, it } from 'vitest';

import { MARKETPLACES } from '@listora/db';
import { FakeMarketplaceAdapter } from '@listora/marketplaces';

import { createAdapters } from './adapters.ts';

describe('createAdapters', () => {
  it('has no adapter for any marketplace without FAKE_MARKETPLACE_URL', () => {
    const adapters = createAdapters({ fakeMarketplaceUrl: undefined });
    for (const marketplace of MARKETPLACES) expect(adapters(marketplace)).toBeUndefined();
  });

  it('routes every marketplace to the fake marketplace when it is configured', () => {
    const adapters = createAdapters({ fakeMarketplaceUrl: 'http://127.0.0.1:4100' });
    for (const marketplace of MARKETPLACES) {
      const adapter = adapters(marketplace);
      expect(adapter).toBeInstanceOf(FakeMarketplaceAdapter);
      expect(adapter?.id).toBe(marketplace);
      expect(adapter?.capabilities().verifyRead).toBe('api');
    }
  });
});
