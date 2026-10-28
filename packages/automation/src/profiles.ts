/**
 * What the browser runner knows about each automated marketplace (decision D1): its own site
 * (the only origins a session may navigate to and the only cookie domains it keeps), how
 * politely to pace actions, how many runs a seller's account may get, the marketplace's own
 * signs of a check automation must not pass, and the parts of its pages that hold personal
 * data, which screenshots black out. The per-marketplace automation adapters add their own
 * challenge signs and private selectors as they learn the sites' pages.
 */
import type { ExecutionLocation, Marketplace } from '@listora/db';
import type { AutomatedMarketplace } from '@listora/marketplaces';

import {
  DEPOP_API_URL,
  DEPOP_CHALLENGE_SIGNS,
  DEPOP_PACING,
  DEPOP_PRIVATE_SELECTORS,
  DEPOP_READ_ONLY_PACING,
} from './depop/site.ts';
import { EBAY_CHALLENGE_SIGNS, EBAY_PRIVATE_SELECTORS } from './ebay/site.ts';
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
  /** Main-frame paths of its own bot-check or CAPTCHA pages (eBay's `/splashui/challenge`). */
  readonly botCheckPaths: readonly RegExp[];
  /** Elements only its CAPTCHA or bot-check pages show. */
  readonly challengeSelectors: readonly string[];
}

export interface AutomationProfile {
  readonly marketplace: Marketplace;
  /** `https://poshmark.com`: a session never navigates the main frame anywhere else. */
  readonly origins: readonly string[];
  /**
   * The origins of the marketplace's own web API that its pages read from
   * (`https://webapi.depop.com`), the only ones `PageDriver.apiGet` may ask; none for a
   * marketplace whose scripts read only pages.
   */
  readonly apiOrigins: readonly string[];
  /** `poshmark.com`: the only cookies a session loads or keeps. */
  readonly cookieDomains: readonly string[];
  /**
   * The marketplace's own sign-in page, which the app opens to link the seller's account; the
   * seller signs in there (with any two-step check) and the app hands Listora the cookies.
   */
  readonly loginUrl: string;
  /**
   * The marketplace may sign the seller in with a link it emails them (Depop does). Tapped in
   * the email, the link signs in the phone's default browser, not Listora, so the app asks the
   * seller to copy it (or share it to Listora) instead and opens it in its own sign-in page.
   */
  readonly emailsSignInLinks: boolean;
  readonly pacing: PacingSettings;
  /**
   * The gentler pace of a read-only connection's reads (docs/features/read-only.md): a
   * production shop Listora only reads keeps the pace its reads had before the faster
   * `pacing` (2026-10-28), whatever `AUTOMATION_<MARKETPLACE>_PACE_MS` says.
   */
  readonly readOnlyPacing: PacingSettings;
  readonly limits: RunLimits;
  readonly challenges: ChallengeSigns;
  /** Elements screenshots black out besides every form field (names, addresses, messages). */
  readonly privateSelectors: readonly string[];
  /**
   * Where a newly linked connection's automated steps run (docs/features/phone-execution.md):
   * on the seller's iPhone for the marketplaces that refuse Listora's cloud browser, in the
   * cloud otherwise. `AUTOMATION_<MARKETPLACE>_RUNS_ON` changes it; each connection keeps its
   * own location afterwards.
   */
  readonly runsOn: ExecutionLocation;
  /**
   * Whether its automated steps may run in Listora's cloud at all: false for the marketplaces
   * that refuse the cloud runner, so the app does not offer the cloud and the API refuses a
   * move there. `AUTOMATION_<MARKETPLACE>_CLOUD_ALLOWED` changes it, so a marketplace can go
   * back to the cloud without an app update.
   */
  readonly cloudAllowed: boolean;
}

/**
 * The pace of a practiced seller: 0.3 s before each action (the floor, `PACING_FLOOR`; the
 * captain's call, 2026-10-28, on the efficiency audit: at 0.45 to 1.1 s pacing was about half
 * of a listing), a quick typist's keystrokes, and a few seconds between sessions
 * (docs/features/phone-execution.md, "Speed"). Still never faster than a person can act.
 */
export const DEFAULT_PACING: PacingSettings = {
  actionDelayMs: [300, 300],
  keystrokeDelayMs: [45, 130],
  sessionGapMs: [2_000, 4_000],
};

/** The default pace before 2026-10-28, which read-only connections keep (`readOnlyPacing`). */
export const READ_ONLY_PACING: PacingSettings = { ...DEFAULT_PACING, actionDelayMs: [450, 1100] };

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
  botCheckPaths: [],
  challengeSelectors: [],
};

const PROFILES: Readonly<Record<AutomatedMarketplace, AutomationProfile>> = {
  poshmark: {
    marketplace: 'poshmark',
    origins: ['https://poshmark.com', 'https://www.poshmark.com'],
    cookieDomains: ['poshmark.com'],
    apiOrigins: [],
    loginUrl: 'https://poshmark.com/login',
    emailsSignInLinks: false,
    pacing: DEFAULT_PACING,
    readOnlyPacing: READ_ONLY_PACING,
    limits: DEFAULT_LIMITS,
    challenges: COMMON_SIGNS,
    privateSelectors: [],
    // Poshmark serves the cloud runner its pages without their data.
    runsOn: 'phone',
    cloudAllowed: false,
  },
  mercari: {
    marketplace: 'mercari',
    origins: ['https://www.mercari.com', 'https://mercari.com'],
    cookieDomains: ['mercari.com'],
    apiOrigins: [],
    loginUrl: 'https://www.mercari.com/login/',
    emailsSignInLinks: false,
    pacing: DEFAULT_PACING,
    readOnlyPacing: READ_ONLY_PACING,
    limits: DEFAULT_LIMITS,
    challenges: MERCARI_CHALLENGE_SIGNS,
    privateSelectors: MERCARI_PRIVATE_SELECTORS,
    // Mercari shows the cloud runner a bot check.
    runsOn: 'phone',
    cloudAllowed: false,
  },
  depop: {
    marketplace: 'depop',
    origins: ['https://www.depop.com', 'https://depop.com'],
    cookieDomains: ['depop.com'],
    apiOrigins: [DEPOP_API_URL],
    loginUrl: 'https://www.depop.com/login/',
    emailsSignInLinks: true,
    pacing: DEPOP_PACING,
    readOnlyPacing: DEPOP_READ_ONLY_PACING,
    limits: DEFAULT_LIMITS,
    challenges: DEPOP_CHALLENGE_SIGNS,
    privateSelectors: DEPOP_PRIVATE_SELECTORS,
    // Depop blocks the cloud runner's address.
    runsOn: 'phone',
    cloudAllowed: false,
  },
  ebay: {
    marketplace: 'ebay',
    // eBay's sign-in pages are on signin.ebay.com: a session eBay rejected is sent there, and
    // is stopped as a login page rather than as a page outside eBay.
    origins: ['https://www.ebay.com', 'https://ebay.com', 'https://signin.ebay.com'],
    cookieDomains: ['ebay.com'],
    apiOrigins: [],
    loginUrl: 'https://signin.ebay.com/signin/',
    emailsSignInLinks: false,
    pacing: DEFAULT_PACING,
    readOnlyPacing: READ_ONLY_PACING,
    limits: DEFAULT_LIMITS,
    challenges: EBAY_CHALLENGE_SIGNS,
    privateSelectors: EBAY_PRIVATE_SELECTORS,
    runsOn: 'cloud',
    cloudAllowed: true,
  },
};

/**
 * The marketplaces browser automation may serve, in the order Link accounts lists them: every
 * one without a usable API, and eBay until Listora's eBay developer keys exist (an `api`
 * connection is never automated).
 */
export const AUTOMATED_MARKETPLACES = [
  'poshmark',
  'mercari',
  'depop',
  'ebay',
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
 * tests): the same rules, but its origin, cookie domain, and sign-in page are the stand-in's.
 */
export function standInProfile(base: AutomationProfile, siteUrl: string): AutomationProfile {
  const site = new URL(siteUrl);
  return {
    ...base,
    origins: [site.origin],
    // The stand-in serves the marketplace's API reads itself.
    apiOrigins: base.apiOrigins.length > 0 ? [site.origin] : [],
    cookieDomains: [site.hostname],
    // The marketplace's own sign-in path, on the stand-in (`/login` on Poshmark, `/login/` on
    // Mercari and Depop, `/signin/` on eBay).
    loginUrl: new URL(new URL(base.loginUrl).pathname, site.origin).href,
  };
}
