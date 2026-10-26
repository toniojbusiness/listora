/**
 * The seller's own shop page (`/<username>/`), the one place Depop lists a seller's products for
 * sale, newest first: how a listing whose slug Listora never learned (one it just posted) is
 * found by its SKU. Depop's selling hub no longer lists them (`/sellinghub/selling/` opens the
 * hub's home), and the shop page draws its products with its own scripts, as links to their
 * pages (`/products/<slug>/`); a product's SKU is read on its own page (product-page.ts).
 *
 * The seller's username is the shop's address. A signed-in page names it only in the header's
 * user menu, whose link to the seller's profile appears once the menu (`#userNavItem-button`)
 * opens: the one link to a single-name path the open menu adds. Both are Listora's model, to be
 * confirmed by the evidence a stopped run logs.
 */
import type { PageDriver } from '../../runner/types.ts';
import { DEPOP_PATHS, slugFromPath } from '../site.ts';
import { absolute, awaitElement, changed, lookAgain, type DepopSite } from './common.ts';
import { HUB_PAGE } from './hub-page.ts';

export const SHOP_PAGE = {
  userMenu: 'button#userNavItem-button',
  links: 'a[href]',
  productLinks: 'a[href*="/products/"]',
} as const;

/** A Depop username, the one segment of a shop's path. */
const USERNAME = /^[a-z0-9][a-z0-9._]{1,29}$/i;
/** Depop's own top-level pages, which a single-name path may also be. */
const SITE_PATHS = new Set(
  (
    'about app blog brand brands category checkout cookies discover download explore help ' +
    'legal likes login messages news privacy products safety search sell sellinghub settings ' +
    'shop signup sitemap terms'
  ).split(' '),
);
/** How long the menu and the shop's product list get to appear, and how often they are looked at. */
const APPEAR_MS = 8_000;
const LOOK_EVERY_MS = 500;

/** The signed-in seller's username, from the profile link in the header's user menu. */
export async function findSeller(page: PageDriver, site: DepopSite): Promise<string> {
  await page.goto(absolute(site, DEPOP_PATHS.hub));
  await awaitElement(page, HUB_PAGE.signedInUser, 'selling hub', "signed-in user's avatar");
  const before = new Set(await profilePaths(page, site));
  await page.click(SHOP_PAGE.userMenu);
  const end = Date.now() + APPEAR_MS;
  for (;;) {
    // The menu's button may also open the profile itself.
    const shown = usernameOf(new URL(page.url()).pathname);
    if (shown !== null) return shown;
    const added = [...new Set(await profilePaths(page, site))].filter((path) => !before.has(path));
    if (added.length === 1 && added[0] !== undefined) {
      const username = usernameOf(added[0]);
      if (username !== null) return username;
    }
    if (added.length > 1) {
      throw changed('user menu', `offers ${String(added.length)} profile links, not one`);
    }
    if (Date.now() >= end) throw changed('user menu', "has no link to the seller's shop");
    await lookAgain(page, LOOK_EVERY_MS);
  }
}

/**
 * The slugs of the newest products the seller's shop shows, newest first, at most `limit`; none
 * for a shop with nothing for sale (or one whose list didn't come in time, so absence is never
 * definitive).
 */
export async function newestProducts(
  page: PageDriver,
  site: DepopSite,
  username: string,
  limit: number,
): Promise<string[]> {
  await page.goto(absolute(site, `/${encodeURIComponent(username)}/`));
  if (page.status() === 404) throw changed('shop page', 'is not there for the signed-in seller');
  const end = Date.now() + APPEAR_MS;
  while (!(await page.exists(SHOP_PAGE.productLinks)) && Date.now() < end) {
    await lookAgain(page, LOOK_EVERY_MS);
  }
  const slugs: string[] = [];
  for (const href of await page.attributes(SHOP_PAGE.productLinks, 'href')) {
    const slug = href === null ? null : slugOf(href, site);
    if (slug !== null && !slugs.includes(slug)) slugs.push(slug);
    if (slugs.length >= limit) break;
  }
  return slugs;
}

/** The page's links to single-name paths on the site (`/janedoe/`), as paths. */
async function profilePaths(page: PageDriver, site: DepopSite): Promise<string[]> {
  const paths: string[] = [];
  for (const href of await page.attributes(SHOP_PAGE.links, 'href')) {
    if (href === null || !URL.canParse(href, site.origin)) continue;
    const url = new URL(href, site.origin);
    if (url.origin !== site.origin) continue;
    if (usernameOf(url.pathname) !== null) paths.push(url.pathname);
  }
  return paths;
}

function usernameOf(path: string): string | null {
  const segment = /^\/([^/]+)\/?$/.exec(path)?.[1];
  if (segment === undefined) return null;
  const name = decodeURIComponent(segment);
  return USERNAME.test(name) && !SITE_PATHS.has(name.toLowerCase()) ? name : null;
}

function slugOf(href: string, site: DepopSite): string | null {
  if (!URL.canParse(href, site.origin)) return null;
  const url = new URL(href, site.origin);
  return url.origin === site.origin ? slugFromPath(url.pathname) : null;
}
