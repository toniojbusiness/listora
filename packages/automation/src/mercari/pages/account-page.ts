/**
 * The seller's account page (`/mypage/`), which only a logged-in seller sees: the health check
 * opens it to show the session works. A session Mercari rejected lands on its login page
 * instead, which the runner's safety rules stop at.
 *
 * Read on a real signed-in session (2026-10-26, from the evidence a stopped run logs): Mercari's
 * scripts draw the page after its document is ready, with the seller's own account section
 * (`SellerInfo`, its `EditProfileButton`, `Balance`) and the sign-out form (`LogoutForm`). The
 * edit-profile button is the mark of a seller looking at their own account.
 */
import type { PageDriver } from '../../runner/types.ts';
import { MERCARI_PATHS } from '../site.ts';
import { absolute, awaitElement, type MercariSite } from './common.ts';

export const ACCOUNT_PAGE = {
  ownAccount: '[data-testid="EditProfileButton"]',
} as const;

export async function openAccount(page: PageDriver, site: MercariSite): Promise<void> {
  await page.goto(absolute(site, MERCARI_PATHS.account));
  await awaitElement(page, ACCOUNT_PAGE.ownAccount, 'account page', 'edit profile button');
}
