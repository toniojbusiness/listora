/**
 * The Vinted automation adapter (decision D1, docs/features/vinted.md): Listora acts on Vinted,
 * which has no API it can use in the US, through the seller's own session on their iPhone (never
 * the cloud: `runsOn: 'phone'`, `cloudAllowed: false`), under the runner's safety rules: a
 * careful seller's pace, rate limits, and a stop at any CAPTCHA, DataDome check, or sign-in step,
 * after which the seller completes it themselves.
 *
 * - The session check (M3), the listings an import reads and the sold orders (M4).
 * - Create, price, end (Hide), and relist (Unhide), each confirmed by a read-back of the listing
 *   from Vinted's web API, in which a listing Vinted reviews is not live yet (M5). Revising a
 *   listing's details stays the seller's in Vinted.
 * - The buyers' offers, read from the seller's conversations, and accept, decline, or counter on
 *   the offer's own conversation, each confirmed by a read-back (M7). Offers and their answers
 *   are hidden for sellers until they pass live (`offers`, `offer_answers` in `features.ts`).
 *
 * The listing scripts serve only the owner's Test mode until they pass live on the captain's
 * test account (`LISTING_AUTOMATION_NOT_VERIFIED`); every other seller's Vinted steps stay the
 * assisted adapter's tasks.
 */
import { createVintedAdapter } from '@listora/marketplaces';
import type { Logger } from '@listora/shared';

import { AutomationAdapter } from '../adapter/automation-adapter.ts';
import type { PhotoSource } from '../adapter/photos.ts';
import type { AutomationSessions } from '../adapter/sessions.ts';
import { standInProfile, type AutomationProfile } from '../profiles.ts';
import type { VintedSite } from './pages/common.ts';
import { buildVintedPayload, validateVintedPayload, type VintedListingPayload } from './payload.ts';
import { createVintedScripts } from './scripts.ts';
import { VINTED_SITE_URL } from './site.ts';

export interface VintedAdapterOptions {
  /** Vinted's profile, as configured (pacing and limits). */
  profile: AutomationProfile;
  sessions: AutomationSessions;
  photos: PhotoSource;
  logger: Logger;
  /**
   * Development and tests only: the fake Vinted site's URL, which then stands in for Vinted (its
   * origin becomes the profile's). Defaults to Vinted itself.
   */
  siteUrl?: string;
}

export function createVintedAutomationAdapter(
  options: VintedAdapterOptions,
): AutomationAdapter<VintedListingPayload> {
  const siteUrl = options.siteUrl ?? VINTED_SITE_URL;
  const site: VintedSite = { origin: new URL(siteUrl).origin };
  const profile =
    options.siteUrl === undefined ? options.profile : standInProfile(options.profile, siteUrl);

  return new AutomationAdapter<VintedListingPayload>({
    marketplace: 'vinted',
    profile,
    sessions: options.sessions,
    // A step automation can't do (or that hasn't passed live) is the seller's in Vinted.
    assisted: createVintedAdapter(),
    scripts: createVintedScripts({ site, photos: options.photos }),
    scriptSet: { name: 'vinted', marketplace: 'vinted', siteUrl },
    // Vinted's web API shows no revision or last-change time Listora has read yet: a change is
    // confirmed by two matching reads a delay apart (docs/features/operations.md).
    readFreshness: 'none',
    buildPayload: buildVintedPayload,
    validate: validateVintedPayload,
    logger: options.logger,
  });
}
