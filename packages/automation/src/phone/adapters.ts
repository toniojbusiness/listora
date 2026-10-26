/**
 * The adapters the server runs phone work with (work.ts): the worker's adapters, with its
 * automation adapters built over the phone's transcript instead of a browser. They describe
 * the same calls the runner's would, and never run a script on the server (the sessions answer
 * from the phone), so their photos are never fetched here.
 */
import { createMarketplaceAdapters, type MarketplaceAdaptersConfig } from '@listora/marketplaces';
import type { Logger } from '@listora/shared';

import type { PhotoSource } from '../adapter/photos.ts';
import { createAutomationAdapters } from '../adapters.ts';
import type { AutomationSettings } from '../settings.ts';
import type { PhoneWorkDependencies } from './work.ts';

/** Scripts run on the phone, which fetches the photos itself. */
const NO_PHOTOS: PhotoSource = {
  fetch: () => Promise.reject(new Error('the phone fetches its own photos')),
};

export function phoneWorkAdapters(
  settings: AutomationSettings,
  marketplaces: Omit<MarketplaceAdaptersConfig, 'automation'>,
  logger: Logger,
): PhoneWorkDependencies['adapters'] {
  return (sessions) => {
    const automation = createAutomationAdapters({ settings, sessions, photos: NO_PHOTOS, logger });
    return {
      lookup: createMarketplaceAdapters({ ...marketplaces, automation }, logger).lookup,
      automation,
    };
  };
}
