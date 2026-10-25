/**
 * Which seller the session belongs to. Closet pages are addressed by the seller's username, which
 * the session's cookies do not say, so scripts that read the closet first open the listing form:
 * a page only a logged-in seller sees (without a session Poshmark sends the browser to `/login`,
 * where the runner stops for a relink), whose data names the seller (`auth.identity`).
 */
import { PageChangedError } from '../../runner/errors.ts';
import type { PageDriver } from '../../runner/types.ts';
import type { PoshmarkSite } from '../site.ts';
import { authSchema, expectShape, readPageState } from './state.ts';

const PAGE = 'listing form';

/** Opens the listing form and returns the logged-in seller's username. */
export async function loggedInSeller(page: PageDriver, site: PoshmarkSite): Promise<string> {
  await page.goto(site.createListing());
  const { auth } = expectShape(authSchema, await readPageState(page, PAGE), PAGE);
  const username = auth.identity?.username ?? auth.identity?.display_handle;
  if (!auth.isUserLoggedIn || username === undefined || username === '') {
    throw new PageChangedError(`Poshmark's ${PAGE} no longer says which seller is logged in`);
  }
  return username;
}
