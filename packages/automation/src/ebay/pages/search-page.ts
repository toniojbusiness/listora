/**
 * eBay's public search results (`/sch/i.html?_nkw=<words>`), as any logged-out visitor's browser
 * reads them (docs/features/thrift-scan.md, "eBay"): the comparison read's sold search (the
 * page's own "Sold items" filter, `LH_Sold=1&LH_Complete=1`, sorted "Time: ended recently",
 * `_sop=13`) and its for-sale search (the page as it opens, "Best Match"). Each is one page load
 * of the URL the page's own filters and sort make; nothing else is sent.
 *
 * Of each result only its title, its price, and (sold) the day it sold are read, plus the
 * search's own count of results: never the seller, the photo, the item number, or where it ships.
 * Results after eBay's "Results matching fewer words" line are not the search's, and are left
 * out, as are lots and bundles, price ranges (a listing of many sizes), and sold listings whose
 * best offer was accepted (eBay shows their asking price struck through, not what they sold for).
 */
import type { MarketListing } from '@listora/sourcing/market';

import type { PageDriver } from '../../runner/types.ts';
import { absolute, changed, parsePrice, type EbaySite } from './common.ts';

const PAGE = 'search results';

/** Which of the search's two pages: sold listings, or listings for sale now. */
export type EbaySearchKind = 'sold' | 'for_sale';

/**
 * The results page, in eBay's current card layout (`s-card`) and its earlier one (`s-item`),
 * which eBay still serves to some visitors.
 */
export const EBAY_SEARCH_PAGE = {
  results: 'ul.srp-results',
  count: '.srp-controls__count-heading',
  /**
   * One selector for every part read, so one read of their classes and one of their texts come
   * back in the page's order and line up: each result, then its title, price, and caption, and
   * the "Results matching fewer words" line between results.
   */
  parts: [
    'ul.srp-results > li.s-card',
    'ul.srp-results > li.s-item',
    'ul.srp-results > li.srp-river-answer',
    'ul.srp-results > li .s-card__title',
    'ul.srp-results > li .s-item__title',
    'ul.srp-results > li .s-card__price',
    'ul.srp-results > li .s-item__price',
    'ul.srp-results > li .s-card__caption',
    'ul.srp-results > li .s-item__caption',
    'ul.srp-results > li .s-item__title--tagblock',
  ].join(', '),
} as const;

/** Results eBay shows on a page as it opens (its "Items per page" default). */
export const EBAY_SEARCH_PAGE_SIZE = 60;

/** What one of the two searches found. */
export interface EbaySearch {
  /** The results of the first page that are the search's own, read as listings. */
  readonly listings: MarketListing[];
  /** How many results the whole search has, as eBay counts them; null when it doesn't say. */
  readonly total: number | null;
  /** How many results the page showed before the fewer-words line (before any was left out). */
  readonly shown: number;
}

/** The search's results page URL, as the page's own sold filter and sort make it. */
export function ebaySearchUrl(site: EbaySite, words: string, kind: EbaySearchKind): string {
  const query = new URLSearchParams({ _nkw: words.trim() });
  if (kind === 'sold') {
    query.set('LH_Sold', '1');
    query.set('LH_Complete', '1');
    query.set('_sop', '13');
  }
  return absolute(site, `/sch/i.html?${query.toString()}`);
}

/** Loads the search's results page and reads it. */
export async function readEbaySearch(
  page: PageDriver,
  site: EbaySite,
  words: string,
  kind: EbaySearchKind,
): Promise<EbaySearch> {
  await page.goto(ebaySearchUrl(site, words, kind));
  if (!(await page.exists(EBAY_SEARCH_PAGE.results))) {
    // A search with no results at all shows no list, only its count ("0 results found").
    const total = resultCount(await page.text(EBAY_SEARCH_PAGE.count));
    if (total === 0) return { listings: [], total: 0, shown: 0 };
    throw changed(PAGE, `has no results (${EBAY_SEARCH_PAGE.results})`);
  }
  const classes = await page.attributes(EBAY_SEARCH_PAGE.parts, 'class');
  const texts = await page.texts(EBAY_SEARCH_PAGE.parts);
  if (classes.length !== texts.length) throw changed(PAGE, 'changed while it was read');
  const results = groupResults(classes, texts);
  const listings = results.flatMap((result) => {
    const listing = listingOf(result, kind);
    return listing === null ? [] : [listing];
  });
  return {
    listings,
    total: resultCount(await page.text(EBAY_SEARCH_PAGE.count)),
    shown: results.length,
  };
}

/** One result's parts, as the page shows them. */
interface Result {
  readonly text: string;
  readonly title: string | null;
  readonly price: string | null;
  readonly captions: readonly string[];
}

/**
 * The page's parts, in its order, into results: each result's own title, first price, and
 * captions, up to the "Results matching fewer words" line.
 */
export function groupResults(
  classes: readonly (string | null)[],
  texts: readonly string[],
): Result[] {
  const results: {
    text: string;
    title: string | null;
    price: string | null;
    captions: string[];
  }[] = [];
  for (const [index, names] of classes.entries()) {
    const role = roleOf(names ?? '');
    const text = texts[index] ?? '';
    if (role === 'fewer_words') break;
    if (role === 'result') {
      results.push({ text, title: null, price: null, captions: [] });
      continue;
    }
    const current = results.at(-1);
    if (current === undefined) continue;
    if (role === 'title') current.title ??= text;
    else if (role === 'price') current.price ??= text;
    else if (role === 'caption') current.captions.push(text);
  }
  return results;
}

type Role = 'result' | 'fewer_words' | 'title' | 'price' | 'caption' | 'other';

function roleOf(classAttribute: string): Role {
  const names = new Set(classAttribute.split(/\s+/));
  if (names.has('srp-river-answer')) {
    // The line before results that match only some of the words (and other answers eBay puts
    // between results, such as related searches, which end nothing).
    return [...names].some((name) => name.includes('REWRITE_START')) ? 'fewer_words' : 'other';
  }
  if (names.has('s-card') || names.has('s-item')) return 'result';
  if (names.has('s-card__title') || names.has('s-item__title')) return 'title';
  if (names.has('s-card__price') || names.has('s-item__price')) return 'price';
  if (
    names.has('s-card__caption') ||
    names.has('s-item__caption') ||
    names.has('s-item__title--tagblock')
  ) {
    return 'caption';
  }
  return 'other';
}

/** Words that make a result many items, or no item at all. */
const LOT = /\b(lots?|bundles?|bulk|wholesale|bale)\b/i;
/** What eBay adds to a title for screen readers and new listings. */
const TITLE_NOISE = [/^new listing\s*/i, /\s*opens in a new window or tab\s*$/i];
/** eBay's placeholder result that is no listing. */
const PLACEHOLDER_TITLES = new Set(['shop on ebay']);

/** A result as a listing; `null` for one the comparisons must not count. */
function listingOf(result: Result, kind: EbaySearchKind): MarketListing | null {
  let title = (result.title ?? '').replace(/\s+/g, ' ').trim();
  for (const noise of TITLE_NOISE) title = title.replace(noise, '');
  if (title === '' || PLACEHOLDER_TITLES.has(title.toLowerCase())) return null;
  if (LOT.test(title)) return null;
  const priceCents = parsePrice((result.price ?? '').replace(/\s+/g, ' '));
  if (priceCents === null) return null;
  const sold = kind === 'sold';
  if (sold && /best offer accepted/i.test(result.text)) return null;
  const at = sold ? soldDay(result.captions) : null;
  if (sold && at === null) return null;
  return {
    priceCents,
    sold,
    brand: null,
    productType: null,
    sizes: titleSizes(title),
    text: title,
    at,
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The day a sold result sold ("Sold  Oct 28, 2026"), at noon UTC; `null` when it shows none. */
export function soldDay(captions: readonly string[]): Date | null {
  for (const caption of captions) {
    const match = /\bSold\s+([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})\b/.exec(caption);
    if (match === null) continue;
    const month = MONTHS.indexOf(match[1] ?? '');
    const day = Number(match[2]);
    if (month === -1) continue;
    const date = new Date(Date.UTC(Number(match[3]), month, day, 12));
    if (date.getUTCDate() === day) return date;
  }
  return null;
}

/** Letter sizes a title names without "size" before them (one-letter ones need it). */
const LETTER_SIZE = /\b(XXS|XS|XL|XXL|XXXL|[2-5]XL|small|medium|large|x-large|xx-large)\b/gi;

/**
 * The sizes a title names: "Size 32", "Sz M", "W32 L30" and "32x30" (a waist and length, also
 * as the waist alone), and letter sizes.
 */
export function titleSizes(title: string): string[] {
  const sizes = new Set<string>();
  for (const match of title.matchAll(/\b(?:size|sz)\.?\s*:?\s*([a-z0-9]+(?:[./][0-9]+)?)\b/gi)) {
    if (match[1] !== undefined) sizes.add(match[1]);
  }
  for (const match of title.matchAll(/\bW\s?(\d{2})\s*(?:x\s*)?L\s?(\d{2})\b/gi)) {
    sizes.add(`${match[1] ?? ''}x${match[2] ?? ''}`).add(match[1] ?? '');
  }
  for (const match of title.matchAll(/\b(\d{2})\s?[x×]\s?(\d{2})\b/gi)) {
    sizes.add(`${match[1] ?? ''}x${match[2] ?? ''}`).add(match[1] ?? '');
  }
  for (const match of title.matchAll(LETTER_SIZE)) {
    if (match[1] !== undefined) sizes.add(match[1]);
  }
  sizes.delete('');
  return [...sizes];
}

/** The search's count of results ("1,234 results for ...", "1,000+ results"); null without. */
export function resultCount(text: string | null): number | null {
  const match = /(\d{1,3}(?:,\d{3})+|\d+)\+?\s+results?\b/i.exec(text ?? '');
  if (match?.[1] === undefined) return null;
  return Number(match[1].replaceAll(',', ''));
}
