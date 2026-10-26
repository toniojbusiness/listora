/**
 * The automation adapter for the fake marketplace site: the reference for the per-marketplace
 * automation adapters, and the one development and the runner's tests use in place of
 * Poshmark, Mercari, or Depop. Its scripts work the way a real marketplace's must:
 *
 * - a create first looks the seller's SKU up and reports a listing it finds instead of posting
 *   it twice (an earlier attempt may have gone through);
 * - filling a form changes nothing; only the step that submits it `mutates`;
 * - a validation message on the form is a rejection with the marketplace's own words;
 * - reads parse the listing page's own markers (status, revision), and treat only the site's
 *   "removed" answer for the id as a definitive absence.
 */
import {
  createDepopAssistedAdapter,
  createEbayAssistedAdapter,
  createMercariAdapter,
  createPoshmarkAdapter,
  type AssistedAdapter,
} from '@listora/marketplaces';
import type { Logger } from '@listora/shared';

import { AutomationAdapter } from '../adapter/automation-adapter.ts';
import type { PhotoSource } from '../adapter/photos.ts';
import type { AutomationSessions } from '../adapter/sessions.ts';
import { standInProfile, type AutomatedMarketplace, type AutomationProfile } from '../profiles.ts';
import { createFakeSiteScripts } from './scripts.ts';

export interface FakeSiteAdapterOptions {
  /** The marketplace the fake site stands in for. */
  marketplace: AutomatedMarketplace;
  siteUrl: string;
  /** The marketplace's configured profile; its origin becomes the fake site's. */
  profile: AutomationProfile;
  sessions: AutomationSessions;
  photos: PhotoSource;
  logger: Logger;
}

export function createFakeSiteAdapter(options: FakeSiteAdapterOptions): AutomationAdapter {
  const site = new URL(options.siteUrl).origin;

  return new AutomationAdapter({
    marketplace: options.marketplace,
    profile: standInProfile(options.profile, options.siteUrl),
    sessions: options.sessions,
    // Fallback tasks still open the real marketplace, where the user does the step.
    assisted: assistedAdapter(options.marketplace),
    scripts: createFakeSiteScripts({ site, photos: options.photos }),
    scriptSet: { name: 'fake_site', marketplace: options.marketplace, siteUrl: options.siteUrl },
    readFreshness: 'revision',
    logger: options.logger,
  });
}

/** The marketplace's own assisted adapter, which automation falls back to. */
export function assistedAdapter(marketplace: AutomatedMarketplace): AssistedAdapter {
  switch (marketplace) {
    case 'poshmark':
      return createPoshmarkAdapter();
    case 'mercari':
      return createMercariAdapter();
    case 'depop':
      return createDepopAssistedAdapter();
    case 'ebay':
      return createEbayAssistedAdapter();
  }
}
