/**
 * The automation adapters a process serves, per marketplace (decision D1). The per-marketplace
 * adapters for Poshmark, Mercari, and Depop are their own tasks; until each lands, its
 * marketplace has no automation adapter and stays assisted. In development and tests,
 * `FAKE_AUTOMATION_SITE_URL` serves all three through the fake site's adapter.
 *
 * The worker and the browser runner build the same adapters (with and without a browser), so
 * both route every operation to the same mode.
 */
import type { Logger } from '@listora/shared';

import type { AutomationAdapter } from './adapter/automation-adapter.ts';
import type { PhotoSource } from './adapter/photos.ts';
import type { AutomationSessions } from './adapter/sessions.ts';
import { createFakeSiteAdapter } from './fake-site/fake-site-adapter.ts';
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
): Partial<Record<AutomatedMarketplace, AutomationAdapter>> {
  const siteUrl = deps.settings.fakeSiteUrl;
  if (siteUrl === undefined) return {};
  return Object.fromEntries(
    AUTOMATED_MARKETPLACES.map((marketplace) => [
      marketplace,
      createFakeSiteAdapter({
        marketplace,
        siteUrl,
        profile: deps.settings.profiles[marketplace],
        sessions: deps.sessions,
        photos: deps.photos,
        logger: deps.logger,
      }),
    ]),
  );
}
