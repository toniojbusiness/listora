import type { Marketplace } from '@listora/db';
import {
  ConnectionAwareAdapter,
  createAdapterRegistry,
  createDepopAdapter,
  createDepopAssistedAdapter,
  createEbayAdapter,
  createMercariAdapter,
  createPoshmarkAdapter,
  FakeMarketplaceAdapter,
  type AdapterRegistry,
  type FakeCapabilityOverrides,
  type MarketplaceAdapter,
} from '@listora/marketplaces';
import type { Logger } from '@listora/shared';

import type { WorkerConfig } from './config.ts';

/**
 * The marketplace adapters this worker runs operations with (docs/architecture.md section 4).
 *
 * - Poshmark and Mercari are assisted until the browser runner lands (decision D1): every step
 *   is a user task, and only the user's confirmation finishes it. They need no credential.
 * - Depop is assisted until a seller's connection switches to the API. Its API adapter is the
 *   Depop adapter with DEPOP_ENV set (`fake` for the fake Depop, or Depop's sandbox or
 *   production once Listora's partner access is granted); without DEPOP_ENV, the generic fake
 *   marketplace when FAKE_MARKETPLACE_URL is set (the operation engine's process tests).
 * - eBay goes through its adapter with EBAY_ENV set (`fake` for the fake eBay server, or the
 *   sandbox or production). Without EBAY_ENV, eBay listings use the generic fake marketplace
 *   when FAKE_MARKETPLACE_URL is set (the operation engine's process tests), and otherwise
 *   fail visibly with "Listora can't connect to eBay yet" (and a Retry action) rather than
 *   wait.
 */
export function createAdapters(
  config: Pick<WorkerConfig, 'fakeMarketplaceUrl' | 'ebay' | 'depop'>,
  logger?: Logger,
): AdapterRegistry {
  const baseUrl = config.fakeMarketplaceUrl;
  const fake = (
    marketplace: Marketplace,
    capabilities?: FakeCapabilityOverrides,
  ): FakeMarketplaceAdapter[] =>
    baseUrl === undefined
      ? []
      : [
          new FakeMarketplaceAdapter({
            marketplace,
            baseUrl,
            ...(capabilities === undefined ? {} : { capabilities }),
          }),
        ];
  // Depop never reuses an external SKU and has no titles, whichever mode serves it.
  const depopApi: MarketplaceAdapter | undefined =
    config.depop === undefined
      ? fake('depop', { externalSkuReusable: false, title: 'none' })[0]
      : createDepopAdapter(config.depop, logger === undefined ? {} : { logger });
  return createAdapterRegistry([
    ...(config.ebay === undefined ? fake('ebay') : [createEbayAdapter(config.ebay)]),
    new ConnectionAwareAdapter({
      assisted: createDepopAssistedAdapter(),
      ...(depopApi === undefined ? {} : { api: depopApi }),
    }),
    createPoshmarkAdapter(),
    createMercariAdapter(),
  ]);
}
