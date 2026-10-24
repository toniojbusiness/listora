import { MARKETPLACES } from '@listora/db';
import { FakeMarketplaceAdapter, type AdapterLookup } from '@listora/marketplaces';

import type { WorkerConfig } from './config.ts';

/**
 * The marketplace adapters this worker runs operations with. Until the real adapters land
 * (eBay in T-15, Depop in T-24), only the fake marketplace exists: with FAKE_MARKETPLACE_URL
 * set, every marketplace uses it; without it there is no adapter, and operations fail visibly
 * with "Listora can't connect to <marketplace> yet" (and a Retry action) rather than wait.
 */
export function createAdapters(config: Pick<WorkerConfig, 'fakeMarketplaceUrl'>): AdapterLookup {
  const baseUrl = config.fakeMarketplaceUrl;
  if (baseUrl === undefined) return () => undefined;
  const adapters = new Map(
    MARKETPLACES.map((marketplace) => [
      marketplace,
      new FakeMarketplaceAdapter({ marketplace, baseUrl }),
    ]),
  );
  return (marketplace) => adapters.get(marketplace);
}
