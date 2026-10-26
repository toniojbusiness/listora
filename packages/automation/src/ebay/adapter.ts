/**
 * The eBay automation adapter (decision D1, revised 2026-10-24: eBay permitted the product
 * owner's automation for their own use; docs/features/ebay-automation.md). Until Listora's eBay
 * developer keys exist, Listora acts on eBay through the seller's own browser session in the
 * browser runner. Its scripts drive eBay's pages through the page modules in `pages/` (one per
 * page, with that page's selectors), under the runner's safety rules: human pacing, rate limits,
 * and a stop at any CAPTCHA, bot check, or login challenge, after which the step is the user's
 * task. A seller whose eBay connection uses the API is served by the eBay API adapter instead
 * (`ConnectionAwareAdapter`), never by this one; both address the same listings by eBay's item
 * number and the seller's SKU, so the switch needs no data migration.
 *
 * - Create: fill the listing form in the listing's category (photos in order, title, the SKU as
 *   the Custom label, item specifics, condition, description, price), then List it; only that
 *   click mutates. A later attempt first looks for the listing by its SKU, so a create eBay
 *   already took is never listed twice.
 * - Revise and price: the revise form, then Revise it.
 * - End: Seller Hub's end page ("The item is no longer available"). eBay keeps the ended
 *   listing, so the read-back confirms it ended. Relist: eBay's relist form, filled with the
 *   listing's content, lists it again under a new item number, as the Trading API's relist does.
 * - Mark sold is not needed: eBay marks its own sales sold.
 * - Read-back: the listing's page (status, title, price, and its newest time as the revision),
 *   and the revise form for the description of a listing on sale.
 * - Sale checks read Seller Hub's sold listings; its active listings list the seller's listings
 *   for imports and drift checks.
 */
import { createEbayAssistedAdapter } from '@listora/marketplaces';
import type { Logger } from '@listora/shared';

import { AutomationAdapter } from '../adapter/automation-adapter.ts';
import type { PhotoSource } from '../adapter/photos.ts';
import type { AutomationSessions } from '../adapter/sessions.ts';
import { standInProfile, type AutomationProfile } from '../profiles.ts';
import type { EbaySite } from './pages/common.ts';
import {
  buildEbayAutomationPayload,
  validateEbayAutomationPayload,
  type EbayAutomationPayload,
} from './payload.ts';
import { createEbayScripts } from './scripts.ts';
import { EBAY_SITE_URL } from './site.ts';

export interface EbayAutomationAdapterOptions {
  /** eBay's profile, as configured (pacing and limits). */
  profile: AutomationProfile;
  sessions: AutomationSessions;
  photos: PhotoSource;
  logger: Logger;
  /**
   * Development and tests only: the fake eBay site's URL, which then stands in for eBay (its
   * origin becomes the profile's). Defaults to eBay itself.
   */
  siteUrl?: string;
}

export function createEbayAutomationAdapter(
  options: EbayAutomationAdapterOptions,
): AutomationAdapter<EbayAutomationPayload> {
  const siteUrl = options.siteUrl ?? EBAY_SITE_URL;
  const site: EbaySite = { origin: new URL(siteUrl).origin };
  const profile =
    options.siteUrl === undefined ? options.profile : standInProfile(options.profile, siteUrl);

  return new AutomationAdapter<EbayAutomationPayload>({
    marketplace: 'ebay',
    profile,
    sessions: options.sessions,
    // A step automation can't do opens the real eBay, where the user does it.
    assisted: createEbayAssistedAdapter(),
    scripts: createEbayScripts({ site, photos: options.photos }),
    scriptSet: { name: 'ebay', marketplace: 'ebay', siteUrl },
    readFreshness: 'revision',
    buildPayload: buildEbayAutomationPayload,
    validate: validateEbayAutomationPayload,
    logger: options.logger,
  });
}
