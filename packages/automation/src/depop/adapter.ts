/**
 * The Depop automation adapter (decision D1, revised 2026-10-24: Depop permitted the product
 * owner's automation; docs/features/depop-automation.md). Until Listora's Depop partner API
 * access is granted, Listora acts on Depop through the seller's own browser session in the
 * browser runner. Its scripts drive Depop's pages through the page modules in `pages/` (one per
 * page, with that page's selectors and data keys), under the runner's safety rules: human
 * pacing, rate limits, and a stop at any CAPTCHA, bot check, or login challenge, after which the
 * step is the user's task. A seller whose Depop connection uses the API is served by the Depop
 * API adapter instead (`ConnectionAwareAdapter`), never by this one.
 *
 * - Create: fill the sell form (the listing text with Listora's SKU line, category, size, brand,
 *   condition, colours, material, price, and the photos in order), then Post; only that click
 *   mutates. A later attempt first looks for the listing by its SKU, so a create Depop already
 *   took is never posted twice.
 * - Revise and price: the edit page's form, then Save.
 * - End: Delete listing on the product page; the deleted product's page answers 410 Gone, which
 *   confirms it ended. Relist: a new listing from the listing's content (Depop cannot put a
 *   deleted listing back on sale), with a new slug, as Depop's API relists with a new product.
 * - Mark sold is not automated: after a sale elsewhere the auto-delist ends Depop listings.
 * - Read-back: the seller's own product from Depop's web API, as its edit page reads it, with
 *   Depop's last change time as the revision (pages/api.ts).
 * - Sale checks read the sold items page; the web API's list of the seller's listings serves
 *   imports and drift checks.
 */
import { createDepopAssistedAdapter } from '@listora/marketplaces';
import type { Logger } from '@listora/shared';

import { AutomationAdapter } from '../adapter/automation-adapter.ts';
import type { PhotoSource } from '../adapter/photos.ts';
import type { AutomationSessions } from '../adapter/sessions.ts';
import { standInProfile, type AutomationProfile } from '../profiles.ts';
import type { DepopSite } from './pages/common.ts';
import {
  buildDepopAutomationPayload,
  validateDepopAutomationPayload,
  type DepopAutomationPayload,
} from './payload.ts';
import { createDepopScripts } from './scripts.ts';
import { DEPOP_SITE_URL, depopSite } from './site.ts';

export interface DepopAutomationAdapterOptions {
  /** Depop's profile, as configured (pacing and limits). */
  profile: AutomationProfile;
  sessions: AutomationSessions;
  photos: PhotoSource;
  logger: Logger;
  /**
   * Development and tests only: the fake Depop site's URL, which then stands in for Depop (its
   * origin becomes the profile's). Defaults to Depop itself.
   */
  siteUrl?: string;
}

export function createDepopAutomationAdapter(
  options: DepopAutomationAdapterOptions,
): AutomationAdapter<DepopAutomationPayload> {
  const siteUrl = options.siteUrl ?? DEPOP_SITE_URL;
  const site: DepopSite = depopSite(siteUrl);
  const profile =
    options.siteUrl === undefined ? options.profile : standInProfile(options.profile, siteUrl);

  return new AutomationAdapter<DepopAutomationPayload>({
    marketplace: 'depop',
    profile,
    sessions: options.sessions,
    // A step automation can't do opens the real Depop, where the user does it.
    assisted: createDepopAssistedAdapter(),
    scripts: createDepopScripts({ site, photos: options.photos }),
    scriptSet: { name: 'depop', marketplace: 'depop', siteUrl },
    // A read carries Depop's own last change time (pages/api.ts).
    readFreshness: 'revision',
    buildPayload: buildDepopAutomationPayload,
    validate: validateDepopAutomationPayload,
    logger: options.logger,
  });
}
