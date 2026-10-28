/**
 * Poshmark's web addresses the automation adapter opens (checked logged out on 2026-10-24: the
 * listing form and the edit form send a browser without a session to `/login`, and closets are
 * public). Every URL is built on the site's origin, `https://poshmark.com` in production and the
 * fake Poshmark's in development and tests.
 */

/** Poshmark's listing ids: 24 hexadecimal characters, the end of every listing URL. */
const LISTING_ID = /^[0-9a-f]{24}$/;

export function isListingId(value: string): boolean {
  return LISTING_ID.test(value);
}

/** The listing id at the end of a listing page's path (`/listing/<title>-<id>`), if any. */
export function listingIdFromPath(path: string): string | null {
  const match = /^\/listing\/(?:.*-)?([0-9a-f]{24})\/?$/.exec(path);
  return match?.[1] ?? null;
}

/** The closet filters Poshmark's closet pages take (`availability=`). */
export type ClosetAvailability = 'all' | 'available' | 'sold_out' | 'not_for_sale';

export interface ClosetQuery {
  availability: ClosetAvailability;
  /** Searches the closet's titles (and Poshmark's other searched fields). */
  query?: string;
  /** Newest listings first (`sort_by=added_desc`); otherwise Poshmark's own order. */
  newestFirst?: boolean;
  /** The closet page to continue from: the previous page's `next_max_id`. */
  maxId?: string;
}

export class PoshmarkSite {
  readonly origin: string;

  constructor(origin: string) {
    this.origin = new URL(origin).origin;
  }

  /** The listing form: requires a logged-in seller. */
  createListing(): string {
    return `${this.origin}/create-listing`;
  }

  /** A listing's edit form: requires its seller. */
  editListing(id: string): string {
    return `${this.origin}/edit-listing/${encodeURIComponent(id)}`;
  }

  /** A listing's public page; Poshmark reads the id at the end of the path. */
  listing(id: string): string {
    return `${this.origin}/listing/${encodeURIComponent(id)}`;
  }

  /** The seller's sales (`/order/sales`, which opens the Seller Hub's sales list). */
  sales(): string {
    return `${this.origin}/order/sales`;
  }

  /** One sale's order page: requires its seller. */
  sale(orderId: string): string {
    return `${this.origin}/order/sales/${encodeURIComponent(orderId)}`;
  }

  /** The seller's active offers ("Active Offers"), as a buyer and as the seller. */
  offers(): string {
    return `${this.origin}/offers/my_offers`;
  }

  /** One offer's page, where the seller answers it. */
  offer(offerId: string): string {
    return `${this.origin}/offers/${encodeURIComponent(offerId)}`;
  }

  /** A seller's closet page. */
  closet(username: string, query: ClosetQuery): string {
    const url = new URL(`${this.origin}/closet/${encodeURIComponent(username)}`);
    url.searchParams.set('availability', query.availability);
    if (query.newestFirst === true) url.searchParams.set('sort_by', 'added_desc');
    if (query.query !== undefined) url.searchParams.set('query', query.query);
    if (query.maxId !== undefined) url.searchParams.set('max_id', query.maxId);
    return url.href;
  }
}
