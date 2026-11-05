/**
 * The Vinted automation adapter (decision D1, docs/features/vinted.md): Listora acts on Vinted,
 * which has no API it can use in the US, through the seller's own session on their iPhone (never
 * the cloud: `runsOn: 'phone'`, `cloudAllowed: false`), under the runner's safety rules: a
 * careful seller's pace, rate limits, and a stop at any CAPTCHA, DataDome check, or sign-in step,
 * after which the seller completes it themselves.
 *
 * Milestone M3: the session check, which shows the linked session works and reads the member it
 * is signed in as. It has no listing script yet, so every kind of step stays the assisted
 * adapter's, and the registry keeps Vinted's listings on the assisted adapter until the listing
 * scripts pass live (M5).
 */
import { createVintedAdapter } from '@listora/marketplaces';
import type { Logger } from '@listora/shared';

import { AutomationAdapter } from '../adapter/automation-adapter.ts';
import type { AutomationSessions } from '../adapter/sessions.ts';
import { standInProfile, type AutomationProfile } from '../profiles.ts';
import type { VintedSite } from './pages/common.ts';
import { createVintedScripts } from './scripts.ts';
import { VINTED_SITE_URL } from './site.ts';

export interface VintedAdapterOptions {
  /** Vinted's profile, as configured (pacing and limits). */
  profile: AutomationProfile;
  sessions: AutomationSessions;
  logger: Logger;
  /**
   * Development and tests only: the fake Vinted site's URL, which then stands in for Vinted (its
   * origin becomes the profile's). Defaults to Vinted itself.
   */
  siteUrl?: string;
}

export function createVintedAutomationAdapter(options: VintedAdapterOptions): AutomationAdapter {
  const siteUrl = options.siteUrl ?? VINTED_SITE_URL;
  const site: VintedSite = { origin: new URL(siteUrl).origin };
  const profile =
    options.siteUrl === undefined ? options.profile : standInProfile(options.profile, siteUrl);

  return new AutomationAdapter({
    marketplace: 'vinted',
    profile,
    sessions: options.sessions,
    // Every step is the seller's in the Vinted app until the listing scripts exist.
    assisted: createVintedAdapter(),
    scripts: createVintedScripts({ site }),
    scriptSet: { name: 'vinted', marketplace: 'vinted', siteUrl },
    readFreshness: 'none',
    logger: options.logger,
  });
}
