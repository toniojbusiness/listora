/**
 * The Mercari automation adapter (decision D1, docs/mercari.md): Listora acts on Mercari, which
 * has no API, through the seller's own browser session in the browser runner. Its scripts drive
 * Mercari's pages through the page modules in `pages/` (one per page, with that page's
 * selectors), under the runner's safety rules: human pacing, rate limits, and a stop at any
 * CAPTCHA, Cloudflare check, or login challenge, after which the step is the user's task.
 *
 * - Create: fill the sell form (photos in order, title, description with the SKU line,
 *   category, brand, condition, size, shipping, price), then List; only that click mutates. A
 *   later attempt first looks for the listing by its SKU, so a create Mercari already took is
 *   never posted twice.
 * - Revise and price: the edit page's form, then Save. End: Deactivate (the listing is kept);
 *   relist: Activate. Mercari marks its own sales sold, so mark-sold is not needed.
 * - Read-back: the listing's page, with its last-updated time as the revision.
 * - Sale checks read the in-progress and sold tabs; the seller's active and inactive tabs list
 *   their listings for imports and drift checks.
 */
import { createMercariAdapter } from '@listora/marketplaces';
import type { Logger } from '@listora/shared';

import { AutomationAdapter } from '../adapter/automation-adapter.ts';
import type { PhotoSource } from '../adapter/photos.ts';
import type { AutomationSessions } from '../adapter/sessions.ts';
import { standInProfile, type AutomationProfile } from '../profiles.ts';
import type { MercariSite } from './pages/common.ts';
import {
  buildMercariPayload,
  validateMercariPayload,
  type MercariListingPayload,
} from './payload.ts';
import { createMercariScripts } from './scripts.ts';
import { MERCARI_SITE_URL } from './site.ts';

export interface MercariAdapterOptions {
  /** Mercari's profile, as configured (pacing and limits). */
  profile: AutomationProfile;
  sessions: AutomationSessions;
  photos: PhotoSource;
  logger: Logger;
  /**
   * Development and tests only: the fake Mercari site's URL, which then stands in for Mercari
   * (its origin becomes the profile's). Defaults to Mercari itself.
   */
  siteUrl?: string;
}

export function createMercariAutomationAdapter(
  options: MercariAdapterOptions,
): AutomationAdapter<MercariListingPayload> {
  const siteUrl = options.siteUrl ?? MERCARI_SITE_URL;
  const site: MercariSite = { origin: new URL(siteUrl).origin };
  const profile =
    options.siteUrl === undefined ? options.profile : standInProfile(options.profile, siteUrl);

  return new AutomationAdapter<MercariListingPayload>({
    marketplace: 'mercari',
    profile,
    sessions: options.sessions,
    // A step automation can't do opens the real Mercari, where the user does it.
    assisted: createMercariAdapter(),
    scripts: createMercariScripts({ site, photos: options.photos }),
    scriptSet: { name: 'mercari', marketplace: 'mercari', siteUrl },
    readFreshness: 'revision',
    buildPayload: buildMercariPayload,
    validate: validateMercariPayload,
    logger: options.logger,
  });
}
