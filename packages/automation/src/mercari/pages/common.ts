/**
 * What every Mercari page module shares: absolute URLs on the site the adapter runs against
 * (Mercari, or the fake Mercari site in development and tests), Mercari's price format, and
 * the failure every page module throws for a page that is not as it expects.
 */
import { PageChangedError } from '../../runner/errors.ts';
import type { PageDriver } from '../../runner/types.ts';

/** The site a script runs against: Mercari's origin, or the fake Mercari site's. */
export interface MercariSite {
  readonly origin: string;
}

export function absolute(site: MercariSite, path: string): string {
  return `${site.origin}${path}`;
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
 * Waits, within the step's time, for `selector` on a page that Mercari's own scripts draw after
 * its document is ready (its signed-in pages are static Next.js pages filled in by the browser,
 * read 2026-10-26), and throws `PageChangedError` naming the part when it never comes. A check
 * the page shows instead still stops the run as one: the page driver throws it again.
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

/** The failure for a Mercari page that is not as the script expects. */
export function changed(pageName: string, problem: string): PageChangedError {
  return new PageChangedError(`Mercari's ${pageName} ${problem}; the page may have changed.`);
}

/** Cents from a price as Mercari shows it: `$45`, `$1,250`, or `$45.00`. `null` otherwise. */
export function parsePrice(shown: string | null): number | null {
  const match = /^\$\s?(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{2}))?$/.exec(shown?.trim() ?? '');
  if (match?.[1] === undefined) return null;
  const dollars = Number(match[1].replaceAll(',', ''));
  const cents = match[2] === undefined ? 0 : Number(match[2]);
  return dollars * 100 + cents;
}

/** Whole dollars for Mercari's price field (prices are validated to be whole dollars). */
export function priceField(cents: number): string {
  return String(Math.floor(cents / 100));
}
