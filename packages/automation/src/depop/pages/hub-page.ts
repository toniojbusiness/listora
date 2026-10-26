/**
 * The selling hub's home (`/sellinghub/`), which only a logged-in seller sees: the health check
 * opens it to show the session works. A session Depop rejected lands on its login page instead,
 * which the runner's safety rules stop at.
 *
 * Read on a real signed-in session (2026-10-26, from the evidence a stopped run logs): the page
 * ("Selling Hub - Depop") is drawn by Depop's scripts, with the signed-in user's avatar in the
 * header's user menu (`userNavItem-wrapper`, `avatar`), and it has no `sellingHub` mark.
 */
import type { PageDriver } from '../../runner/types.ts';
import { DEPOP_PATHS } from '../site.ts';
import { absolute, awaitElement, type DepopSite } from './common.ts';

export const HUB_PAGE = {
  signedInUser: '[data-testid="avatar"]',
} as const;

export async function openHub(page: PageDriver, site: DepopSite): Promise<void> {
  await page.goto(absolute(site, DEPOP_PATHS.hub));
  await awaitElement(page, HUB_PAGE.signedInUser, 'selling hub', "signed-in user's avatar");
}
