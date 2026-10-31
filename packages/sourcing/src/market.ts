/**
 * Marketplace comparisons (docs/features/thrift-scan.md, "Marketplace comparisons"): the
 * public search results a marketplace shows a logged-out visitor, matched to the scanned item
 * and reduced to counts and quartiles: asking prices of listings for sale, and sold prices where
 * the marketplace shows a visitor sold listings (Depop never does). Pure: the phone's comparison reader
 * runs it on what it read, and only its numbers ever leave the phone (never a listing, a
 * seller, or a photo).
 *
 * A brand alone is never a match: one brand sells very different items, so a listing must be
 * the item's brand **and** its item type, and the tighter levels add the exact model or line and
 * the size where the scan knows them.
 */
import { brandKey } from './brand.ts';
import { sizeBucket } from './size.ts';
import { quartiles, type PriceQuartiles } from './stats.ts';

/** One listing as a marketplace's public search shows it. */
export interface MarketListing {
  /** What a buyer pays for it now (for sale) or paid (sold), in US cents. */
  readonly priceCents: number;
  readonly sold: boolean;
  readonly brand: string | null;
  /** The marketplace's own product type (Depop's `jeans`), when it names one. */
  readonly productType: string | null;
  readonly sizes: readonly string[];
  /** The listing's own words (its title or description), for the model and the type. */
  readonly text: string;
  /** When it sold (a sold listing) or last changed (one for sale), when the marketplace says. */
  readonly at: Date | null;
}

/** The scanned item, as the comparisons match it. */
export interface MarketTarget {
  readonly brand: string;
  /** The marketplace's product types the item may be (any of them); empty to match by words. */
  readonly productTypes: readonly string[];
  /** Words its type goes by ("jeans", "denim"), for a listing that names no product type. */
  readonly typeWords: readonly string[];
  /** The exact model or line ("501"), when the scan read one. */
  readonly model: string | null;
  readonly sizeLabel: string | null;
}

/**
 * How closely the comparisons match the item, tightest first. Every level is the brand and the
 * item type; `model` adds the exact model or line, `size` the size.
 */
export const MARKET_MATCH_LEVELS = ['model_and_size', 'model', 'type_and_size', 'type'] as const;
export type MarketMatchLevel = (typeof MARKET_MATCH_LEVELS)[number];

/** Fewest listings (sold, else for sale) a level needs before a looser one is tried. */
export const MIN_MARKET_MATCHES = 5;

/** What the phone sends of a marketplace's comparisons: numbers only. */
export interface MarketStats {
  /** The level the counts match at; `null` when nothing matched the brand and type. */
  readonly level: MarketMatchLevel | null;
  /** Matching sold listings' prices, outliers left out; absent with none. */
  readonly sold?: PriceQuartiles & {
    /** How many days back the oldest of them sold, when the marketplace dates them. */
    readonly windowDays: number | null;
  };
  /** Matching listings' asking prices for sale now, outliers left out; absent with none. */
  readonly forSale?: PriceQuartiles;
  /** Listings the searches returned, before matching. */
  readonly read: { readonly sold: number; readonly forSale: number };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The words of a text, lowercase, accents and punctuation dropped. */
function words(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '');
}

/** Whether `text` has the phrase `phrase` as whole words, in order. */
function hasPhrase(text: readonly string[], phrase: string): boolean {
  const wanted = words(phrase);
  if (wanted.length === 0) return false;
  for (let start = 0; start + wanted.length <= text.length; start += 1) {
    if (wanted.every((word, offset) => text[start + offset] === word)) return true;
  }
  return false;
}

/** A word, its plural `s` dropped, so "jeans" and "jean" or "hoodies" and "hoodie" agree. */
function stem(word: string): string {
  return word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
}

interface Matched {
  readonly listing: MarketListing;
  readonly model: boolean;
  readonly size: boolean;
}

/** The listings of the item's brand and type, and whether each is its model and its size. */
function matched(listings: readonly MarketListing[], target: MarketTarget): Matched[] {
  const brand = brandKey(target.brand);
  if (brand === undefined) return [];
  const types = new Set(target.productTypes);
  const typeStems = new Set(target.typeWords.flatMap(words).map(stem));
  const size = sizeBucket(target.sizeLabel);
  const model = target.model?.trim() ?? '';
  const out: Matched[] = [];
  for (const listing of listings) {
    if (!Number.isSafeInteger(listing.priceCents) || listing.priceCents <= 0) continue;
    if (brandKey(listing.brand) !== brand) continue;
    const text = words(listing.text);
    const sameType =
      listing.productType !== null && types.size > 0
        ? types.has(listing.productType)
        : text.some((word) => typeStems.has(stem(word)));
    if (!sameType) continue;
    out.push({
      listing,
      model: model !== '' && hasPhrase(text, model),
      size: size !== null && listing.sizes.some((one) => sizeBucket(one) === size),
    });
  }
  return out;
}

function atLevel(found: readonly Matched[], level: MarketMatchLevel): MarketListing[] {
  return found
    .filter((one) => {
      switch (level) {
        case 'model_and_size':
          return one.model && one.size;
        case 'model':
          return one.model;
        case 'type_and_size':
          return one.size;
        case 'type':
          return true;
      }
    })
    .map((one) => one.listing);
}

/**
 * The prices with outliers left out (outside 1.5 times the interquartile range past the
 * quartiles, from 5 prices up: a "$1 to trade" or a "$500 rare" listing must not move a range).
 */
export function withoutOutliers(prices: readonly number[]): number[] {
  if (prices.length < 5) return [...prices];
  const q = quartiles(prices);
  if (q === undefined) return [];
  const spread = q.highCents - q.lowCents;
  const low = q.lowCents - 1.5 * spread;
  const high = q.highCents + 1.5 * spread;
  return prices.filter((price) => price >= low && price <= high);
}

/**
 * The comparisons of one marketplace: the tightest level with at least `minMatches` sold
 * listings, or, where the marketplace shows no sold ones, listings for sale (with none that
 * tight, the tightest with any), and its sold and asking quartiles without outliers.
 */
export function marketStats(
  listings: readonly MarketListing[],
  target: MarketTarget,
  now: Date,
  options: { readonly minMatches?: number } = {},
): MarketStats {
  const minMatches = options.minMatches ?? MIN_MARKET_MATCHES;
  const found = matched(listings, target);
  const read = {
    sold: listings.filter((listing) => listing.sold).length,
    forSale: listings.filter((listing) => !listing.sold).length,
  };
  const anySold = found.some((one) => one.listing.sold);
  const counted = (level: MarketMatchLevel) =>
    atLevel(found, level).filter((listing) => listing.sold === anySold).length;
  const level =
    MARKET_MATCH_LEVELS.find((candidate) => counted(candidate) >= minMatches) ??
    MARKET_MATCH_LEVELS.find((candidate) => counted(candidate) > 0) ??
    null;
  if (level === null) return { level: null, read };
  const chosen = atLevel(found, level);
  const sold = chosen.filter((listing) => listing.sold);
  const soldPrices = quartiles(withoutOutliers(sold.map((listing) => listing.priceCents)));
  const forSalePrices = quartiles(
    withoutOutliers(chosen.filter((listing) => !listing.sold).map((listing) => listing.priceCents)),
  );
  const ages = sold.flatMap((listing) =>
    listing.at === null ? [] : [Math.max(0, (now.getTime() - listing.at.getTime()) / DAY_MS)],
  );
  const dated = ages.length === sold.length && sold.length > 0;
  return {
    level,
    ...(soldPrices === undefined
      ? {}
      : { sold: { ...soldPrices, windowDays: dated ? Math.ceil(Math.max(...ages)) : null } }),
    ...(forSalePrices === undefined ? {} : { forSale: forSalePrices }),
    read,
  };
}

/** How the item sells against the competition: the household's pace against live supply. */
export const MARKET_DEMANDS = ['strong', 'steady', 'crowded', 'unknown'] as const;
export type MarketDemand = (typeof MARKET_DEMANDS)[number];

/** Own sales in the last 90 days that make "sells for you", and the supply that is "little". */
export const DEMAND_STRONG_OWN_SALES = 3;
export const DEMAND_LOW_SUPPLY = 50;
/** Supply that is "crowded" when the household sold at most one like it lately. */
export const DEMAND_CROWDED_SUPPLY = 200;

export interface MarketDemandRead {
  readonly demand: MarketDemand;
  /** "Sells for you, little competition", "Crowded on Depop"; only when the numbers say so. */
  readonly label?: string;
  readonly basedOn: string;
}

/**
 * The trend read (starting thresholds, to tune in the live test): the household's own sales
 * like the item in the last 90 days (`recentOwnSales`) against how many the marketplace has for
 * sale now (`supply`, its own count for the search). Strong with at least 3 recent sales and at
 * most 50 for sale; crowded with at least 200 for sale and at most one recent sale; steady
 * otherwise; unknown without a supply count.
 */
export function marketDemand(
  recentOwnSales: number,
  supply: number | null,
  marketplace: string,
): MarketDemandRead {
  if (supply === null) {
    return { demand: 'unknown', basedOn: `${marketplace} gave no count of listings for sale` };
  }
  const demand: MarketDemand =
    recentOwnSales >= DEMAND_STRONG_OWN_SALES && supply <= DEMAND_LOW_SUPPLY
      ? 'strong'
      : supply >= DEMAND_CROWDED_SUPPLY && recentOwnSales <= 1
        ? 'crowded'
        : 'steady';
  const sales = recentOwnSales === 1 ? '1 sale' : `${String(recentOwnSales)} sales`;
  return {
    demand,
    ...(demand === 'strong'
      ? { label: 'Sells for you, little competition' }
      : demand === 'crowded'
        ? { label: `Crowded on ${marketplace}` }
        : {}),
    basedOn: `Your ${sales} like it in the last 90 days; ${supply.toLocaleString('en-US')} for sale on ${marketplace} now`,
  };
}
