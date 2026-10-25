import { describe, expect, it } from 'vitest';

import {
  AssistedAdapter,
  ConnectionAwareAdapter,
  EbayAdapter,
  FakeMarketplaceAdapter,
  loadEbayConfig,
} from '@listora/marketplaces';

import {
  createAutomationAdapters,
  HttpPhotoSource,
  loadAutomationSettings,
  NoBrowserSessions,
} from '@listora/automation';
import { createLogger } from '@listora/shared';

import { createAdapters } from './adapters.ts';

const api = { id: 'connection-1', mode: 'api', status: 'connected' } as const;
const automated = { id: 'connection-2', mode: 'automation', status: 'connected' } as const;

describe('createAdapters', () => {
  it('serves the assisted marketplaces, and no eBay, without FAKE_MARKETPLACE_URL', () => {
    const adapters = createAdapters({ fakeMarketplaceUrl: undefined, ebay: undefined });
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

  it('automates Poshmark, Mercari, and Depop for linked sessions when they have an automation adapter', () => {
    const settings = loadAutomationSettings({ FAKE_AUTOMATION_SITE_URL: 'http://127.0.0.1:4300' });
    const automation = createAutomationAdapters({
      settings,
      sessions: NoBrowserSessions,
      photos: new HttpPhotoSource(),
      logger: createLogger({ service: 'test', level: 'silent' }),
    });
    const adapters = createAdapters(
      { fakeMarketplaceUrl: 'http://127.0.0.1:4100', ebay: undefined },
      automation,
    );
    for (const marketplace of ['poshmark', 'mercari', 'depop'] as const) {
      expect(adapters.capabilities(marketplace, automated), marketplace).toMatchObject({
        connect: 'session',
        create: 'automation',
        delist: 'automation',
        verifyRead: 'automation',
      });
      // Assisted without a session, and while the session waits for a relink.
      expect(adapters.capabilities(marketplace, null)?.create).toBe('assisted');
      expect(
        adapters.capabilities(marketplace, { ...automated, status: 'reauth_required' })?.create,
      ).toBe('assisted');
    }
    expect(adapters.capabilities('depop', api)?.verifyRead).toBe('api');
  });

  it('automates Mercari itself for linked sessions; Poshmark and Depop stay assisted until their adapters land', () => {
    const automation = createAutomationAdapters({
      settings: loadAutomationSettings({}),
      sessions: NoBrowserSessions,
      photos: new HttpPhotoSource(),
      logger: createLogger({ service: 'test', level: 'silent' }),
    });
    const adapters = createAdapters({ fakeMarketplaceUrl: undefined, ebay: undefined }, automation);
    expect(adapters.capabilities('mercari', automated)).toMatchObject({
      connect: 'session',
      create: 'automation',
      updatePrice: 'automation',
      updateDetails: 'automation',
      delist: 'automation',
      relist: 'automation',
      markSold: 'not_needed',
      verifyRead: 'automation',
      readFreshness: 'revision',
      saleDetection: ['poll', 'email', 'manual'],
    });
    expect(adapters.capabilities('mercari', null)?.create).toBe('assisted');
    for (const marketplace of ['poshmark', 'depop'] as const) {
      expect(adapters.capabilities(marketplace, automated)?.create, marketplace).toBe('assisted');
    }
  });

  it('routes eBay to the eBay adapter when EBAY_ENV is set, whatever FAKE_MARKETPLACE_URL says', () => {
    const ebay = loadEbayConfig({ EBAY_ENV: 'fake', EBAY_USER_CONNECTION_ID: api.id });
    for (const fakeMarketplaceUrl of [undefined, 'http://127.0.0.1:4100']) {
      const adapters = createAdapters({ fakeMarketplaceUrl, ebay });
      expect(adapters.get('ebay')).toBeInstanceOf(EbayAdapter);
      expect(adapters.capabilities('ebay', api)).toMatchObject({
        verifyRead: 'api',
        readFreshness: 'none',
        markSold: 'not_needed',
        imageTransport: 'upload',
      });
    }
  });
});
