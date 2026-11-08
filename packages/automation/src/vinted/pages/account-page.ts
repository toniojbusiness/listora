/**
 * The seller's profile settings (`/settings/profile`), which only a signed-in member sees: the
 * health check opens it to show the session works, and asks Vinted's web API which member it is
 * signed in as. A session Vinted rejected lands on its sign-up and sign-in chooser instead, which
 * the runner's safety rules stop at.
 *
 * Read on the test account's signed-in session (2026-11-05): every page Vinted draws for a
 * member has the user menu's button in its header (`user-menu-button`), and the menu's profile
 * link, drawn only once the button is pressed, is `/member/<id>` with no login after it. So the
 * member comes from the web API the pages read it from: `GET /api/v2/users/current`, the
 * member's `id` and `login`.
 *
 * A session Vinted signed out does not always go to the chooser's own address first: on the
 * captain's phone (2026-11-05 to 11-08), the settings page was drawn for a visitor, with the
 * header's "Sign up | Log in" button (`header--login-button`) and the chooser over it, and the
 * wait for the user menu ran the step out of time, shown as a timeout instead of "link Vinted
 * again". So the wait ends at either header: the visitor's stops the run as signed out.
 */
import { z } from 'zod';

import { SignedOutError } from '../../runner/errors.ts';
import type { PageDriver } from '../../runner/types.ts';
import { VINTED_API_PATHS, VINTED_ID, VINTED_PATHS } from '../site.ts';
import { absolute, changed, type VintedSite } from './common.ts';

export const ACCOUNT_PAGE = {
  /** The user menu's button in the header, which only a signed-in member's pages draw. */
  userMenu: 'header [data-testid="user-menu-button"]',
  /**
   * What Vinted draws for a visitor instead: the header's "Sign up | Log in" button, or the
   * sign-up and sign-in chooser's "Log in" switch (read in the page evidence of the captain's
   * phone, 2026-11-08).
   */
  signedOut:
    '[data-testid="header--login-button"], [data-testid="auth-select-type--register-switch"]',
} as const;

const currentUserSchema = z.object({
  user: z
    .object({
      id: z.union([z.number().int().nonnegative(), z.string().regex(VINTED_ID)]).transform(String),
      login: z.string().nullish(),
    })
    .catchall(z.unknown()),
});

/** The member a session is signed in as: Vinted's numeric id, and their login when shown. */
export interface VintedMember {
  id: string;
  /** Lower-cased; `null` when Vinted shows none. */
  login: string | null;
}

/**
 * Opens the seller's profile settings and waits for the header's user menu. Throws
 * `SignedOutError` when the page is drawn for a visitor instead, and `PageChangedError` when it
 * has neither header.
 */
export async function openAccount(page: PageDriver, site: VintedSite): Promise<void> {
  await page.goto(absolute(site, VINTED_PATHS.account));
  try {
    // Either header ends the wait; the page is inspected after it, so a move to the sign-in
    // chooser's address meanwhile stops the run there.
    await page.waitFor(`${ACCOUNT_PAGE.userMenu}, ${ACCOUNT_PAGE.signedOut}`, 'attached');
  } catch {
    // Neither came in time: told apart below.
  }
  if (await page.exists(ACCOUNT_PAGE.userMenu)) return;
  if (await page.exists(ACCOUNT_PAGE.signedOut)) {
    throw new SignedOutError("Vinted's profile settings show the signed-out header.");
  }
  throw changed('profile settings', `has no user menu (${ACCOUNT_PAGE.userMenu})`);
}

/**
 * The member signed in, as Vinted's web API answers from an open Vinted page. Throws
 * `PageChangedError` for an answer Listora doesn't know, so no read goes on without knowing whose
 * account it reads.
 */
export async function currentMember(page: PageDriver, site: VintedSite): Promise<VintedMember> {
  const answer = await page.apiGet(absolute(site, VINTED_API_PATHS.currentUser), {
    pageCookies: true,
  });
  if (answer.status === 401) {
    throw new SignedOutError("Vinted's web API has no member signed in (401).");
  }
  if (answer.status !== 200) {
    throw changed('web API', `answered ${String(answer.status)} for the member signed in`);
  }
  const parsed = currentUserSchema.safeParse(answer.body);
  if (!parsed.success) throw changed('web API', "doesn't show which member is signed in");
  const login = parsed.data.user.login?.trim().toLowerCase() ?? '';
  return { id: parsed.data.user.id, login: login === '' ? null : login };
}

/**
 * The login of the member signed in, or `null` when Vinted shows none: the seller then stays
 * unknown, never a guess (docs/features/marketplace-linking.md#the-shop-a-connection-holds).
 */
export async function signedInMember(page: PageDriver, site: VintedSite): Promise<string | null> {
  return (await currentMember(page, site)).login;
}
