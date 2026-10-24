/**
 * Research links: searches the user opens in their own browser, signed in as themselves.
 * Listora builds the URL and nothing else; it never fetches, scrapes, or reads these pages.
 */
import type { ResearchLink } from '@listora/api-contract';

export const EBAY_SOLD_SEARCH_LABEL = 'Search eBay sold listings';
export const TERAPEAK_LABEL = 'Research on Terapeak (eBay Seller Hub)';

/** The only research link labels; the label guard rejects any other. */
export const RESEARCH_LINK_LABELS: ReadonlySet<string> = new Set([
  EBAY_SOLD_SEARCH_LABEL,
  TERAPEAK_LABEL,
]);

/** Search engines match on a few words; a longer query only narrows the results to nothing. */
export const MAX_RESEARCH_QUERY_LENGTH = 100;

export interface ResearchItem {
  readonly title?: string | undefined;
  readonly brand?: string | undefined;
  readonly productName?: string | undefined;
  readonly styleNumber?: string | undefined;
  readonly category?: string | undefined;
}

/**
 * The search words for an item: its title, or else its brand, product name, style number,
 * and category. Undefined when the item has none of them yet.
 */
export function researchQuery(item: ResearchItem): string | undefined {
  const title = clean(item.title);
  const query =
    title ??
    clean(
      [item.brand, item.productName, item.styleNumber, item.category]
        .map(clean)
        .filter((word) => word !== undefined)
        .join(' '),
    );
  if (query === undefined) return undefined;
  if (query.length <= MAX_RESEARCH_QUERY_LENGTH) return query;
  const cut = query.slice(0, MAX_RESEARCH_QUERY_LENGTH + 1);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut.slice(0, MAX_RESEARCH_QUERY_LENGTH)).trim();
}

/** The eBay sold-listings search and Terapeak for `query`; none without a query. */
export function researchLinks(query: string | undefined): ResearchLink[] {
  if (query === undefined) return [];
  const soldSearch = new URL('https://www.ebay.com/sch/i.html');
  soldSearch.search = new URLSearchParams({
    _nkw: query,
    LH_Sold: '1',
    LH_Complete: '1',
  }).toString();
  const terapeak = new URL('https://www.ebay.com/sh/research');
  terapeak.search = new URLSearchParams({
    marketplace: 'EBAY-US',
    keywords: query,
    tabName: 'SOLD',
  }).toString();
  return [
    { label: EBAY_SOLD_SEARCH_LABEL, url: soldSearch.toString() },
    { label: TERAPEAK_LABEL, url: terapeak.toString() },
  ];
}

function clean(text: string | undefined): string | undefined {
  const cleaned = text?.replace(/\s+/g, ' ').trim();
  return cleaned === undefined || cleaned === '' ? undefined : cleaned;
}
