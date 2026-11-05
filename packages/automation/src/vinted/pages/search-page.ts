/**
 * Vinted's public search (`/catalog?search_text=<words>`), as any logged-out visitor's browser
 * reads it (docs/features/thrift-scan.md, "Vinted"): one page load of the URL Vinted's own search
 * bar and pagination links make, nothing else sent. Read live on 2026-11-05 in a fresh browser
 * context with no cookies (through `market-pace.sh vinted`): Vinted's server draws the first 96
 * results into the document, the most relevant first, with the search's count above them ("500+
 * results.").
 *
 * **Vinted shows a visitor no sold listings**: its catalog lists only items for sale and has no
 * sold filter. So the read is of asking prices, as Depop's.
 *
 * Each result is Vinted's item box (`product-item-id-<id>`): its brand (`--description-title`),
 * its size and condition (`--description-subtitle`, `W32 · Very good`), its price
 * (`--price-text`, the item's own, without the buyer's Vinted fee), and its title (the overlay
 * link's `title`, `<title>, Brand: ..., Condition: ..., Size: ..., 18.00 $, 19.60 $`). Only those
 * are read: never the seller, the photos, the link, or the favourites.
 */
import type { MarketListing } from '@listora/sourcing/market';

import { PageChangedError } from '../../runner/errors.ts';
import type { PageDriver } from '../../runner/types.ts';

const PAGE = 'search results';

/** The site a read runs against: Vinted's origin, or a stand-in's. */
export interface VintedSite {
  readonly origin: string;
}

/** An item box of the search's grid (its parts' test ids add `--<part>` to its own). */
const CARD = '[data-testid="grid-item"] [data-testid^="product-item-id-"]:not([data-testid*="--"])';

/** The parts of an item box Listora reads, by the suffix of their test ids. */
const PARTS = ['overlay-link', 'description-title', 'description-subtitle', 'price-text'] as const;
type Part = (typeof PARTS)[number];

export const VINTED_SEARCH_PAGE = {
  card: CARD,
  /**
   * One selector for every part read, so one read of their test ids, one of their titles, and
   * one of their texts come back in the page's order and line up: each box, then its parts.
   */
  parts: [CARD, ...PARTS.map((part) => `${CARD} [data-testid$="--${part}"]`)].join(', '),
  /** The line above the results with the search's count ("500+ results."). */
  count: '.web_ui__Text__subtitle',
} as const;

/** What the search found. */
export interface VintedSearch {
  /** The boxes of the first page, read as listings for sale. */
  readonly listings: MarketListing[];
  /**
   * How many results the search has, as Vinted counts them: its "500+" is 500 (at least);
   * null when the page doesn't say.
   */
  readonly total: number | null;
  /** How many boxes the page showed (before any was left out). */
  readonly shown: number;
}

/** The search page's URL, as Vinted's own search bar and pagination links make it. */
export function vintedSearchUrl(site: VintedSite, words: string): string {
  return `${site.origin}/catalog?search_text=${encodeURIComponent(words.trim())}`;
}

/** Loads the search page and reads its results. */
export async function readVintedSearch(
  page: PageDriver,
  site: VintedSite,
  words: string,
): Promise<VintedSearch> {
  await page.goto(vintedSearchUrl(site, words));
  try {
    await page.waitFor(CARD, 'attached');
  } catch {
    // No results: the page must say so in its count, else it is not a page Listora knows.
    if (!(await page.exists(CARD))) {
      const total = searchTotal(await page.texts(VINTED_SEARCH_PAGE.count));
      if (total === 0) return { listings: [], total: 0, shown: 0 };
      throw changed(`has no results (${CARD})`);
    }
  }
  const parts = VINTED_SEARCH_PAGE.parts;
  const roles = await page.attributes(parts, 'data-testid');
  const titles = await page.attributes(parts, 'title');
  const texts = await page.texts(parts);
  if (new Set([roles.length, titles.length, texts.length]).size !== 1) {
    throw changed('changed while it was read');
  }
  const cards = groupCards(roles, { titles, texts });
  const listings = cards.flatMap((card) => {
    const listing = listingOf(card);
    return listing === null ? [] : [listing];
  });
  return {
    listings,
    total: searchTotal(await page.texts(VINTED_SEARCH_PAGE.count)),
    shown: cards.length,
  };
}

/** One item box's parts, as the page shows them. */
export interface VintedCard {
  /** The overlay link's title: the listing's title, then its brand, condition, size, prices. */
  readonly label: string | null;
  readonly brand: string | null;
  /** `W32 · Very good`, `S / US 4-6 · New with tags`, or the condition alone. */
  readonly subtitle: string | null;
  readonly price: string | null;
}

/** The page's parts, in its order, into boxes: each box's own first of each part. */
export function groupCards(
  roles: readonly (string | null)[],
  values: { readonly titles: readonly (string | null)[]; readonly texts: readonly string[] },
): VintedCard[] {
  const cards: {
    label: string | null;
    brand: string | null;
    subtitle: string | null;
    price: string | null;
  }[] = [];
  for (const [index, role] of roles.entries()) {
    const part = partOf(role);
    if (part === 'card') {
      cards.push({ label: null, brand: null, subtitle: null, price: null });
      continue;
    }
    const current = cards.at(-1);
    if (current === undefined || part === null) continue;
    const text = values.texts[index] ?? '';
    switch (part) {
      case 'overlay-link':
        current.label ??= values.titles[index] ?? null;
        break;
      case 'description-title':
        current.brand ??= text;
        break;
      case 'description-subtitle':
        current.subtitle ??= text;
        break;
      case 'price-text':
        current.price ??= text;
        break;
    }
  }
  return cards;
}

/** Which part a test id names: the box itself, one of `PARTS`, or another (`null`). */
function partOf(role: string | null): 'card' | Part | null {
  const match = /^product-item-id-\d+(?:--(.+))?$/.exec(role ?? '');
  if (match === null) return null;
  if (match[1] === undefined) return 'card';
  return (PARTS as readonly string[]).includes(match[1]) ? (match[1] as Part) : null;
}

/** Words that make a listing many items. */
const LOT = /\b(lots?|bundles?|bulk|wholesale|bale)\b/i;

/** A box as a listing for sale; `null` for one the comparisons must not count. */
export function listingOf(card: VintedCard): MarketListing | null {
  const title = cardTitle(card.label);
  if (title === '' || LOT.test(title)) return null;
  const priceCents = parsePrice(card.price);
  if (priceCents === null) return null;
  const brand = card.brand?.replace(/\s+/g, ' ').trim() ?? '';
  return {
    priceCents,
    sold: false,
    // A box without a brand is matched by its title's words, as eBay's titles are.
    brand: brand === '' ? null : brand,
    productType: null,
    sizes: cardSizes(card.subtitle),
    text: title,
    // Vinted shows a visitor no listing date.
    at: null,
  };
}

/**
 * The listing's own title out of the overlay link's title, without the brand, condition, size,
 * and prices Vinted adds after it (`Levis 501 90s, Brand: Levi's, Condition: Very good, Size: W28,
 * 18.00 $, 19.60 $` is `Levis 501 90s`); empty when there is none.
 */
export function cardTitle(label: string | null): string {
  let shown = (label ?? '').replace(/\s+/g, ' ').trim();
  const cut = [', Brand: ', ', Condition: ', ', Size: ']
    .map((marker) => shown.lastIndexOf(marker))
    .find((index) => index > 0);
  if (cut !== undefined) return shown.slice(0, cut).trim();
  // No details after it: only the prices to drop.
  while (/, [\d.,]+ \$$/.test(shown)) shown = shown.replace(/, [\d.,]+ \$$/, '');
  return shown.trim();
}

/** Cents from a price as Vinted shows it: `$18.00`, `$1,250.00`, or `$18`. `null` otherwise. */
export function parsePrice(shown: string | null): number | null {
  const match = /^\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?$/.exec(shown?.trim() ?? '');
  if (match?.[1] === undefined) return null;
  return Number(match[1].replaceAll(',', '')) * 100 + Number(match[2] ?? '0');
}

/**
 * A box's sizes as the comparisons match them, out of its subtitle (the size, then the
 * condition, `·` between): `W32` is `W32` and `32`; `S / US 4-6` is `S`, `US 4-6`, and `4-6`;
 * Vinted's `Other` and a subtitle with only the condition are none.
 */
export function cardSizes(subtitle: string | null): string[] {
  const parts = (subtitle ?? '')
    .split('·')
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part !== '');
  if (parts.length < 2) return [];
  const shown = parts.slice(0, -1).join(' · ');
  if (/^other$/i.test(shown)) return [];
  const sizes = new Set([shown]);
  for (const one of shown.split('/').map((part) => part.trim())) {
    if (one === '') continue;
    sizes.add(one);
    const us = /^US\s+(.+)$/i.exec(one)?.[1];
    if (us !== undefined) sizes.add(us.trim());
  }
  const waist = /^W(\d{2})$/i.exec(shown)?.[1];
  if (waist !== undefined) sizes.add(waist);
  return [...sizes];
}

/** The search's count out of the line above its results: `500+ results.` is 500; else `null`. */
export function searchTotal(lines: readonly string[]): number | null {
  for (const line of lines) {
    const match = /^\s*(\d{1,3}(?:,\d{3})+|\d+)\+?\s+results?\b/i.exec(line);
    if (match?.[1] !== undefined) return Number(match[1].replaceAll(',', ''));
  }
  return null;
}

/** The failure for a Vinted page that is not as the read expects. */
function changed(problem: string): PageChangedError {
  return new PageChangedError(`Vinted's ${PAGE} ${problem}.`);
}
