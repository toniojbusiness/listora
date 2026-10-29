/**
 * The Poshmark automation adapter (decision D1, revised 2026-10-24: Poshmark permitted the
 * product owner's automation). It lists, edits, reprices, ends, and relists in the seller's own
 * Poshmark session on the browser runner, reads every change back from the listing's page, lists
 * the closet, and finds sold items for sale checks. The runner's safety rules hold for all of it
 * (human pacing, rate limits, a stop at any check, no stored password), and every step that has to
 * stop falls back to the user's assisted task. docs/features/poshmark.md describes the flows.
 *
 * How each Listora operation is done on Poshmark:
 *
 * - create: the listing form, with the item's photos in posting order, and Listora's SKU in the
 *   seller's private SKU field. An earlier attempt may have gone through, so the script first
 *   looks for a listing with the same title and SKU and reports that one instead of posting twice.
 * - revise, price: the edit form, then Update.
 * - end: availability "Not For Sale". The listing can no longer be bought, keeps its likes and
 *   comments, and comes back with a relist. Listora never deletes a Poshmark listing: a deletion
 *   cannot be read back, and Poshmark's guidelines name deleting and reposting.
 * - relist: availability "For Sale" again. A sold listing cannot be relisted.
 * - mark sold: not needed; Poshmark marks its own sales sold.
 *
 * Reads carry a revision (the listing's newest change time, pages/state.ts). Only a well-formed
 * listing id whose page answers 404 is a definitive absence (pages/listing-page.ts).
 */
import { createPoshmarkAdapter } from '@listora/marketplaces';
import type { Logger } from '@listora/shared';

import { AutomationAdapter } from '../adapter/automation-adapter.ts';
import type { PhotoSource } from '../adapter/photos.ts';
import type { AutomationSessions } from '../adapter/sessions.ts';
import type { AutomationProfile } from '../profiles.ts';
import {
  buildPoshmarkPayload,
  validatePoshmarkPayload,
  type PoshmarkListingPayload,
} from './payload.ts';
import { createPoshmarkScripts } from './scripts.ts';
import { PoshmarkSite } from './site.ts';

export interface PoshmarkAdapterOptions {
  /** Poshmark's profile; its first origin is the site (the fake Poshmark's in development). */
  profile: AutomationProfile;
  sessions: AutomationSessions;
  photos: PhotoSource;
  logger: Logger;
  /** See `PoshmarkScriptOptions.settleWaitMs`. */
  settleWaitMs?: number;
  /** See `PoshmarkScriptOptions.newWaitMs`. */
  newWaitMs?: number;
}

export function createPoshmarkAutomationAdapter(
  options: PoshmarkAdapterOptions,
): AutomationAdapter<PoshmarkListingPayload> {
  const [origin] = options.profile.origins;
  if (options.profile.marketplace !== 'poshmark' || origin === undefined) {
    throw new Error('the Poshmark adapter needs the Poshmark profile');
  }
  const site = new PoshmarkSite(origin);

  return new AutomationAdapter<PoshmarkListingPayload>({
    marketplace: 'poshmark',
    profile: options.profile,
    sessions: options.sessions,
    // Fallback tasks open the real Poshmark, where the user does the step.
    assisted: createPoshmarkAdapter(),
    scripts: createPoshmarkScripts({
      site,
      photos: options.photos,
      ...(options.settleWaitMs === undefined ? {} : { settleWaitMs: options.settleWaitMs }),
      ...(options.newWaitMs === undefined ? {} : { newWaitMs: options.newWaitMs }),
    }),
    scriptSet: { name: 'poshmark', marketplace: 'poshmark', siteUrl: origin },
    readFreshness: 'revision',
    buildPayload: buildPoshmarkPayload,
    validate: validatePoshmarkPayload,
    logger: options.logger,
  });
}
