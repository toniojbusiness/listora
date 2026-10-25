import { describe, expect, it } from 'vitest';

import { createMarketplaceAdapters } from '@listora/marketplaces';
import { createLogger } from '@listora/shared';

import { HttpPhotoSource } from './adapter/photos.ts';
import { NoBrowserSessions } from './adapter/sessions.ts';
import { createAutomationAdapters } from './adapters.ts';
import { loadAutomationSettings } from './settings.ts';

const api = { id: 'connection-1', mode: 'api', status: 'connected' } as const;
const automated = { id: 'connection-2', mode: 'automation', status: 'connected' } as const;

describe('createAutomationAdapters in the marketplace adapters', () => {
  it('automates Poshmark, Mercari, and Depop for linked sessions when they have an automation adapter', () => {
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
  });

  it('automates Mercari itself for linked sessions; Poshmark and Depop stay assisted until their adapters land', () => {
    const automation = createAutomationAdapters({
      settings: loadAutomationSettings({}),
      sessions: NoBrowserSessions,
      photos: new HttpPhotoSource(),
      logger: createLogger({ service: 'test', level: 'silent' }),
    });
    expect(Object.keys(automation)).toEqual(['mercari']);
    const adapters = createMarketplaceAdapters({
      fakeMarketplaceUrl: undefined,
      ebay: undefined,
      depop: undefined,
      automation,
    });
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
});
