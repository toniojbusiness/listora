/**
 * What the browser runner knows about each automated marketplace (decision D1): its own site
 * (the only origins a session may navigate to and the only cookie domains it keeps), how
 * politely to pace actions, how many runs a seller's account may get, the marketplace's own
 * signs of a check automation must not pass, and the parts of its pages that hold personal
 * data, which screenshots black out. The per-marketplace automation adapters add their own
 * challenge signs and private selectors as they learn the sites' pages.
 */
import type { Marketplace } from '@listora/db';
import type { AutomatedMarketplace } from '@listora/marketplaces';

import { DEPOP_CHALLENGE_SIGNS, DEPOP_PRIVATE_SELECTORS } from './depop/site.ts';
import { MERCARI_CHALLENGE_SIGNS, MERCARI_PRIVATE_SELECTORS } from './mercari/site.ts';

/** A closed range of milliseconds; each wait picks uniformly inside it. */
export type DelayRange = readonly [min: number, max: number];

export interface PacingSettings {
  /** Before every click, form fill, upload, or navigation. */
  readonly actionDelayMs: DelayRange;
  /** Between keystrokes when typing (short fields only; long text is filled like a paste). */
  readonly keystrokeDelayMs: DelayRange;
  /** Between the start of one browser session for a seller and the next. */
  readonly sessionGapMs: DelayRange;
}

/** Runs (browser sessions) one seller's account may get, counted across every runner. */
export interface RunLimits {
  readonly runsPerHour: number;
  readonly runsPerDay: number;
}

/**
 * Marketplace-specific signs of a page automation must not pass, on top of the generic ones
 * every marketplace gets (challenges.ts).
 */
export interface ChallengeSigns {
  /** Main-frame paths that are the marketplace's login page: the session was rejected. */
  readonly loginPaths: readonly RegExp[];
  /** Main-frame paths of its verification steps (a code sent by email or text). */
  readonly verificationPaths: readonly RegExp[];
  /** Elements only its CAPTCHA or bot-check pages show. */
  readonly challengeSelectors: readonly string[];
}

export interface AutomationProfile {
  readonly marketplace: Marketplace;
  /** `https://poshmark.com`: a session never navigates the main frame anywhere else. */
  readonly origins: readonly string[];
  /** `poshmark.com`: the only cookies a session loads or keeps. */
  readonly cookieDomains: readonly string[];
  readonly pacing: PacingSettings;
  readonly limits: RunLimits;
  readonly challenges: ChallengeSigns;
  /** Elements screenshots black out besides every form field (names, addresses, messages). */
  readonly privateSelectors: readonly string[];
}

/** The pace of a careful person: a second or two between actions, a run every few seconds. */
export const DEFAULT_PACING: PacingSettings = {
  actionDelayMs: [800, 2500],
  keystrokeDelayMs: [60, 180],
  sessionGapMs: [5_000, 20_000],
};

/** Well inside what one busy seller does by hand. */
export const DEFAULT_LIMITS: RunLimits = { runsPerHour: 30, runsPerDay: 200 };

/**
 * The fastest pace and the most runs configuration may ask for; settings beyond them are
 * refused at startup (settings.ts), so no environment variable can make automation hurried.
 */
export const PACING_FLOOR: PacingSettings = {
  actionDelayMs: [300, 300],
  keystrokeDelayMs: [20, 20],
  sessionGapMs: [2_000, 2_000],
};
export const LIMITS_CEILING: RunLimits = { runsPerHour: 120, runsPerDay: 1_000 };

const COMMON_SIGNS: ChallengeSigns = {
  loginPaths: [/^\/(login|log-in|signin|sign-in|sign_in)(\/|$)/i],
  verificationPaths: [/^\/(verify|verification|two-factor|2fa|otp|challenge)(\/|$)/i],
  challengeSelectors: [],
};

const PROFILES: Readonly<Record<Exclude<Marketplace, 'ebay'>, AutomationProfile>> = {
  poshmark: {
    marketplace: 'poshmark',
    origins: ['https://poshmark.com', 'https://www.poshmark.com'],
    cookieDomains: ['poshmark.com'],
    pacing: DEFAULT_PACING,
    limits: DEFAULT_LIMITS,
    challenges: COMMON_SIGNS,
    privateSelectors: [],
  },
  mercari: {
    marketplace: 'mercari',
    origins: ['https://www.mercari.com', 'https://mercari.com'],
    cookieDomains: ['mercari.com'],
    pacing: DEFAULT_PACING,
    limits: DEFAULT_LIMITS,
    challenges: MERCARI_CHALLENGE_SIGNS,
    privateSelectors: MERCARI_PRIVATE_SELECTORS,
  },
  depop: {
    marketplace: 'depop',
    origins: ['https://www.depop.com', 'https://depop.com'],
    cookieDomains: ['depop.com'],
    pacing: DEFAULT_PACING,
    limits: DEFAULT_LIMITS,
    challenges: DEPOP_CHALLENGE_SIGNS,
    privateSelectors: DEPOP_PRIVATE_SELECTORS,
  },
};

/** The marketplaces browser automation may serve: every one without a usable API. */
export const AUTOMATED_MARKETPLACES = [
  'poshmark',
  'mercari',
  'depop',
] as const satisfies readonly AutomatedMarketplace[];

export function isAutomatedMarketplace(
  marketplace: Marketplace,
): marketplace is AutomatedMarketplace {
  return (AUTOMATED_MARKETPLACES as readonly string[]).includes(marketplace);
}

export type { AutomatedMarketplace };

/** The built-in profile of a marketplace; settings.ts applies the configured pacing and limits. */
export function automationProfile(marketplace: AutomatedMarketplace): AutomationProfile {
  return PROFILES[marketplace];
}

/**
 * A profile for a local stand-in of the marketplace's site (the fake site in development and
 * tests): the same rules, but its origin and cookie domain are the stand-in's.
 */
export function standInProfile(base: AutomationProfile, siteUrl: string): AutomationProfile {
  const site = new URL(siteUrl);
  return { ...base, origins: [site.origin], cookieDomains: [site.hostname] };
}
