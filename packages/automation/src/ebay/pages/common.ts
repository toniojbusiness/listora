/**
 * What every eBay page module shares: absolute URLs on the site the adapter runs against (eBay,
 * or the fake eBay site in development and tests), eBay's price and time formats, and the
 * failure every page module throws for a page that is not as it expects.
 */
import { PageChangedError } from '../../runner/errors.ts';
import type { PageDriver } from '../../runner/types.ts';
import { EBAY_PATHS } from '../site.ts';

/** The site a script runs against: eBay's origin, or the fake eBay site's. */
export interface EbaySite {
  readonly origin: string;
}

export function absolute(site: EbaySite, path: string): string {
  return `${site.origin}${path}`;
}

/** A listing's page: the listing's `externalUrl`. */
export function itemUrl(site: EbaySite, itemId: string): string {
  return absolute(site, EBAY_PATHS.item(itemId));
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

/** The failure for an eBay page that is not as the script expects. */
export function changed(pageName: string, problem: string): PageChangedError {
  return new PageChangedError(`eBay's ${pageName} ${problem}.`);
}

/** A US dollar price as eBay shows it (`US $45.00`, `$1,045.00`) in cents; `null` otherwise. */
export function parsePrice(text: string | null): number | null {
  const match = /^(?:US\s*)?\$\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{2}))?$/.exec(text?.trim() ?? '');
  if (match?.[1] === undefined) return null;
  return Number(match[1].replaceAll(',', '')) * 100 + Number(match[2] ?? '0');
}

/** US time zones eBay shows times in (Pacific time on ebay.com), as offsets from UTC in hours. */
const ZONES: Readonly<Record<string, number>> = {
  PST: -8,
  PDT: -7,
  MST: -7,
  MDT: -6,
  CST: -6,
  CDT: -5,
  EST: -5,
  EDT: -4,
  AKST: -9,
  AKDT: -8,
  HST: -10,
  GMT: 0,
  UTC: 0,
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** eBay's time format: `Oct 25, 2026 09:12:45 PDT`, to the second. */
const EBAY_TIME = /\b([A-Z][a-z]{2}) (\d{1,2}), (\d{4}) (\d{2}):(\d{2}):(\d{2}) ([A-Z]{3,4})\b/;

/**
 * The first time in eBay's format within `text` ("Last updated on Oct 25, 2026 09:12:45 PDT"),
 * or `null` when it has none Listora can read.
 */
export function ebayTimeIn(text: string | null): Date | null {
  const match = EBAY_TIME.exec(text ?? '');
  if (match === null) return null;
  const [, month, day, year, hours, minutes, seconds, zone] = match;
  const monthIndex = MONTHS.indexOf(month ?? '');
  const offset = ZONES[zone ?? ''];
  if (monthIndex === -1 || offset === undefined) return null;
  const local = new Date(
    Date.UTC(
      Number(year),
      monthIndex,
      Number(day),
      Number(hours),
      Number(minutes),
      Number(seconds),
    ),
  );
  // Out-of-range parts (`Feb 31`, `25:00:00`) would roll over; eBay never shows those.
  if (
    local.getUTCMonth() !== monthIndex ||
    local.getUTCDate() !== Number(day) ||
    local.getUTCHours() !== Number(hours) ||
    local.getUTCMinutes() !== Number(minutes) ||
    local.getUTCSeconds() !== Number(seconds)
  ) {
    return null;
  }
  return new Date(local.getTime() - offset * 3_600_000);
}
