/**
 * The automation adapters a process serves, per marketplace (decision D1). Mercari has its own
 * (mercari/); the adapters for Poshmark and Depop are their own tasks, and until each lands its
 * marketplace has no automation adapter and stays assisted. In development and tests,
 * `FAKE_AUTOMATION_SITE_URL` serves all three through the fake site's adapter, and
 * `FAKE_MERCARI_SITE_URL` serves Mercari through its own adapter on the fake Mercari site.
 *
 * The worker and the browser runner build the same adapters (with and without a browser), so
 * both route every operation to the same mode.
 */
import type { MarketplaceAdapter } from '@listora/marketplaces';
import type { Logger } from '@listora/shared';

import type { PhotoSource } from './adapter/photos.ts';
import type { AutomationSessions } from './adapter/sessions.ts';
import { createFakeSiteAdapter } from './fake-site/fake-site-adapter.ts';
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
  const adapters: Partial<Record<AutomatedMarketplace, MarketplaceAdapter>> =
    siteUrl === undefined
      ? {}
      : Object.fromEntries(
          AUTOMATED_MARKETPLACES.map((marketplace) => [
            marketplace,
            createFakeSiteAdapter({
              marketplace,
              siteUrl,
              profile: settings.profiles[marketplace],
              sessions: deps.sessions,
              photos: deps.photos,
              logger: deps.logger,
            }),
          ]),
        );
  // Mercari itself, unless a fake site stands in: the fake Mercari site with the same scripts,
  // or the generic fake site (above).
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
