/**
 * Mercari's US website as the Mercari automation scripts use it (docs/mercari.md): the origin,
 * the paths of the pages they open, the shape of listing ids, and the signs of Mercari's own
 * checks and private page parts that its automation profile adds to the generic ones.
 *
 * Every path here and every selector in `pages/` is Listora's model of Mercari's pages: the
 * logged-in pages are behind Mercari's Cloudflare bot protection, which Listora never gets
 * around, so they are confirmed in the first linked session (docs/mercari.md, "Live
 * verification"). A page that differs stops the step before it sends anything, and the user
 * gets the step as a task; fixing it is a change to one page module.
 */
import type { ChallengeSigns } from '../profiles.ts';

/** Mercari US. Listing pages are `/us/item/<id>/`; the seller's own pages are under `/mypage/`. */
export const MERCARI_SITE_URL = 'https://www.mercari.com';

/** Mercari item ids: `m` and digits, for example `m12345678901`. */
export const MERCARI_ITEM_ID = /^m\d{6,20}$/;

/** The seller's listing tabs: on sale, deactivated, sold and waiting to ship, sold and done. */
export type MercariListingTab = 'active' | 'inactive' | 'in_progress' | 'sold';

/** Paths on Mercari's site, relative to its origin. */
export const MERCARI_PATHS = {
  account: '/mypage/',
  sell: '/sell/',
  item: (id: string) => `/us/item/${encodeURIComponent(id)}/`,
  edit: (id: string) => `/sell/edit/${encodeURIComponent(id)}/`,
  listings: (tab: MercariListingTab, page: number) =>
    `/mypage/listings/${tab}/${page > 1 ? `?page=${String(page)}` : ''}`,
} as const;

/** The item id in a path that opens a listing (`/us/item/m123.../`), else `null`. */
export function itemIdFromPath(path: string): string | null {
  const id = /^\/us\/item\/([^/]+)\/?$/.exec(path)?.[1];
  if (id === undefined) return null;
  const decoded = decodeURIComponent(id);
  return MERCARI_ITEM_ID.test(decoded) ? decoded : null;
}

/**
 * Mercari's own signs of a page automation must stop at, on top of the generic ones
 * (safety/challenges.ts, which already know Cloudflare's "Just a moment..." interstitial, its
 * Turnstile widget and challenge frames, a 403, and the wording of verification-code steps).
 */
export const MERCARI_CHALLENGE_SIGNS: ChallengeSigns = {
  // The login and sign-up pages: the session no longer works.
  loginPaths: [/^\/(login|log-in|signin|sign-in|sign_in|signup|sign-up|register)(\/|$)/i],
  // Code and identity checks after login (a code by text or email, an identity check).
  verificationPaths: [
    /^\/(verify|verification|two-factor|2fa|otp|challenge|mfa)(\/|$)/i,
    /^\/(login|signin)\/(verify|verification|code|mfa|otp|challenge)(\/|$)/i,
    /^\/(identity|id-verification|identity-verification)(\/|$)/i,
  ],
  // Cloudflare's Turnstile container (Cloudflare's interstitial
  // is already caught by its title, its wording, and its 403).
  botCheckPaths: [],
  challengeSelectors: ['#turnstile-wrapper'],
};

/**
 * Parts of Mercari's pages a failure screenshot blacks out besides every form field: buyers'
 * names and addresses on sold items, and messages.
 */
export const MERCARI_PRIVATE_SELECTORS = [
  '[data-testid="BuyerName"]',
  '[data-testid="ShippingAddress"]',
  '[data-testid="Messages"]',
  '[data-testid="UserName"]',
] as const;
