/**
 * What every Depop page module shares: absolute URLs on the site the adapter runs against
 * (Depop, or the fake Depop site in development and tests), and the failure every page module
 * throws for a page that is not as it expects.
 */
import { PageChangedError } from '../../runner/errors.ts';
import type { PageDriver } from '../../runner/types.ts';
import { DEPOP_PATHS } from '../site.ts';

/** The site a script runs against: Depop's origin, or the fake Depop site's. */
export interface DepopSite {
  readonly origin: string;
}

export function absolute(site: DepopSite, path: string): string {
  return `${site.origin}${path}`;
}

/** A product's page: the listing's `externalUrl`. */
export function productUrl(site: DepopSite, slug: string): string {
  return absolute(site, DEPOP_PATHS.product(slug));
}

/**
 * Throws `PageChangedError` naming the page and the part of it that is missing, unless the
 * page has `selector`.
 */
export async function expectElement(
  page: PageDriver,
  selector: string,
  pageName: string,
  what: string,
): Promise<void> {
  if (!(await page.exists(selector))) throw changed(pageName, `has no ${what} (${selector})`);
}

/** The failure for a Depop page that is not as the script expects. */
export function changed(pageName: string, problem: string): PageChangedError {
  return new PageChangedError(`Depop's ${pageName} ${problem}; the page may have changed.`);
}
