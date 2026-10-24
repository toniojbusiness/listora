/**
 * Recognizes a marketplace listing from its URL, for linking a listing the user shared from
 * Safari or a marketplace app. Parsing is purely textual: nothing is fetched, so a short link
 * (`posh.mk/...`) is kept as given and its listing id stays unknown (only the marketplace could
 * resolve it, and Listora does not ask).
 *
 * The iOS app has a matching parser (`ListingURL` in apps/ios/Packages/Core); both are tested
 * against `packages/shared/fixtures/listing-urls.json`, so change them together.
 */

export type ListingUrlMarketplace = 'ebay' | 'depop' | 'poshmark' | 'mercari';

export type ListingUrlParse =
  | {
      kind: 'listing';
      marketplace: ListingUrlMarketplace;
      /** The marketplace's public listing id, or null for a short link. */
      listingId: string | null;
      /** The URL to store and open: https, no query or fragment, a stable host. */
      canonicalUrl: string;
    }
  /** A page of a supported marketplace that is not a single listing (a closet, a search). */
  | { kind: 'not_listing'; marketplace: ListingUrlMarketplace }
  /** Not a supported marketplace URL at all. */
  | { kind: 'unsupported' };

interface MarketplaceUrlRule {
  marketplace: ListingUrlMarketplace;
  /** Hosts of full listing pages, lower case, matched exactly. */
  hosts: readonly string[];
  /** Reads the listing id from the path; returns the canonical URL for it. */
  listing: (path: string) => { listingId: string; canonicalUrl: string } | undefined;
  /** Hosts of the marketplace's share short links. */
  shortLinkHosts: readonly string[];
  shortLinkPath: RegExp;
}

const SHORT_CODE = /^\/[A-Za-z0-9]{4,32}\/?$/;

const RULES: readonly MarketplaceUrlRule[] = [
  {
    marketplace: 'ebay',
    hosts: ['ebay.com', 'www.ebay.com', 'm.ebay.com'],
    listing: (path) => {
      const id = /^\/itm\/(?:[^/]+\/)?([0-9]{9,19})\/?$/.exec(path)?.[1];
      return id === undefined
        ? undefined
        : { listingId: id, canonicalUrl: `https://www.ebay.com/itm/${id}` };
    },
    shortLinkHosts: ['ebay.us'],
    shortLinkPath: /^\/(?:m\/)?[A-Za-z0-9]{4,32}\/?$/,
  },
  {
    marketplace: 'poshmark',
    hosts: ['poshmark.com', 'www.poshmark.com'],
    listing: (path) => {
      const match = /^\/listing\/((?:[^/]*-)?([0-9A-Fa-f]{24}))\/?$/.exec(path);
      if (match?.[1] === undefined || match[2] === undefined) return undefined;
      return {
        listingId: match[2].toLowerCase(),
        canonicalUrl: `https://poshmark.com/listing/${match[1]}`,
      };
    },
    shortLinkHosts: ['posh.mk'],
    shortLinkPath: SHORT_CODE,
  },
  {
    marketplace: 'mercari',
    hosts: ['mercari.com', 'www.mercari.com'],
    listing: (path) => {
      const id = /^\/(?:us\/)?item\/(m[0-9]{8,14})\/?$/.exec(path)?.[1];
      return id === undefined
        ? undefined
        : { listingId: id, canonicalUrl: `https://www.mercari.com/us/item/${id}/` };
    },
    shortLinkHosts: ['merc.li'],
    shortLinkPath: SHORT_CODE,
  },
  {
    marketplace: 'depop',
    hosts: ['depop.com', 'www.depop.com'],
    listing: (path) => {
      const slug = /^\/products\/([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\/?$/.exec(path)?.[1];
      if (slug === undefined || slug.length > 200) return undefined;
      const id = slug.toLowerCase();
      return { listingId: id, canonicalUrl: `https://www.depop.com/products/${id}/` };
    },
    shortLinkHosts: ['depop.app.link'],
    shortLinkPath: SHORT_CODE,
  },
];

/** Parses a shared URL. Never throws; anything that is not a listing URL says why. */
export function parseListingUrl(input: string): ListingUrlParse {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { kind: 'unsupported' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { kind: 'unsupported' };
  // A URL with credentials or an unusual port is not one a marketplace shares.
  if (url.username !== '' || url.password !== '' || url.port !== '') return { kind: 'unsupported' };

  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  for (const rule of RULES) {
    if (rule.hosts.includes(host)) {
      const listing = rule.listing(path);
      return listing
        ? { kind: 'listing', marketplace: rule.marketplace, ...listing }
        : { kind: 'not_listing', marketplace: rule.marketplace };
    }
    if (rule.shortLinkHosts.includes(host)) {
      if (!rule.shortLinkPath.test(path)) {
        return { kind: 'not_listing', marketplace: rule.marketplace };
      }
      return {
        kind: 'listing',
        marketplace: rule.marketplace,
        listingId: null,
        canonicalUrl: `https://${host}${path.replace(/\/$/, '')}`,
      };
    }
  }
  return { kind: 'unsupported' };
}
