/**
 * What every Vinted page module shares: absolute URLs on the site the adapter runs against
 * (Vinted, or the fake Vinted site in development and tests), and the failure every page module
 * throws for a page that is not as it expects.
 */
import { PageChangedError } from '../../runner/errors.ts';
import type { PageDriver } from '../../runner/types.ts';

/** The site a script runs against: Vinted's origin, or the fake Vinted site's. */
export interface VintedSite {
  readonly origin: string;
}

export function absolute(site: VintedSite, path: string): string {
  return `${site.origin}${path}`;
}

/**
 * Waits, within the step's time, for `selector` on a page that Vinted's own scripts may draw
 * after its document is ready, and throws `PageChangedError` naming the part when it never
 * comes. A check the page shows instead still stops the run as one: the page driver throws it
 * again.
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

/** The failure for a Vinted page that is not as the script expects. */
export function changed(pageName: string, problem: string): PageChangedError {
  return new PageChangedError(`Vinted's ${pageName} ${problem}.`);
}

/** How often a look for a part Vinted's scripts draw runs (it only reads, so no pacing). */
export const LOOK_EVERY_MS = 150;

/**
 * Whether `selector` comes within `ms`: Vinted's form draws its lists after a tap. Each look
 * inspects the page, so a check that comes up instead stops the run.
 */
export async function appears(page: PageDriver, selector: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (await page.exists(selector)) return true;
    if (Date.now() >= end) return false;
    await lookAgain(page, LOOK_EVERY_MS);
  }
}

/**
 * Looks at the page again after a moment: the driver inspects it (a check that came up stops
 * the run) and learns its address anew, which Vinted's own scripts change without loading a page.
 */
export async function lookAgain(page: PageDriver, ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await page.waitFor('body', 'attached');
}

/** A text for a `:text-is("...")` selector, its quotes and backslashes escaped. */
export function quote(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}
