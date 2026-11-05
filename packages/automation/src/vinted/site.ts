/**
 * Vinted's US website as the Vinted automation scripts use it (docs/features/vinted.md): the
 * origin, the paths of the pages they open, the shape of member ids, Vinted's pace, and the
 * signs of Vinted's own checks and private page parts that its automation profile adds to the
 * generic ones.
 *
 * The settings page, its header's user menu, and the web API's current member, wardrobe, and
 * sold orders were read on the test account's signed-in session (2026-11-05, read-only); the
 * rest of `pages/` is still Listora's model of Vinted's pages, which the read-only mapping
 * (Vinted plan M2, `recordings/`) confirms. A page that differs stops the step before it reads
 * anything wrong, and a check says it could not read Vinted; fixing it is a change to one page
 * module.
 */
import type { ChallengeSigns, PacingSettings, RunLimits } from '../profiles.ts';

/**
 * Vinted US. Member pages are `/member/<id>`; the seller's own settings are under `/settings/`.
 */
export const VINTED_SITE_URL = 'https://www.vinted.com';

/**
 * Vinted's sign-in page, which the app opens to link the seller's account: its "Sign up | Log
 * in" chooser, which goes back to the home page once the seller signed in.
 */
export const VINTED_LOGIN_PATH = '/member/signup/select_type';

/** Paths on Vinted's site, relative to its origin. */
export const VINTED_PATHS = {
  /** The seller's own profile settings: only a signed-in member sees it. */
  account: '/settings/profile',
  /**
   * The upload form ("Sell an item | Vinted"), which posts a new listing: read on the test
   * account (2026-11-05, Vinted plan M2's read of the bare form, nothing typed or sent).
   */
  upload: '/items/new',
  /** A listing's edit form: the upload form, filled with the listing (modeled). */
  edit: (id: string) => `/items/${encodeURIComponent(id)}/edit`,
} as const;

/**
 * The reads Vinted's own pages make from its same-origin web API (`/api/v2/`), which the session
 * check and the listings and orders reads make the same way (`pages/api.ts`). The current
 * member, the wardrobe, and the sold orders answered on the test account (2026-11-05); the item
 * and transaction reads are modeled until the mapping (Vinted plan M2) records them.
 */
export const VINTED_API_PATHS = {
  /** The member signed in: their `id` and `login` (read on the test account, 2026-11-05). */
  currentUser: '/api/v2/users/current',
  /** A member's wardrobe: their listings, a page at a time. */
  wardrobe: (memberId: string) => `/api/v2/wardrobe/${encodeURIComponent(memberId)}/items`,
  /** One item, with its description, photos, and details. */
  item: (id: string) => `/api/v2/items/${encodeURIComponent(id)}`,
  /** The signed-in member's own orders (`type=sold`: the ones they sold). */
  myOrders: '/api/v2/my_orders',
  /** One transaction (an order): its items, price, and status. */
  transaction: (id: string) => `/api/v2/transactions/${encodeURIComponent(id)}`,
} as const;

/** An item's page path: `/items/<numeric id>`, a slug of its title after a dash. */
export function itemPath(id: string): string {
  return `/items/${id}`;
}

/** The item id of an item page's path (`/items/<id>` or `/items/<id>-<slug>`), else `null`. */
export function itemIdFromPath(path: string): string | null {
  const id = /^\/items\/(\d{1,20})(?:-[^/]*)?\/?$/.exec(path)?.[1];
  return id ?? null;
}

/** Vinted's ids (items, members, transactions) are numbers. */
export const VINTED_ID = /^\d{1,20}$/;

/**
 * Vinted's pace: the gentler pre-2026-10-28 pace before every action (0.45 to 1.1 s) and 5 to
 * 20 seconds between sessions, slower than the other marketplaces. Vinted's terms say it uses
 * automated tools to find accounts that break its rules, and Vinted is the newest marketplace
 * with no live run behind it yet, so its first runs go at a careful seller's pace.
 * `AUTOMATION_VINTED_PACE_MS` can still change it within the floor (settings.ts).
 */
export const VINTED_PACING: PacingSettings = {
  actionDelayMs: [450, 1_100],
  keystrokeDelayMs: [45, 130],
  sessionGapMs: [5_000, 20_000],
};

/**
 * A read-only Vinted connection (an account Listora only reads) reads gentler still: 0.6 to 1.5
 * seconds before each action, as every read-only connection keeps a slower pace than its
 * marketplace's own (docs/features/read-only.md).
 */
export const VINTED_READ_ONLY_PACING: PacingSettings = {
  ...VINTED_PACING,
  actionDelayMs: [600, 1_500],
};

/**
 * Half the runs the other marketplaces get (`DEFAULT_LIMITS`), well inside what one seller does
 * by hand.
 */
export const VINTED_LIMITS: RunLimits = { runsPerHour: 15, runsPerDay: 100 };

/**
 * Vinted's own signs of a page automation must stop at, on top of the generic ones
 * (safety/challenges.ts, which already know DataDome's challenge frames on
 * `captcha-delivery.com`, Cloudflare's interstitial, a 403, and the wording of
 * verification-code steps).
 */
export const VINTED_CHALLENGE_SIGNS: ChallengeSigns = {
  // The sign-up and sign-in pages: the session no longer works.
  loginPaths: [
    /^\/member\/(signup|login|general\/login)(\/|$)/i,
    /^\/(login|log-in|signin|sign-in|sign_in|signup|sign-up)(\/|$)/i,
  ],
  // Code and identity checks after sign-in (a code by email or text, Vinted's ID check).
  verificationPaths: [
    // Vinted's account verification before listing (an email code): picking a category on the
    // upload form sent the test account there (`/users/verification?ref_url=/items/new`,
    // 2026-11-05, Vinted plan M2).
    /^\/users\/verification(\/|$)/i,
    /^\/(verify|verification|two-factor|2fa|otp|challenge)(\/|$)/i,
    /^\/member\/(verification|verify|two_factor|2fa)(\/|$)/i,
    /^\/(identity|id-verification|kyc)(\/|$)/i,
  ],
  botCheckPaths: [],
  // DataDome's challenge container, should one be drawn in the page rather than in its frame.
  challengeSelectors: ['#ddChallengeContainer', 'iframe[src*="captcha-delivery.com"]'],
  // The web API's answer (400) to a read of the sold orders while the member has not verified
  // their account (a phone number): read on the test account, 2026-11-05.
  apiVerificationCodes: ['user_verification_required'],
};

/**
 * Parts of Vinted's pages a failure screenshot blacks out besides every form field: buyers'
 * names and addresses on orders, messages in conversations, and the member's own details on
 * their settings pages.
 */
export const VINTED_PRIVATE_SELECTORS = [
  '[data-testid*="address" i]',
  '[data-testid*="conversation" i]',
  '[data-testid*="message" i]',
  '[data-testid*="user-info" i]',
  '[data-testid*="profile" i]',
] as const;
