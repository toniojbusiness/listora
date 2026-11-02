/**
 * The pages a web-grounded answer rests on (the scan's web research and its brand pulse): an
 * address as the searches returned it, its site, and the text the card shows, cut to fit.
 */
import type { WebSource } from '@listora/ai';

/** Words that would call web info sales: it is never sold prices. */
export const SOLD_WORDS = /\b(sold|comps?|comparables?)\b/i;

/** A page the research rests on, by its address and the site's name. */
export interface ResearchSource {
  readonly url: string;
  /** The site, "patagonia.com". */
  readonly site: string;
}

/**
 * The page at an address, when it is one of the pages the searches returned (by its address,
 * without `www.`, a trailing slash, or a fragment); undefined for any other address, so nothing
 * is shown on a page the model made up.
 */
export function returnedPage(
  found: readonly WebSource[],
): (address: string) => ResearchSource | undefined {
  const returned = new Set(found.map((page) => normalizeUrl(page.url)));
  return (address) => {
    const normalized = normalizeUrl(address);
    if (normalized === '' || !returned.has(normalized)) return undefined;
    const site = siteOf(address);
    return site === undefined ? undefined : { url: address, site };
  };
}

/** The text cut to at most `max` characters, at a word, with an ellipsis when cut. */
export function clipped(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const room = trimmed.slice(0, max - 1);
  const atWord = room.lastIndexOf(' ');
  return `${(atWord > max / 2 ? room.slice(0, atWord) : room).trimEnd()}…`;
}

function normalizeUrl(address: string): string {
  try {
    const parsed = new URL(address.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    parsed.hash = '';
    return `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname.replace(/\/$/, '')}${parsed.search}`;
  } catch {
    return '';
  }
}

function siteOf(address: string): string | undefined {
  try {
    return new URL(address).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

export function dedupeSites(sources: readonly ResearchSource[]): ResearchSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (seen.has(source.site)) return false;
    seen.add(source.site);
    return true;
  });
}
