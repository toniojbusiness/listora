/**
 * The automation adapters a process serves, per marketplace (decision D1). Poshmark and Mercari
 * have their own adapters (poshmark/, mercari/), which drive poshmark.com and mercari.com, or
 * their fakes with `FAKE_POSHMARK_URL` and `FAKE_MERCARI_SITE_URL`. The adapter for Depop is its
 * own task; until it lands, Depop has no automation adapter and stays assisted. In development
 * and tests, `FAKE_AUTOMATION_SITE_URL` serves Depop, and Poshmark or Mercari without its own
 * fake, through the fake site's adapter, so a development setup never drives a real marketplace.
 *
 * The worker and the browser runner build the same adapters (with and without a browser), so
 * both route every operation to the same mode.
 */
import type { MarketplaceAdapter } from '@listora/marketplaces';
import type { Logger } from '@listora/shared';

import type { PhotoSource } from './adapter/photos.ts';
import type { AutomationSessions } from './adapter/sessions.ts';
import { createFakeSiteAdapter } from './fake-site/fake-site-adapter.ts';
import { createPoshmarkAutomationAdapter } from './poshmark/adapter.ts';
import { createMercariAutomationAdapter } from './mercari/adapter.ts';
import { AUTOMATED_MARKETPLACES, type AutomatedMarketplace } from './profiles.ts';
import type { AutomationSettings } from './settings.ts';

export interface AutomationAdapterDependencies {
  settings: AutomationSettings;
  sessions: AutomationSessions;
  photos: PhotoSource;
  logger: Logger;
}

export function createAutomationAdapters(
  deps: AutomationAdapterDependencies,
): Partial<Record<AutomatedMarketplace, MarketplaceAdapter>> {
  const { settings } = deps;
  const siteUrl = settings.fakeSiteUrl;
  const fakeSite = (marketplace: AutomatedMarketplace): MarketplaceAdapter[] =>
    siteUrl === undefined
      ? []
      : [
          createFakeSiteAdapter({
            marketplace,
            siteUrl,
            profile: settings.profiles[marketplace],
            sessions: deps.sessions,
            photos: deps.photos,
            logger: deps.logger,
          }),
        ];
  const adapters: Partial<Record<AutomatedMarketplace, MarketplaceAdapter>> = Object.fromEntries(
    AUTOMATED_MARKETPLACES.flatMap((marketplace) =>
      fakeSite(marketplace).map((adapter) => [marketplace, adapter]),
    ),
  );
  if (settings.fakePoshmarkUrl !== undefined || siteUrl === undefined) {
    // The profile already points at the fake Poshmark when one is set (settings.ts).
    adapters.poshmark = createPoshmarkAutomationAdapter({
      profile: settings.profiles.poshmark,
      sessions: deps.sessions,
      photos: deps.photos,
      logger: deps.logger,
    });
  }
  if (settings.fakeMercariSiteUrl !== undefined || siteUrl === undefined) {
    adapters.mercari = createMercariAutomationAdapter({
      profile: settings.profiles.mercari,
      sessions: deps.sessions,
      photos: deps.photos,
      logger: deps.logger,
      ...(settings.fakeMercariSiteUrl === undefined
        ? {}
        : { siteUrl: settings.fakeMercariSiteUrl }),
    });
  }
  return adapters;
}
