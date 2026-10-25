import type { Marketplace } from '@listora/db';
import type { Logger } from '@listora/shared';

import type { MarketplaceAdapter } from './adapter.ts';
import {
  createDepopAssistedAdapter,
  createMercariAdapter,
  createPoshmarkAdapter,
} from './assisted/marketplaces.ts';
import { ConnectionAwareAdapter } from './connection-aware.ts';
import type { DepopConfig } from './depop/config.ts';
import { createDepopAdapter } from './depop/create.ts';
import type { EbayConfig } from './ebay/config.ts';
import { createEbayAdapter } from './ebay/create.ts';
import type { EbaySellerSource } from './ebay/oauth.ts';
import { FakeMarketplaceAdapter, type FakeCapabilityOverrides } from './fake/fake-adapter.ts';
import { createAdapterRegistry, type AdapterRegistry } from './registry.ts';

export interface MarketplaceAdaptersConfig {
  /** `FAKE_MARKETPLACE_URL`: the fake marketplace (development and tests only). */
  fakeMarketplaceUrl: string | undefined;
  /** `EBAY_*`: the eBay adapter's settings; undefined when eBay is not configured. */
  ebay: EbayConfig | undefined;
  /** `DEPOP_*`: the Depop adapter's settings; undefined when Depop runs assisted only. */
  depop: DepopConfig | undefined;
  /**
   * Whose eBay tokens the eBay adapter acts with: each connection's own, from the token vault
   * (`@listora/connections`, in the worker). Without one, the adapter serves only the single
   * seller `EBAY_USER_*` configures (development and sandbox), and every other connection is
   * asked to connect eBay.
   */
  ebaySeller?: EbaySellerSource;
}

/**
 * The marketplace adapters Listora runs with (docs/architecture.md section 4): the worker runs
 * operations with them, and the API reads each marketplace's capabilities from them, so both
 * processes always agree.
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
export function createMarketplaceAdapters(
  config: MarketplaceAdaptersConfig,
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
    ...(config.ebay === undefined
      ? fake('ebay')
      : [
          createEbayAdapter(
            config.ebay,
            config.ebaySeller === undefined ? {} : { seller: config.ebaySeller },
          ),
        ]),
    new ConnectionAwareAdapter({
      assisted: createDepopAssistedAdapter(),
      ...(depopApi === undefined ? {} : { api: depopApi }),
    }),
    createPoshmarkAdapter(),
    createMercariAdapter(),
  ]);
}
