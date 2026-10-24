import type { Marketplace } from '@listora/db';
import {
  ConnectionAwareAdapter,
  createAdapterRegistry,
  createDepopAssistedAdapter,
  createMercariAdapter,
  createPoshmarkAdapter,
  FakeMarketplaceAdapter,
  type AdapterRegistry,
} from '@listora/marketplaces';

import type { WorkerConfig } from './config.ts';

/**
 * The marketplace adapters this worker runs operations with (docs/architecture.md section 4).
 *
 * - Poshmark and Mercari are assisted until the browser runner lands (decision D1): every step
 *   is a user task, and only the user's confirmation finishes it. They need no credential.
 * - Depop is assisted until a seller's connection switches to the API; its API adapter (T-24)
 *   is the fake marketplace for now, when FAKE_MARKETPLACE_URL is set.
 * - eBay has only the fake marketplace until its adapter lands (T-15); without
 *   FAKE_MARKETPLACE_URL its operations fail visibly with "Listora can't connect to eBay yet"
 *   (and a Retry action) rather than wait.
 */
export function createAdapters(config: Pick<WorkerConfig, 'fakeMarketplaceUrl'>): AdapterRegistry {
  const baseUrl = config.fakeMarketplaceUrl;
  const fake = (marketplace: Marketplace): FakeMarketplaceAdapter[] =>
    baseUrl === undefined ? [] : [new FakeMarketplaceAdapter({ marketplace, baseUrl })];
  const [depopApi] = fake('depop');
  return createAdapterRegistry([
    ...fake('ebay'),
    new ConnectionAwareAdapter({
      assisted: createDepopAssistedAdapter(),
      ...(depopApi === undefined ? {} : { api: depopApi }),
    }),
    createPoshmarkAdapter(),
    createMercariAdapter(),
  ]);
}
