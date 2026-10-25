/**
 * eBay's website as the eBay automation scripts use it (docs/features/ebay-automation.md): the
 * origin, the paths of the pages they open, the shape of item numbers, and the signs of eBay's
 * own checks and private page parts that its automation profile adds to the generic ones.
 *
 * Every path here and every selector in `pages/` is Listora's model of eBay's US site. eBay's
 * seller pages are only seen through a seller's own session, so they are confirmed in the first
 * linked session (docs/features/ebay-automation.md, "Live verification"). A page that differs
 * stops the step before it sends anything, and the user gets the step as a task; fixing it is a
 * change to one page module.
 */
import type { ChallengeSigns } from '../profiles.ts';

/** eBay US. Listings are `/itm/<item number>`; the seller's own pages are Seller Hub's, `/sh/`. */
export const EBAY_SITE_URL = 'https://www.ebay.com';

/**
 * An eBay item number (`ItemID`): digits, 12 of them today. The Trading API addresses the same
 * listings by it, so a listing automated today is the same listing record once the seller
 * connects the API.
 */
export const EBAY_ITEM_ID = /^\d{9,19}$/;

/** What the listing form is opened for: a new listing, a change, or a relist of an ended one. */
export type EbayFormMode = 'AddItem' | 'ReviseItem' | 'RelistItem';

/** Paths on eBay's site, relative to its origin. */
export const EBAY_PATHS = {
  /** Seller Hub's overview, which only a logged-in seller sees. */
  overview: '/sh/ovw',
  /**
   * The listing form: a new listing in a category, or an existing listing to revise or relist
   * (its category changed to `categoryId` when one is given).
   */
  form: (mode: EbayFormMode, options: { itemId?: string; categoryId?: string | null }) => {
    const query = new URLSearchParams({ mode });
    if (options.itemId !== undefined) query.set('itemId', options.itemId);
    if (options.categoryId !== undefined && options.categoryId !== null) {
      query.set('categoryId', options.categoryId);
    }
    return `/lstng?${query.toString()}`;
  },
  /** A listing's page. */
  item: (itemId: string) => `/itm/${encodeURIComponent(itemId)}`,
  /** Ending one listing early. */
  end: (itemId: string) => `/sh/lst/end?${new URLSearchParams({ itemId }).toString()}`,
  /** Seller Hub's active listings, newest first, from the `offset`th. */
  active: (offset: number) => `/sh/lst/active${offset > 0 ? `?offset=${String(offset)}` : ''}`,
  /** Seller Hub's sold listings, newest first, from the `offset`th. */
  sold: (offset: number) => `/sh/lst/sold${offset > 0 ? `?offset=${String(offset)}` : ''}`,
} as const;

/** The item number in a path that opens a listing (`/itm/1234567890`), else `null`. */
export function itemIdFromPath(path: string): string | null {
  const id = /^\/itm\/(?:[^/]+\/)?(\d+)\/?$/.exec(path)?.[1];
  return id !== undefined && EBAY_ITEM_ID.test(id) ? id : null;
}

/**
 * eBay's own signs of a page automation must stop at, on top of the generic ones
 * (safety/challenges.ts, which already know hCaptcha's and reCAPTCHA's frames and widgets,
 * "Pardon Our Interruption" and the other bot-check titles, a 403, and the wording of
 * verification-code steps).
 */
export const EBAY_CHALLENGE_SIGNS: ChallengeSigns = {
  // eBay's sign-in pages (on signin.ebay.com, and on the site's own path): the session no
  // longer works. Its older sign-in page (`/ws/eBayISAPI.dll?SignIn`) shows a password field.
  loginPaths: [/^\/(signin|sign-in|login|register)(\/|$)/i],
  // Sign-in checks: a code by text or email, a passkey or authenticator step, "verify it's you".
  verificationPaths: [
    /^\/(verify|verification|two-factor|2fa|otp|challenge|mfa)(\/|$)/i,
    /^\/signin\/.*\b(mfa|otp|verify|verification|challenge|2fa|passkey)\b/i,
  ],
  // eBay's security check ("Please verify yourself to continue", with a CAPTCHA).
  botCheckPaths: [/^\/splashui\/(challenge|captcha)(\/|$)/i],
  challengeSelectors: [],
};

/**
 * Parts of eBay's pages a failure screenshot blacks out besides every form field: buyers' user
 * ids and addresses on sold listings, messages, and the seller's own user id.
 */
export const EBAY_PRIVATE_SELECTORS = [
  '[data-testid="buyer"]',
  '[data-testid="shipping-address"]',
  '[data-testid="messages"]',
  '[data-testid="seller-user-id"]',
] as const;
