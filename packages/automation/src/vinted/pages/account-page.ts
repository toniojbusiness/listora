/**
 * The seller's profile settings (`/settings/profile`), which only a signed-in member sees: the
 * health check opens it to show the session works, and reads the member it is signed in as. A
 * session Vinted rejected lands on its sign-up and sign-in chooser instead, which the runner's
 * safety rules stop at.
 *
 * Modeled, not yet read on a signed-in session (Vinted plan M2 records it): the page's header
 * carries the signed-in member's own profile link (`/member/<id>-<login>`) in its user menu, as
 * on every page Vinted draws for a member. That link is the mark of a member looking at their
 * own account, and its login is the member the session belongs to.
 */
import type { PageDriver } from '../../runner/types.ts';
import { memberFromPath, VINTED_PATHS } from '../site.ts';
import { absolute, awaitElement, type VintedSite } from './common.ts';

export const ACCOUNT_PAGE = {
  /** The signed-in member's own profile link, in the header's user menu. */
  ownProfile: 'header [data-testid="user-menu"] a[href^="/member/"]',
} as const;

/** Opens the seller's profile settings and waits for the header's own-profile link. */
export async function openAccount(page: PageDriver, site: VintedSite): Promise<void> {
  await page.goto(absolute(site, VINTED_PATHS.account));
  await awaitElement(page, ACCOUNT_PAGE.ownProfile, 'profile settings', 'link to your profile');
}

/**
 * The login of the member signed in on the open settings page, or `null` when its header doesn't
 * show one Listora can read (no login in the link, or links to more than one member): the seller
 * then stays unknown, never a guess
 * (docs/features/marketplace-linking.md#the-shop-a-connection-holds).
 */
export async function signedInMember(page: PageDriver, site: VintedSite): Promise<string | null> {
  const hrefs = await page.attributes(ACCOUNT_PAGE.ownProfile, 'href');
  const logins = new Set<string>();
  for (const href of hrefs) {
    if (href === null) return null;
    let path: string;
    try {
      path = new URL(href, absolute(site, VINTED_PATHS.account)).pathname;
    } catch {
      return null;
    }
    const login = memberFromPath(path)?.login ?? null;
    if (login === null) return null;
    logins.add(login.toLowerCase());
  }
  const [login, ...others] = logins;
  return login === undefined || others.length > 0 ? null : login;
}
