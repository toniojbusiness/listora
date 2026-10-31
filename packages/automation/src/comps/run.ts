/**
 * Runs a comparison read on the phone (docs/features/thrift-scan.md, "Marketplace
 * comparisons"), through the same session rules as every automated read (runner/
 * script-session.ts: pacing, a read-only page driver, the page inspection after every action),
 * on the phone's page backend, in the app's comparison web view: its own data store, no cookies,
 * never signed in. The first check (a CAPTCHA, a bot check, a sign-in page, a 403 that is not
 * JSON) ends the read as `check`, and the app stops that marketplace's comparisons for the day;
 * nothing ever tries to get past it, and it is never handed to the seller (no seller session is
 * involved, so there is nothing of theirs to unblock).
 */
import { assertNever } from '@listora/shared';

import { automationProfile, type AutomationProfile } from '../profiles.ts';
import { BridgeBackend } from '../phone/backend.ts';
import type { PhoneHost } from '../phone/host.ts';
import { ScriptSession } from '../runner/script-session.ts';
import type { Script, ScriptFailure, ScriptResult } from '../runner/types.ts';
import { Pacing, type PacingOptions } from '../safety/pacing.ts';
import { depopComparisonScript, depopWarmUpScript } from './depop.ts';
import {
  COMPARISON_VERSION,
  type ComparisonInput,
  type ComparisonMarketplace,
  type ComparisonOutput,
} from './types.ts';

/** The marketplaces' sites the comparison lane reads; never configurable by a call. */
const SITES: Readonly<Record<ComparisonMarketplace, string>> = {
  depop: 'https://www.depop.com',
};

export interface ComparisonRunOptions {
  pacing?: PacingOptions;
  /** The site a test reads instead of the marketplace's own. */
  siteUrl?: string;
  now?: () => number;
}

/**
 * The marketplace's profile for a logged-out read: its own origins and checks, its site's
 * origin as the only API it may read, and no cookie domains (a read never holds a cookie).
 */
export function comparisonProfile(
  marketplace: ComparisonMarketplace,
  input: Pick<ComparisonInput, 'pacing'>,
  siteUrl: string = SITES[marketplace],
): AutomationProfile {
  const builtIn = automationProfile(marketplace);
  const origin = new URL(siteUrl).origin;
  const origins = builtIn.origins.includes(origin) ? builtIn.origins : [origin];
  return {
    ...builtIn,
    origins,
    apiOrigins: [origin],
    cookieDomains: [],
    pacing: input.pacing,
    readOnlyPacing: input.pacing,
  };
}

/** Runs one comparison read; a failure of the runtime itself is reported as one, never thrown. */
export async function runComparison(
  input: ComparisonInput,
  host: PhoneHost,
  options: ComparisonRunOptions = {},
): Promise<ComparisonOutput> {
  const now = options.now ?? Date.now;
  const started = now();
  const ms = () => Math.max(0, Math.round(now() - started));
  if (input.version !== COMPARISON_VERSION) {
    return { outcome: 'failed', message: 'this app reads another comparison version', ms: ms() };
  }
  const siteUrl = options.siteUrl ?? SITES[input.marketplace];
  const result = await runRead(
    input,
    host,
    depopComparisonScript(siteUrl, input.query, new Date(input.now)),
    siteUrl,
    options,
  );
  if (result.ok) {
    return {
      outcome: 'read',
      stats: result.value.stats,
      forSaleTotal: result.value.forSaleTotal,
      ms: ms(),
    };
  }
  return { ...failureOutcome(result.failure), ms: ms() };
}

/** What a warm-up needs: the marketplace; its read-only pace and the timeouts by default. */
export interface WarmUpInput {
  readonly marketplace: ComparisonMarketplace;
  readonly pacing?: ComparisonInput['pacing'];
  readonly stepTimeoutMs?: number;
  readonly callTimeoutMs?: number;
}

/** A warm-up's step and call time when the app names none. */
const WARM_UP_STEP_MS = 15_000;
const WARM_UP_CALL_MS = 30_000;

/** Loads the marketplace's search page once, so the first read starts warm. */
export async function warmUpComparisons(
  input: WarmUpInput,
  host: PhoneHost,
  options: ComparisonRunOptions = {},
): Promise<Exclude<ComparisonOutput, { outcome: 'read' }> | { outcome: 'warm'; ms: number }> {
  const now = options.now ?? Date.now;
  const started = now();
  const ms = () => Math.max(0, Math.round(now() - started));
  const siteUrl = options.siteUrl ?? SITES[input.marketplace];
  const read = {
    marketplace: input.marketplace,
    pacing: input.pacing ?? automationProfile(input.marketplace).readOnlyPacing,
    stepTimeoutMs: input.stepTimeoutMs ?? WARM_UP_STEP_MS,
    callTimeoutMs: input.callTimeoutMs ?? WARM_UP_CALL_MS,
  };
  const result = await runRead(read, host, depopWarmUpScript(siteUrl), siteUrl, options);
  return result.ok
    ? { outcome: 'warm', ms: ms() }
    : { ...failureOutcome(result.failure), ms: ms() };
}

async function runRead<T>(
  input: Pick<ComparisonInput, 'marketplace' | 'pacing' | 'stepTimeoutMs' | 'callTimeoutMs'>,
  host: PhoneHost,
  script: Script<T>,
  siteUrl: string,
  options: ComparisonRunOptions,
): Promise<ScriptResult<T>> {
  const profile = comparisonProfile(input.marketplace, input, siteUrl);
  const session = new ScriptSession(new BridgeBackend(host), {
    profile,
    pacing: new Pacing(profile.pacing, options.pacing),
    logger: {
      debug: (fields, message) => {
        host.log('debug', message, fields);
      },
      warn: (fields, message) => {
        host.log('warn', message, fields);
      },
    },
    stepTimeoutMs: input.stepTimeoutMs,
    // The comparison web view keeps no cookies.
    close: () => Promise.resolve([]),
  });
  try {
    return await session.read('compare', script, AbortSignal.timeout(input.callTimeoutMs));
  } catch (thrown) {
    return {
      ok: false,
      mutated: false,
      steps: [],
      failure: {
        kind: 'error',
        step: 'phone',
        code: 'script_error',
        message: (thrown instanceof Error ? thrown.message : String(thrown)).slice(0, 200),
        retryAfterMs: null,
        screenshotKey: null,
      },
    };
  } finally {
    await session.close();
  }
}

/** How a read that stopped is reported: a check or a rate limit pauses the marketplace. */
function failureOutcome(
  failure: ScriptFailure,
): Omit<Exclude<ComparisonOutput, { outcome: 'read' }>, 'ms'> {
  switch (failure.kind) {
    case 'challenge':
      return {
        outcome: 'check',
        message: `the page showed a ${failure.challenge.replace('_', ' ')}`,
      };
    case 'timeout':
      return { outcome: 'failed', message: 'the read ran out of time' };
    case 'error':
      return failure.code === 'rate_limited'
        ? { outcome: 'rate_limited', message: 'the marketplace asked Listora to slow down' }
        : { outcome: 'failed', message: `${failure.code}: ${failure.message}`.slice(0, 200) };
    default:
      return assertNever(failure, 'script failure');
  }
}
