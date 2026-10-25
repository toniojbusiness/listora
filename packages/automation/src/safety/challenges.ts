/**
 * Recognizing pages browser automation must never pass (docs/architecture.md section 1): a
 * CAPTCHA, a bot check, a login or verification step, or a page outside the marketplace's own
 * site. The page driver inspects the page after every navigation and action; the first sign
 * stops the run at once, and nothing ever tries to solve, skip, or wait out the check: the
 * connection needs relinking (the seller logs in again, as a person) and the action goes to
 * the user. The rules are deliberately broad: stopping at a page that only looks like a check
 * costs one assisted task, while acting past a real one could cost the seller their account.
 *
 * The same inspection reports pages that are not checks but still stop a run: a rate limit
 * (429) and a marketplace error (5xx), both worth retrying later.
 */
import type { ChallengeKind } from '@listora/db';
import { assertNever } from '@listora/shared';

import type { AutomationProfile } from '../profiles.ts';

/** What the page driver reads from the page after each navigation or action. */
export interface PageSignals {
  /** The main frame's URL. */
  url: string;
  /** The HTTP status of the main frame's last navigation, when there was one. */
  status: number | null;
  /** The `Retry-After` of that navigation, in seconds, when it sent one. */
  retryAfterSeconds: number | null;
  title: string;
  /**
   * Origins of the visible frames of CAPTCHA and bot-check services (`CHALLENGE_FRAME_PATTERN`).
   * Invisible ones (a score-only reCAPTCHA badge, a widget waiting hidden) are not a check yet.
   */
  challengeFrames: string[];
  /** Whether the page shows a password field (no session Listora holds ever needs one). */
  hasPasswordField: boolean;
  /** Which of `challengeSelectors(profile)` match a visible element. */
  matchedSelectors: string[];
  /** The start of the page's visible text, lowercased, for wording only check pages use. */
  text: string;
}

export type PageProblem =
  | { type: 'challenge'; kind: ChallengeKind; sign: string }
  | { type: 'rate_limited'; retryAfterMs: number | null }
  | { type: 'server_error'; status: number };

/** Frames of the CAPTCHA and bot-check services marketplaces use. */
export const CHALLENGE_FRAME_PATTERN =
  /(google\.com|recaptcha\.net)\/recaptcha\/.*\/(bframe|fallback)|(google\.com|recaptcha\.net)\/recaptcha\/.*anchor(?!.*size=invisible)|hcaptcha\.com|challenges\.cloudflare\.com|arkoselabs\.com|funcaptcha\.com|captcha-delivery\.com|perimeterx\.net|px-cdn\.net|px-captcha|hsprotect\.net|geetest\.com/i;

/** Elements of CAPTCHA widgets, on any marketplace; each counts only while visible. */
export const CHALLENGE_SELECTORS = [
  '.g-recaptcha',
  '.h-captcha',
  '.cf-turnstile',
  '#px-captcha',
  '#captcha',
  '[data-sitekey]',
  'iframe[title*="captcha" i]',
  'iframe[title*="challenge" i]',
] as const;

/** Titles of bot-check interstitials (Cloudflare, Akamai, Imperva, PerimeterX, DataDome). */
const BOT_CHECK_TITLES =
  /just a moment|attention required|access denied|are you a (human|robot)|verify(ing)? (that )?you are (a )?human|pardon our interruption|robot or human|security check|checking your browser|please wait while we verify/i;

const BOT_CHECK_TEXT =
  /(verify|confirm|prove) (that )?you('| a)re (a )?human|unusual (traffic|activity)|automated (access|requests|queries)|are you a robot|press (and|&) hold|enable javascript and cookies to continue/;

const VERIFICATION_TEXT =
  /enter the (\d-digit |verification |security |one-time )?code|we (just )?sent (you )?a (verification |security )?code|one-time (code|passcode|password)|two-factor|2-step verification/;

/**
 * The first problem the page shows, or `null` when the run may go on. Checks come in order of
 * how much they put at stake: a CAPTCHA, a bot check, a page outside the marketplace, a
 * verification step, a login page, then rate limits and errors.
 */
export function inspectPage(signals: PageSignals, profile: AutomationProfile): PageProblem | null {
  const [frame] = signals.challengeFrames;
  if (frame !== undefined) return { type: 'challenge', kind: 'captcha', sign: `frame ${frame}` };
  const [selector] = signals.matchedSelectors;
  if (selector !== undefined) {
    return { type: 'challenge', kind: 'captcha', sign: `element ${selector}` };
  }
  if (BOT_CHECK_TITLES.test(signals.title)) {
    return { type: 'challenge', kind: 'bot_check', sign: 'page title' };
  }
  if (BOT_CHECK_TEXT.test(signals.text)) {
    return { type: 'challenge', kind: 'bot_check', sign: 'page text' };
  }
  if (signals.status === 403) return { type: 'challenge', kind: 'bot_check', sign: 'status 403' };

  const url = URL.canParse(signals.url) ? new URL(signals.url) : null;
  if (url === null || (url.protocol !== 'about:' && !profile.origins.includes(url.origin))) {
    return { type: 'challenge', kind: 'unexpected_page', sign: 'origin' };
  }
  const path = url.pathname;
  if (profile.challenges.botCheckPaths.some((pattern) => pattern.test(path))) {
    return { type: 'challenge', kind: 'bot_check', sign: 'bot-check page' };
  }
  if (
    profile.challenges.verificationPaths.some((pattern) => pattern.test(path)) ||
    VERIFICATION_TEXT.test(signals.text)
  ) {
    return { type: 'challenge', kind: 'login_challenge', sign: 'verification step' };
  }
  if (
    signals.hasPasswordField ||
    profile.challenges.loginPaths.some((pattern) => pattern.test(path))
  ) {
    return { type: 'challenge', kind: 'session_rejected', sign: 'login page' };
  }

  if (signals.status === 429) {
    return {
      type: 'rate_limited',
      retryAfterMs: signals.retryAfterSeconds === null ? null : signals.retryAfterSeconds * 1000,
    };
  }
  if (signals.status !== null && signals.status >= 500) {
    return { type: 'server_error', status: signals.status };
  }
  return null;
}

/** The selectors the page driver tests for this profile. */
export function challengeSelectors(profile: AutomationProfile): string[] {
  return [...CHALLENGE_SELECTORS, ...profile.challenges.challengeSelectors];
}

/** What the seller reads when automation stopped at a check. */
export function challengeMessage(kind: ChallengeKind, name: string): string {
  switch (kind) {
    case 'captcha':
      return `${name} asked for a CAPTCHA. Listora never solves those: log in to ${name} again in the app to keep automating.`;
    case 'bot_check':
      return `${name} showed a security check. Listora stopped and never works around those: log in to ${name} again in the app to keep automating.`;
    case 'login_challenge':
      return `${name} asked to verify your login. Log in to ${name} again in the app to keep automating.`;
    case 'session_rejected':
      return `${name} logged Listora out. Log in to ${name} again in the app to keep automating.`;
    case 'unexpected_page':
      return `${name} sent Listora to a page outside ${name}. Log in to ${name} again in the app to keep automating.`;
    default:
      return assertNever(kind, 'challenge kind');
  }
}
