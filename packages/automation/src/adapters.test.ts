import { describe, expect, it } from 'vitest';

import { createMarketplaceAdapters, loadDepopConfig, loadEbayConfig } from '@listora/marketplaces';
import { createLogger } from '@listora/shared';

import { HttpPhotoSource } from './adapter/photos.ts';
import { NoBrowserSessions } from './adapter/sessions.ts';
import { createAutomationAdapters } from './adapters.ts';
import { loadAutomationSettings } from './settings.ts';

const api = { id: 'connection-1', mode: 'api', status: 'connected' } as const;
const automated = { id: 'connection-2', mode: 'automation', status: 'connected' } as const;

describe('createAutomationAdapters in the marketplace adapters', () => {
  it('automates Poshmark, Mercari, Depop, and eBay for linked sessions when they have an automation adapter', () => {
    const settings = loadAutomationSettings({ FAKE_AUTOMATION_SITE_URL: 'http://127.0.0.1:4400' });
    const automation = createAutomationAdapters({
      settings,
      sessions: NoBrowserSessions,
      photos: new HttpPhotoSource(),
      logger: createLogger({ service: 'test', level: 'silent' }),
    });
    const adapters = createMarketplaceAdapters({
      fakeMarketplaceUrl: 'http://127.0.0.1:4100',
      ebay: undefined,
      depop: undefined,
      automation,
    });
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
    // eBay too; a listing without a connection still goes to the eBay API's stand-in.
    expect(adapters.capabilities('ebay', automated)).toMatchObject({
      connect: 'session',
      create: 'automation',
      verifyRead: 'automation',
    });
    expect(adapters.capabilities('ebay', null)?.verifyRead).toBe('api');
    expect(adapters.capabilities('ebay', api)?.verifyRead).toBe('api');
  });

  it('automates Poshmark on poshmark.com in production, and never a real site in development', () => {
    const logger = createLogger({ service: 'test', level: 'silent' });
    const build = (env: NodeJS.ProcessEnv) =>
      createMarketplaceAdapters({
        fakeMarketplaceUrl: undefined,
        ebay: undefined,
        depop: undefined,
        automation: createAutomationAdapters({
          settings: loadAutomationSettings(env),
          sessions: NoBrowserSessions,
          photos: new HttpPhotoSource(),
          logger,
        }),
      });
    // Production: each marketplace's own adapter.
    const production = build({});
    expect(production.capabilities('poshmark', automated)).toMatchObject({
      create: 'automation',
      delist: 'automation',
      relist: 'automation',
      markSold: 'not_needed',
      verifyRead: 'automation',
      readFreshness: 'revision',
      saleDetection: ['poll', 'email', 'manual'],
    });
    expect(production.capabilities('poshmark', null)?.create).toBe('assisted');
    expect(production.capabilities('mercari', automated)).toMatchObject({
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
    expect(production.capabilities('mercari', null)?.create).toBe('assisted');
    expect(production.capabilities('depop', automated)).toMatchObject({
      connect: 'session',
      create: 'automation',
      updatePrice: 'automation',
      updateDetails: 'automation',
      delist: 'automation',
      relist: 'automation',
      verifyRead: 'automation',
      readFreshness: 'revision',
      title: 'none',
      externalSkuReusable: false,
      saleDetection: ['poll', 'email', 'manual'],
    });
    expect(production.capabilities('depop', null)?.create).toBe('assisted');
    // The fake Poshmark serves the same adapter in development.
    const development = build({ FAKE_POSHMARK_URL: 'http://127.0.0.1:4500' });
    expect(development.capabilities('poshmark', automated)?.readFreshness).toBe('revision');
    // And the fake Mercari site serves Mercari's, and the fake Depop site Depop's.
    const mercari = build({ FAKE_MERCARI_SITE_URL: 'http://127.0.0.1:4600' });
    expect(mercari.capabilities('mercari', automated)?.readFreshness).toBe('revision');
    const depop = build({ FAKE_DEPOP_SITE_URL: 'http://127.0.0.1:4700' });
    expect(depop.capabilities('depop', automated)?.readFreshness).toBe('revision');
    // And the fake eBay site eBay's.
    const ebay = build({ FAKE_EBAY_SITE_URL: 'http://127.0.0.1:4800' });
    expect(ebay.capabilities('ebay', automated)?.readFreshness).toBe('revision');
  });

  it('automates eBay on ebay.com for a linked session until its API is connected', () => {
    const production = createMarketplaceAdapters({
      fakeMarketplaceUrl: undefined,
      ebay: undefined,
      depop: undefined,
      automation: createAutomationAdapters({
        settings: loadAutomationSettings({}),
        sessions: NoBrowserSessions,
        photos: new HttpPhotoSource(),
        logger: createLogger({ service: 'test', level: 'silent' }),
      }),
    });
    expect(production.capabilities('ebay', automated)).toMatchObject({
      connect: 'session',
      create: 'automation',
      updatePrice: 'automation',
      updateDetails: 'automation',
      delist: 'automation',
      relist: 'automation',
      // eBay marks its own sales sold.
      markSold: 'not_needed',
      verifyRead: 'automation',
      readFreshness: 'revision',
      title: 'field',
      externalSkuReusable: true,
      saleDetection: ['poll', 'email', 'manual'],
    });
    // Without the eBay API's keys, eBay is assisted until the seller links a session, and
    // whenever automation has to stop.
    expect(production.capabilities('ebay', null)?.create).toBe('assisted');
    expect(
      production.capabilities('ebay', { ...automated, status: 'reauth_required' })?.create,
    ).toBe('assisted');
  });

  it("serves a seller's eBay API connection through the API, ahead of automation", () => {
    const adapters = createMarketplaceAdapters({
      fakeMarketplaceUrl: undefined,
      ebay: loadEbayConfig({ EBAY_ENV: 'fake' }),
      depop: undefined,
      automation: createAutomationAdapters({
        settings: loadAutomationSettings({}),
        sessions: NoBrowserSessions,
        photos: new HttpPhotoSource(),
        logger: createLogger({ service: 'test', level: 'silent' }),
      }),
    });
    // The API adapter, never the browser, for a connection that uses eBay's API.
    expect(adapters.capabilities('ebay', api)).toMatchObject({
      connect: 'oauth',
      create: 'api',
      delist: 'api',
      verifyRead: 'api',
    });
    // An eBay API connection that needs reconnecting is never automated either.
    expect(adapters.capabilities('ebay', { ...api, status: 'reauth_required' })?.create).toBe(
      'api',
    );
    // A listing without a connection is asked to connect eBay, as before automation.
    expect(adapters.capabilities('ebay', null)?.create).toBe('api');
    // Automation serves only connections that are browser sessions.
    expect(adapters.capabilities('ebay', automated)).toMatchObject({
      connect: 'session',
      create: 'automation',
    });
  });

  it("serves a seller's Depop API connection through the API, ahead of automation", () => {
    const adapters = createMarketplaceAdapters({
      fakeMarketplaceUrl: undefined,
      ebay: undefined,
      depop: loadDepopConfig({ DEPOP_ENV: 'fake' }),
      automation: createAutomationAdapters({
        settings: loadAutomationSettings({}),
        sessions: NoBrowserSessions,
        photos: new HttpPhotoSource(),
        logger: createLogger({ service: 'test', level: 'silent' }),
      }),
    });
    // The API adapter, never the browser, for a connection that uses Depop's API.
    expect(adapters.capabilities('depop', api)).toMatchObject({
      connect: 'oauth',
      create: 'api',
      delist: 'api',
      markSold: 'api',
      verifyRead: 'api',
    });
    // A Depop API connection that needs reconnecting is never automated either.
    expect(adapters.capabilities('depop', { ...api, status: 'reauth_required' })?.create).toBe(
      'api',
    );
    // Automation serves only connections that are browser sessions.
    expect(adapters.capabilities('depop', automated)).toMatchObject({
      connect: 'session',
      create: 'automation',
    });
    expect(adapters.capabilities('depop', null)?.create).toBe('assisted');
  });
});
