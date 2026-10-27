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
import { absolute, awaitElement, changed, type MercariSite } from './common.ts';

export const ACCOUNT_PAGE = {
  ownAccount: '[data-testid="EditProfileButton"]',
  /** The link to the seller's done sales (read 2026-10-26: not `/mypage/listings/sold/`). */
  sales: 'a[data-testid="Sales"]',
} as const;

export async function openAccount(page: PageDriver, site: MercariSite): Promise<void> {
  await page.goto(absolute(site, MERCARI_PATHS.account));
  await awaitElement(page, ACCOUNT_PAGE.ownAccount, 'account page', 'edit profile button');
}

/** The path of the seller's done-sales tab, as the account page's Sales link gives it. */
export async function salesTabPath(page: PageDriver, site: MercariSite): Promise<string> {
  await openAccount(page, site);
  await awaitElement(page, ACCOUNT_PAGE.sales, 'account page', 'sales link');
  const href = await page.attribute(ACCOUNT_PAGE.sales, 'href');
  const path = href === null ? null : new URL(href, site.origin).pathname;
  if (path === null || !/^\/mypage\/listings\/[a-z_]+\/$/.test(path)) {
    throw changed('account page', 'has a sales link Listora does not understand');
  }
  return path;
}
