import { describe, expect, it } from 'vitest';

import { AssistedAdapter } from './assisted/assisted-adapter.ts';
import { ConnectionAwareAdapter } from './connection-aware.ts';
import { createMarketplaceAdapters } from './default-adapters.ts';
import { DepopAdapter } from './depop/adapter.ts';
import { loadDepopConfig } from './depop/config.ts';
import { EbayAdapter } from './ebay/adapter.ts';
import { loadEbayConfig } from './ebay/config.ts';
import { FakeMarketplaceAdapter } from './fake/fake-adapter.ts';

const api = { id: 'connection-1', mode: 'api', status: 'connected' } as const;
const automated = { id: 'connection-2', mode: 'automation', status: 'connected' } as const;

describe('createMarketplaceAdapters', () => {
  it('serves every marketplace assisted, eBay included, without FAKE_MARKETPLACE_URL', () => {
    const adapters = createMarketplaceAdapters({
      fakeMarketplaceUrl: undefined,
      ebay: undefined,
      depop: undefined,
    });
    expect(adapters.marketplaces).toEqual(['ebay', 'depop', 'poshmark', 'mercari']);
    // Without the eBay API's keys and without a linked session, the user lists on eBay.
    for (const connection of [null, api, automated]) {
      expect(adapters.capabilities('ebay', connection)).toMatchObject({
        create: 'assisted',
        markSold: 'not_needed',
        verifyRead: 'user_confirm',
      });
    }
    expect(adapters.get('poshmark')).toBeInstanceOf(AssistedAdapter);
    expect(adapters.get('mercari')).toBeInstanceOf(AssistedAdapter);
    // Depop stays assisted even under an api connection while it has no api adapter.
    expect(adapters.capabilities('depop', api)?.verifyRead).toBe('user_confirm');
  });

  it('routes eBay and api-connected Depop listings to the fake marketplace when configured', () => {
    const adapters = createMarketplaceAdapters({
      fakeMarketplaceUrl: 'http://127.0.0.1:4100',
      ebay: undefined,
      depop: undefined,
    });
    expect(adapters.marketplaces).toEqual(['ebay', 'depop', 'poshmark', 'mercari']);
    const ebay = adapters.get('ebay');
    if (!(ebay instanceof ConnectionAwareAdapter)) throw new Error('connection-aware');
    expect(ebay.adapterFor(null)).toBeInstanceOf(FakeMarketplaceAdapter);
    expect(ebay.adapterFor(api)).toBeInstanceOf(FakeMarketplaceAdapter);
    const depop = adapters.get('depop');
    expect(depop).toBeInstanceOf(ConnectionAwareAdapter);
    expect(depop?.capabilities(null).verifyRead).toBe('user_confirm');
    expect(depop?.capabilities(api).verifyRead).toBe('api');
    // The flags describe Depop itself in either mode.
    expect(depop?.capabilities(null).externalSkuReusable).toBe(false);
    expect(depop?.capabilities(api).externalSkuReusable).toBe(false);
    expect(adapters.capabilities('ebay', api)?.externalSkuReusable).toBe(true);
    // Poshmark and Mercari have no api; they stay assisted without an automation adapter.
    for (const marketplace of ['poshmark', 'mercari'] as const) {
      expect(adapters.capabilities(marketplace, api)).toMatchObject({
        create: 'assisted',
        verifyRead: 'user_confirm',
      });
      expect(adapters.capabilities(marketplace, automated)).toMatchObject({
        create: 'assisted',
        verifyRead: 'user_confirm',
      });
    }
  });

  it('routes eBay to the eBay adapter when EBAY_ENV is set, whatever FAKE_MARKETPLACE_URL says', () => {
    const ebay = loadEbayConfig({ EBAY_ENV: 'fake', EBAY_USER_CONNECTION_ID: api.id });
    for (const fakeMarketplaceUrl of [undefined, 'http://127.0.0.1:4100']) {
      const adapters = createMarketplaceAdapters({ fakeMarketplaceUrl, ebay, depop: undefined });
      const served = adapters.get('ebay');
      if (!(served instanceof ConnectionAwareAdapter)) throw new Error('connection-aware');
      expect(served.adapterFor(api)).toBeInstanceOf(EbayAdapter);
      // A listing without a connection is asked to connect eBay, as the API adapter does.
      expect(served.adapterFor(null)).toBeInstanceOf(EbayAdapter);
      // An automation connection without an automation adapter (the API's view) is assisted.
      expect(served.adapterFor(automated)).toBeInstanceOf(AssistedAdapter);
      expect(adapters.capabilities('ebay', api)).toMatchObject({
        verifyRead: 'api',
        readFreshness: 'none',
        markSold: 'not_needed',
        imageTransport: 'upload',
      });
    }
  });

  it('serves api-connected Depop listings through the Depop adapter when DEPOP_ENV is set', () => {
    const depop = loadDepopConfig({ DEPOP_ENV: 'fake', DEPOP_USER_CONNECTION_ID: api.id });
    for (const fakeMarketplaceUrl of [undefined, 'http://127.0.0.1:4100']) {
      const adapters = createMarketplaceAdapters({ fakeMarketplaceUrl, ebay: undefined, depop });
      const served = adapters.get('depop');
      expect(served).toBeInstanceOf(ConnectionAwareAdapter);
      if (!(served instanceof ConnectionAwareAdapter)) throw new Error('connection-aware');
      expect(served.adapterFor(api)).toBeInstanceOf(DepopAdapter);
      // Without an api connection Depop stays assisted: the adapter is dormant until then.
      expect(served.adapterFor(null)).toBeInstanceOf(AssistedAdapter);
      expect(adapters.capabilities('depop', api)).toMatchObject({
        verifyRead: 'api',
        readFreshness: 'none',
        title: 'none',
        markSold: 'api',
        externalSkuReusable: false,
      });
      expect(
        adapters.capabilities('depop', { id: api.id, mode: 'assisted', status: 'connected' })
          ?.verifyRead,
      ).toBe('user_confirm');
    }
  });
});
