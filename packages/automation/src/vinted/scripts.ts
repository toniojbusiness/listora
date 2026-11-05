/**
 * The Vinted automation scripts (docs/features/vinted.md), which the browser runner and the
 * iPhone app run in the seller's own session through the page modules in `pages/`. Milestone M3
 * has only the session check: the health script opens the seller's profile settings and reads
 * the member signed in. The listing scripts (create, price, hide, unhide, read-back) come with
 * M5; until then every Vinted step is the seller's assisted task, and the registry never routes
 * one here (`createMarketplaceAdapters` in `@listora/marketplaces`).
 */
import type { AssistedListingPayload } from '@listora/marketplaces';

import { sellerIdentity, type AutomationScripts } from '../adapter/script-call.ts';
import { PageChangedError } from '../runner/errors.ts';
import type { VintedSite } from './pages/common.ts';
import { openAccount, signedInMember } from './pages/account-page.ts';

export interface VintedScriptOptions {
  site: VintedSite;
}

export function createVintedScripts(
  options: VintedScriptOptions,
): AutomationScripts<AssistedListingPayload> {
  const { site } = options;
  return {
    read: () =>
      // Never asked: no Vinted step is automated before M5, so nothing reads a listing back.
      Promise.reject(new PageChangedError("Listora doesn't read Vinted listings yet.")),
    health: (step) =>
      step('open your profile settings', { mutates: false }, async (page) => {
        await openAccount(page, site);
        return sellerIdentity(await signedInMember(page, site));
      }),
  };
}
