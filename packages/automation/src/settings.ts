/**
 * Browser automation settings from the environment (see `.env.example`), read once at startup
 * by the worker and the browser runner. Pacing and run limits can be set per marketplace, but
 * never faster than `PACING_FLOOR` or above `LIMITS_CEILING`: a setting beyond them is refused,
 * so no configuration makes automation hurried. Errors name the bad key, never its value.
 */
import {
  AUTOMATED_MARKETPLACES,
  automationProfile,
  LIMITS_CEILING,
  PACING_FLOOR,
  standInProfile,
  type AutomatedMarketplace,
  type AutomationProfile,
  type DelayRange,
} from './profiles.ts';

export interface SaleCheckSettings {
  /** How often a seller without enough sales history is checked. */
  readonly defaultIntervalMs: number;
  /** The adapted interval stays within these. */
  readonly minIntervalMs: number;
  readonly maxIntervalMs: number;
}

export interface AutomationSettings {
  /** Each script step's time unless the step sets its own. */
  readonly stepTimeoutMs: number;
  /** The engine's deadline for one automated call (a whole script) in the runner. */
  readonly callTimeoutMs: number;
  readonly profiles: Readonly<Record<AutomatedMarketplace, AutomationProfile>>;
  readonly saleChecks: SaleCheckSettings;
  /**
   * Development and tests only: the fake marketplace site that stands in for each automated
   * marketplace without a fake of its own, whose automation connections then run against it.
   */
  readonly fakeSiteUrl: string | undefined;
  /**
   * Development and tests only: the fake Poshmark, which the Poshmark automation adapter then
   * drives instead of poshmark.com (it takes precedence over `fakeSiteUrl` for Poshmark).
   */
  readonly fakePoshmarkUrl: string | undefined;
  /**
   * Development and tests only: the fake Mercari site (`npm run dev:fake-mercari`), which the
   * Mercari automation adapter then drives instead of mercari.com (it takes precedence over
   * `fakeSiteUrl` for Mercari).
   */
  readonly fakeMercariSiteUrl: string | undefined;
  /**
   * Development and tests only: the fake Depop site (`npm run dev:fake-depop-site`), which the
   * Depop automation adapter then drives instead of depop.com (it takes precedence over
   * `fakeSiteUrl` for Depop).
   */
  readonly fakeDepopSiteUrl: string | undefined;
  /**
   * Development and tests only: the fake eBay site (`npm run dev:fake-ebay-site`), which the
   * eBay automation adapter then drives instead of ebay.com (it takes precedence over
   * `fakeSiteUrl` for eBay).
   */
  readonly fakeEbaySiteUrl: string | undefined;
}

export class AutomationConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid browser automation configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'AutomationConfigError';
    this.issues = issues;
  }
}

const HOUR_MS = 3_600_000;
/** A check more often than this is more than a person refreshing their sales page. */
const MIN_SALE_CHECK_HOURS = 1;
const MAX_SALE_CHECK_HOURS = 72;

export function loadAutomationSettings(env: NodeJS.ProcessEnv = process.env): AutomationSettings {
  const issues: string[] = [];
  const stepTimeoutMs = integer(issues, env, 'AUTOMATION_STEP_TIMEOUT_MS', 30_000, 1_000, 120_000);
  const callTimeoutMs = integer(
    issues,
    env,
    'AUTOMATION_CALL_TIMEOUT_MS',
    300_000,
    10_000,
    900_000,
  );
  if (callTimeoutMs < stepTimeoutMs) {
    issues.push('AUTOMATION_CALL_TIMEOUT_MS must be at least AUTOMATION_STEP_TIMEOUT_MS');
  }

  const fakeSiteUrl = localUrl(issues, env, 'FAKE_AUTOMATION_SITE_URL');
  const fakePoshmarkUrl = localUrl(issues, env, 'FAKE_POSHMARK_URL');
  const fakeMercariSiteUrl = localUrl(issues, env, 'FAKE_MERCARI_SITE_URL');
  const fakeDepopSiteUrl = localUrl(issues, env, 'FAKE_DEPOP_SITE_URL');
  const fakeEbaySiteUrl = localUrl(issues, env, 'FAKE_EBAY_SITE_URL');

  const profiles = Object.fromEntries(
    AUTOMATED_MARKETPLACES.map((marketplace) => {
      const prefix = `AUTOMATION_${marketplace.toUpperCase()}`;
      const base = automationProfile(marketplace);
      const actionDelayMs = delayRange(
        issues,
        env,
        `${prefix}_PACE_MS`,
        base.pacing.actionDelayMs,
        PACING_FLOOR.actionDelayMs[0],
        60_000,
      );
      const sessionGapMs = delayRange(
        issues,
        env,
        `${prefix}_SESSION_GAP_MS`,
        base.pacing.sessionGapMs,
        PACING_FLOOR.sessionGapMs[0],
        600_000,
      );
      const runsPerHour = integer(
        issues,
        env,
        `${prefix}_RUNS_PER_HOUR`,
        base.limits.runsPerHour,
        1,
        LIMITS_CEILING.runsPerHour,
      );
      const runsPerDay = integer(
        issues,
        env,
        `${prefix}_RUNS_PER_DAY`,
        base.limits.runsPerDay,
        1,
        LIMITS_CEILING.runsPerDay,
      );
      const profile: AutomationProfile = {
        ...base,
        pacing: { ...base.pacing, actionDelayMs, sessionGapMs },
        limits: { runsPerHour, runsPerDay },
      };
      // In development, a marketplace's stand-in replaces its real site, never the reverse.
      const ownFake = {
        poshmark: fakePoshmarkUrl,
        mercari: fakeMercariSiteUrl,
        depop: fakeDepopSiteUrl,
        ebay: fakeEbaySiteUrl,
      }[marketplace];
      const standIn = ownFake ?? fakeSiteUrl;
      return [marketplace, standIn === undefined ? profile : standInProfile(profile, standIn)];
    }),
  ) as Record<AutomatedMarketplace, AutomationProfile>;

  const hours = (key: string, fallback: number): number =>
    decimal(issues, env, key, fallback, MIN_SALE_CHECK_HOURS, MAX_SALE_CHECK_HOURS) * HOUR_MS;
  const saleChecks = {
    defaultIntervalMs: hours('SALE_CHECK_DEFAULT_HOURS', 12),
    minIntervalMs: hours('SALE_CHECK_MIN_HOURS', 2),
    maxIntervalMs: hours('SALE_CHECK_MAX_HOURS', 24),
  };
  if (
    saleChecks.minIntervalMs > saleChecks.defaultIntervalMs ||
    saleChecks.defaultIntervalMs > saleChecks.maxIntervalMs
  ) {
    issues.push(
      'SALE_CHECK_MIN_HOURS, SALE_CHECK_DEFAULT_HOURS, and SALE_CHECK_MAX_HOURS must be in increasing order',
    );
  }

  if (issues.length > 0) throw new AutomationConfigError(issues);
  return {
    stepTimeoutMs,
    callTimeoutMs,
    profiles,
    saleChecks,
    fakeSiteUrl,
    fakePoshmarkUrl,
    fakeMercariSiteUrl,
    fakeDepopSiteUrl,
    fakeEbaySiteUrl,
  };
}

/** A local development server's URL, `http://127.0.0.1:<port>`; unset or empty is `undefined`. */
function localUrl(issues: string[], env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined || raw === '') return undefined;
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(raw)) {
    issues.push(`${key} must be http://127.0.0.1:<port> or http://localhost:<port>`);
  }
  return raw;
}

function integer(
  issues: string[],
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < min || value > max) {
    issues.push(`${key} must be an integer from ${String(min)} to ${String(max)}`);
    return fallback;
  }
  return value;
}

function decimal(
  issues: string[],
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!/^\d+(\.\d+)?$/.test(raw) || value < min || value > max) {
    issues.push(`${key} must be a number of hours from ${String(min)} to ${String(max)}`);
    return fallback;
  }
  return value;
}

/** `min-max` in milliseconds, from `floor` up to `ceiling`. */
function delayRange(
  issues: string[],
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: DelayRange,
  floor: number,
  ceiling: number,
): DelayRange {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const match = /^(\d+)-(\d+)$/.exec(raw);
  const min = Number(match?.[1]);
  const max = Number(match?.[2]);
  if (match === null || min > max || min < floor || max > ceiling) {
    issues.push(
      `${key} must be min-max milliseconds, from ${String(floor)} up to ${String(ceiling)}`,
    );
    return fallback;
  }
  return [min, max];
}
