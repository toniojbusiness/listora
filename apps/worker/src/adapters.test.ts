import { describe, expect, it } from 'vitest';

import {
  AssistedAdapter,
  ConnectionAwareAdapter,
  DepopAdapter,
  EbayAdapter,
  FakeMarketplaceAdapter,
  loadDepopConfig,
  loadEbayConfig,
} from '@listora/marketplaces';

import { createAdapters } from './adapters.ts';

const api = { id: 'connection-1', mode: 'api' } as const;

describe('createAdapters', () => {
  it('serves the assisted marketplaces, and no eBay, without FAKE_MARKETPLACE_URL', () => {
    const adapters = createAdapters({
      fakeMarketplaceUrl: undefined,
      ebay: undefined,
      depop: undefined,
    });
    expect(adapters.marketplaces).toEqual(['depop', 'poshmark', 'mercari']);
    expect(adapters.get('ebay')).toBeUndefined();
    expect(adapters.get('poshmark')).toBeInstanceOf(AssistedAdapter);
    expect(adapters.get('mercari')).toBeInstanceOf(AssistedAdapter);
    // Depop stays assisted even under an api connection while it has no api adapter.
    expect(adapters.capabilities('depop', api)?.verifyRead).toBe('user_confirm');
  });

  it('routes eBay and api-connected Depop listings to the fake marketplace when configured', () => {
    const adapters = createAdapters({
      fakeMarketplaceUrl: 'http://127.0.0.1:4100',
      ebay: undefined,
      depop: undefined,
    });
    expect(adapters.marketplaces).toEqual(['ebay', 'depop', 'poshmark', 'mercari']);
    expect(adapters.get('ebay')).toBeInstanceOf(FakeMarketplaceAdapter);
    const depop = adapters.get('depop');
    expect(depop).toBeInstanceOf(ConnectionAwareAdapter);
    expect(depop?.capabilities(null).verifyRead).toBe('user_confirm');
    expect(depop?.capabilities(api).verifyRead).toBe('api');
    // The flags describe Depop itself in either mode.
    expect(depop?.capabilities(null).externalSkuReusable).toBe(false);
    expect(depop?.capabilities(api).externalSkuReusable).toBe(false);
    expect(adapters.capabilities('ebay', api)?.externalSkuReusable).toBe(true);
    // Poshmark and Mercari have no api; they stay assisted until the browser runner lands.
    for (const marketplace of ['poshmark', 'mercari'] as const) {
      expect(adapters.capabilities(marketplace, api)).toMatchObject({
        create: 'assisted',
        verifyRead: 'user_confirm',
      });
    }
  });

  it('routes eBay to the eBay adapter when EBAY_ENV is set, whatever FAKE_MARKETPLACE_URL says', () => {
    const ebay = loadEbayConfig({ EBAY_ENV: 'fake', EBAY_USER_CONNECTION_ID: api.id });
    for (const fakeMarketplaceUrl of [undefined, 'http://127.0.0.1:4100']) {
      const adapters = createAdapters({ fakeMarketplaceUrl, ebay, depop: undefined });
      expect(adapters.get('ebay')).toBeInstanceOf(EbayAdapter);
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
      const adapters = createAdapters({ fakeMarketplaceUrl, ebay: undefined, depop });
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
      expect(adapters.capabilities('depop', { id: api.id, mode: 'assisted' })?.verifyRead).toBe(
        'user_confirm',
      );
    }
  });
});
