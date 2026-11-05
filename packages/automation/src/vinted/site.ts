/**
 * Vinted's US website as the Vinted automation scripts use it (docs/features/vinted.md): the
 * origin, the paths of the pages they open, the shape of member ids, Vinted's pace, and the
 * signs of Vinted's own checks and private page parts that its automation profile adds to the
 * generic ones.
 *
 * Every path here and every selector in `pages/` is Listora's model of Vinted's pages, not yet
 * read on a signed-in session: the read-only mapping of Vinted's pages (Vinted plan M2,
 * `recordings/`) and the first linked session on the test account confirm them. A page that
 * differs stops the step before it reads anything wrong, and a check says it could not read
 * Vinted; fixing it is a change to one page module.
 */
import type { ChallengeSigns, PacingSettings, RunLimits } from '../profiles.ts';

/**
 * Vinted US. Member pages are `/member/<id>-<login>`; the seller's own settings are under
 * `/settings/`.
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
} as const;

/** A member page's path: `/member/<numeric id>` with the member's login after a dash. */
const MEMBER_PATH = /^\/member\/(\d{1,20})(?:-([^/?#]+))?\/?$/;

/**
 * The member a profile link names: Vinted's numeric member id and the login in its slug (`null`
 * when the link carries none), else `null` for any other path (a page under `/member/` that is
 * not a member, such as the sign-in chooser).
 */
export function memberFromPath(path: string): { id: string; login: string | null } | null {
  const match = MEMBER_PATH.exec(path);
  if (match?.[1] === undefined) return null;
  const slug = match[2];
  let login: string | null = null;
  if (slug !== undefined) {
    try {
      login = decodeURIComponent(slug);
    } catch {
      login = null;
    }
  }
  return { id: match[1], login };
}

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
    /^\/(verify|verification|two-factor|2fa|otp|challenge)(\/|$)/i,
    /^\/member\/(verification|verify|two_factor|2fa)(\/|$)/i,
    /^\/(identity|id-verification|kyc)(\/|$)/i,
  ],
  botCheckPaths: [],
  // DataDome's challenge container, should one be drawn in the page rather than in its frame.
  challengeSelectors: ['#ddChallengeContainer', 'iframe[src*="captcha-delivery.com"]'],
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
