/**
 * The selling hub's home (`/sellinghub/`), which only a logged-in seller sees: the health check
 * opens it to show the session works. A session Depop rejected lands on its login page instead,
 * which the runner's safety rules stop at.
 *
 * Read on a real signed-in session (2026-10-26, from the evidence a stopped run logs): the page
 * ("Selling Hub - Depop") is drawn by Depop's scripts, with the signed-in user's avatar in the
 * header's user menu (`userNavItem-wrapper`, `avatar`), and it has no `sellingHub` mark. The
 * header's Likes link goes to the signed-in user's likes, under their username
 * (`/<username>/likes/`): the seller the session belongs to.
 */
import type { PageDriver } from '../../runner/types.ts';
import { DEPOP_PATHS } from '../site.ts';
import { absolute, awaitElement, type DepopSite } from './common.ts';

export const HUB_PAGE = {
  signedInUser: '[data-testid="avatar"]',
  likes: 'a[aria-label="Likes"]',
} as const;

/** A username as Depop's paths carry it. */
const USERNAME_PATH = /^\/([A-Za-z0-9._-]+)\/likes\/?$/;

export async function openHub(page: PageDriver, site: DepopSite): Promise<void> {
  await page.goto(absolute(site, DEPOP_PATHS.hub));
  await awaitElement(page, HUB_PAGE.signedInUser, 'selling hub', "signed-in user's avatar");
}

/**
 * The username of the seller signed in on the open hub, or `null` when its header doesn't show
 * it as Listora knows (docs/features/marketplace-linking.md#the-shop-a-connection-holds).
 */
export async function hubSeller(page: PageDriver, site: DepopSite): Promise<string | null> {
  const href = await page.attribute(HUB_PAGE.likes, 'href');
  if (href === null) return null;
  let url: URL;
  try {
    url = new URL(href, absolute(site, DEPOP_PATHS.hub));
  } catch {
    return null;
  }
  return USERNAME_PATH.exec(url.pathname)?.[1] ?? null;
}
