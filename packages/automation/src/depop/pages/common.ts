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
  /** Depop's web API (`https://webapi.depop.com`), or the fake site's own origin. */
  readonly api: string;
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

/**
 * Waits, within the step's time, for `selector` on a page that Depop's own scripts draw after
 * its document is ready, and throws `PageChangedError` naming the part when it never comes. A
 * check the page shows instead still stops the run as one: the page driver throws it again.
 */
export async function awaitElement(
  page: PageDriver,
  selector: string,
  pageName: string,
  what: string,
): Promise<void> {
  try {
    await page.waitFor(selector, 'attached');
  } catch {
    if (!(await page.exists(selector))) throw changed(pageName, `has no ${what} (${selector})`);
  }
}

/** The failure for a Depop page that is not as the script expects. */
export function changed(pageName: string, problem: string): PageChangedError {
  return new PageChangedError(`Depop's ${pageName} ${problem}.`);
}

/**
 * Looks at the page again after a moment: the driver inspects it (a check that came up stops
 * the run) and learns its address anew, which the page's own scripts may have changed without
 * loading a page (Depop opens a new listing that way).
 */
export async function lookAgain(page: PageDriver, ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await page.waitFor('body', 'attached');
}
