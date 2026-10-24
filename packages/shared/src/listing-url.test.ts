import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseListingUrl, type ListingUrlMarketplace } from './listing-url.ts';

/** The fixture file the iOS parser's tests read too. */
interface Fixtures {
  listings: {
    note: string;
    url: string;
    marketplace: ListingUrlMarketplace;
    listingId: string | null;
    canonicalUrl: string;
  }[];
  notListings: { note: string; url: string; marketplace: ListingUrlMarketplace }[];
  unsupported: { note: string; url: string }[];
}

const fixtures = JSON.parse(
  readFileSync(new URL('../fixtures/listing-urls.json', import.meta.url), 'utf8'),
) as Fixtures;

describe('parseListingUrl', () => {
  it('covers every marketplace with full and short listing URLs', () => {
    for (const marketplace of ['ebay', 'depop', 'poshmark', 'mercari'] as const) {
      const cases = fixtures.listings.filter((entry) => entry.marketplace === marketplace);
      expect(cases.some((entry) => entry.listingId !== null)).toBe(true);
      expect(cases.some((entry) => entry.listingId === null)).toBe(true);
    }
  });

  it.each(fixtures.listings)('reads $note', ({ url, marketplace, listingId, canonicalUrl }) => {
    expect(parseListingUrl(url)).toEqual({ kind: 'listing', marketplace, listingId, canonicalUrl });
  });

  it.each(fixtures.listings)('keeps $note stable when parsed again', ({ canonicalUrl }) => {
    const parsed = parseListingUrl(canonicalUrl);
    expect(parsed.kind === 'listing' && parsed.canonicalUrl).toBe(canonicalUrl);
  });

  it.each(fixtures.notListings)('knows $note is not a listing', ({ url, marketplace }) => {
    expect(parseListingUrl(url)).toEqual({ kind: 'not_listing', marketplace });
  });

  it.each(fixtures.unsupported)('rejects $note', ({ url }) => {
    expect(parseListingUrl(url)).toEqual({ kind: 'unsupported' });
  });
});
