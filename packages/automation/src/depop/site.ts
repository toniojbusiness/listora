/**
 * Depop's website as the Depop automation scripts use it (docs/features/depop-automation.md):
 * the origin, the paths of the pages they open, the shape of product slugs, and the signs of
 * Depop's own checks and private page parts that its automation profile adds to the generic
 * ones.
 *
 * Every path here and every selector and data key in `pages/` is Listora's model of Depop's
 * pages. Depop's logged-in pages are only seen through a seller's own session, so they are
 * confirmed in the first linked session (docs/features/depop-automation.md, "Live
 * verification"). A page that differs stops the step before it sends anything, and the user
 * gets the step as a task; fixing it is a change to one page module.
 */
import type { ChallengeSigns } from '../profiles.ts';

/** Depop. Products are `/products/<slug>/`; the seller's own pages are under `/sellinghub/`. */
export const DEPOP_SITE_URL = 'https://www.depop.com';

/**
 * A Depop product slug: the seller's username and words of the listing, lowercase and joined by
 * hyphens (`jdoe-levis-trucker-jacket`); a username may have underscores and periods
 * (`365_nails-black-and-white-nail-set`). The Selling API addresses the same products by it
 * (`/api/v1/products/by-slug/{slug}/`), so a listing automated today is still found once the
 * seller connects the API. At least one hyphen, so `/products/create/` is never a product.
 */
export const DEPOP_SLUG = /^[a-z0-9][a-z0-9._]*(?:-[a-z0-9_]+)+$/;

/** Paths on Depop's site, relative to its origin. */
export const DEPOP_PATHS = {
  /** The selling hub's home, which only a logged-in seller sees. */
  hub: '/sellinghub/',
  sell: '/products/create/',
  product: (slug: string) => `/products/${encodeURIComponent(slug)}/`,
  edit: (slug: string) => `/products/edit/${encodeURIComponent(slug)}/`,
  /** The seller's listings for sale, newest first. */
  selling: (page: number) => `/sellinghub/selling/${page > 1 ? `?page=${String(page)}` : ''}`,
  /** The seller's sold items, newest first. */
  sold: (page: number) => `/sellinghub/sold-items/${page > 1 ? `?page=${String(page)}` : ''}`,
} as const;

/** The slug in a path that opens a product (`/products/jdoe-levis-jacket/`), else `null`. */
export function slugFromPath(path: string): string | null {
  const slug = /^\/products\/([^/]+)\/?$/.exec(path)?.[1];
  if (slug === undefined) return null;
  const decoded = decodeURIComponent(slug);
  return DEPOP_SLUG.test(decoded) ? decoded : null;
}

/**
 * Depop's own signs of a page automation must stop at, on top of the generic ones
 * (safety/challenges.ts, which already know the frames of DataDome's and the other CAPTCHA
 * services, bot-check titles and wording, a 403, and the wording of verification-code steps).
 */
export const DEPOP_CHALLENGE_SIGNS: ChallengeSigns = {
  // The login and sign-up pages: the session no longer works.
  loginPaths: [/^\/(login|log-in|signin|sign-in|signup|sign-up|register)(\/|$)/i],
  // Login checks: a code by email or text, a magic link to confirm, an identity check.
  verificationPaths: [
    /^\/(verify|verification|two-factor|2fa|otp|challenge|mfa)(\/|$)/i,
    /^\/login\/(verify|verification|code|magic-link|mfa|otp|challenge)(\/|$)/i,
  ],
  botCheckPaths: [],
  challengeSelectors: [],
};

/**
 * Parts of Depop's pages a failure screenshot blacks out besides every form field: buyers'
 * names and addresses on sold items, messages, and the seller's own name.
 */
export const DEPOP_PRIVATE_SELECTORS = [
  '[data-testid="buyerName"]',
  '[data-testid="shippingAddress"]',
  '[data-testid="messages"]',
  '[data-testid="sellerUsername"]',
] as const;
