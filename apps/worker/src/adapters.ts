import type { AutomatedMarketplace } from '@listora/automation';
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
 * The marketplace adapters the worker and the browser runner run operations with
 * (docs/architecture.md section 4). Both build the same automated marketplaces, so both route
 * each automated operation to the same mode; the runner's automation adapters have a browser,
 * the worker's do not.
 *
 * - Poshmark, Mercari, and Depop are assisted (every step is a user task that only the user's
 *   confirmation finishes) until a seller links a browser session, when their automation
 *   adapter serves them (decision D1). The per-marketplace automation adapters are their own
 *   tasks; until each lands, `automation` has none for it, except the fake site's for all three
 *   in development and tests (FAKE_AUTOMATION_SITE_URL).
 * - Depop also switches to its API once a seller's connection does. Its API adapter is the
 *   Depop adapter with DEPOP_ENV set (`fake` for the fake Depop, or Depop's sandbox or
 *   production once Listora's partner access is granted); without DEPOP_ENV, the generic fake
 *   marketplace when FAKE_MARKETPLACE_URL is set (the operation engine's process tests).
 * - eBay goes through its adapter with EBAY_ENV set (`fake` for the fake eBay server, or the
 *   sandbox or production). Without EBAY_ENV, eBay listings use the generic fake marketplace
 *   when FAKE_MARKETPLACE_URL is set (the operation engine's process tests), and otherwise
 *   fail visibly with "Listora can't connect to eBay yet" (and a Retry action) rather than
 *   wait.
 *
 * The browser runner never runs API steps (they are never automated), so it builds no eBay or
 * Depop API adapter.
 */
export function createAdapters(
  config: Pick<WorkerConfig, 'fakeMarketplaceUrl' | 'ebay' | 'depop'>,
  options: {
    logger?: Logger;
    /** The automation adapters, by marketplace (`createAutomationAdapters`). */
    automation?: Partial<Record<AutomatedMarketplace, MarketplaceAdapter>>;
  } = {},
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
  const { logger, automation = {} } = options;
  const automated = (assisted: MarketplaceAdapter, marketplace: AutomatedMarketplace) => {
    const adapter = automation[marketplace];
    return adapter === undefined
      ? assisted
      : new ConnectionAwareAdapter({ assisted, automation: adapter });
  };
  // Depop never reuses an external SKU and has no titles, whichever mode serves it.
  const depopApi: MarketplaceAdapter | undefined =
    config.depop === undefined
      ? fake('depop', { externalSkuReusable: false, title: 'none' })[0]
      : createDepopAdapter(config.depop, logger === undefined ? {} : { logger });
  const depopAutomation = automation.depop;
  return createAdapterRegistry([
    ...(config.ebay === undefined ? fake('ebay') : [createEbayAdapter(config.ebay)]),
    new ConnectionAwareAdapter({
      assisted: createDepopAssistedAdapter(),
      ...(depopApi === undefined ? {} : { api: depopApi }),
      ...(depopAutomation === undefined ? {} : { automation: depopAutomation }),
    }),
    automated(createPoshmarkAdapter(), 'poshmark'),
    automated(createMercariAdapter(), 'mercari'),
  ]);
}
