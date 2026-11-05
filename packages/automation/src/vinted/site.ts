/**
 * Vinted's US website as Listora reads it (docs/features/vinted.md): its origins and the signs
 * of Vinted's own checks on top of the generic ones. Only the thrift scan's logged-out
 * comparison read uses it so far (comps/vinted.ts); the seller's own pages join with Vinted's
 * automation (milestones M2 and M3).
 */
import type { ChallengeSigns } from '../profiles.ts';

/** Vinted US. Listings are `/items/<id>-<title>`; the public search is `/catalog`. */
export const VINTED_SITE_URL = 'https://www.vinted.com';

/** Vinted's own origins: a page never loads the main frame anywhere else. */
export const VINTED_ORIGINS = ['https://www.vinted.com', 'https://vinted.com'] as const;

/**
 * Vinted's own signs of a page automation must stop at, on top of the generic ones
 * (safety/challenges.ts, which already know Cloudflare's "Just a moment..." page and its
 * Turnstile, DataDome's CAPTCHA frames from captcha-delivery.com, a 403, and the wording of
 * verification-code steps): its sign-in and sign-up pages under `/member/`.
 */
export const VINTED_CHALLENGE_SIGNS: ChallengeSigns = {
  loginPaths: [
    /^\/(login|log-in|signin|sign-in|sign_in|signup|sign-up|register)(\/|$)/i,
    /^\/member\/(login|signup|sign_up|register|session)(\/|$)/i,
  ],
  verificationPaths: [
    /^\/(verify|verification|two-factor|2fa|otp|challenge)(\/|$)/i,
    /^\/member\/(verification|verify|two_factor|2fa)(\/|$)/i,
  ],
  botCheckPaths: [],
  challengeSelectors: [],
};
