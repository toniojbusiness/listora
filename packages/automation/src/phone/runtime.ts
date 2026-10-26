/**
 * The phone runtime (docs/features/phone-execution.md): runs one script call the server handed
 * the iPhone app, in the seller's own web view, and returns how it went. It is the browser
 * runner's own code, bundled for the phone (`npm run phone:bundle`): the same marketplace
 * scripts (`<marketplace>/scripts.ts`), the same session rules (runner/script-session.ts:
 * pacing, inspection after every action, read-only reads, sticky stops), and the same result
 * shape, which the server maps to an outcome exactly as it does a runner's. Only the page
 * backend (backend.ts) differs.
 *
 * One rule is the phone's own: a check the run stops at (a CAPTCHA, a bot check, a login code,
 * a sign-in page) is handed to the seller. The app shows the page in a visible in-app browser,
 * the seller completes the check themselves, and the call runs again from its start when it had
 * changed nothing yet. Listora never solves, skips, or hides a check. A check the seller could
 * not be asked about (the app is in the background) or declined ends the run as
 * `stopped_for_check`, which retries later; a sign-in page they declined ends it as the check,
 * which asks them to link the marketplace again.
 */
import { assertNever } from '@listora/shared';

import type { PhotoSource } from '../adapter/photos.ts';
import {
  isWriteCall,
  runScriptCall,
  type ScriptCall,
  type ScriptSet,
} from '../adapter/script-call.ts';
import { createDepopScripts } from '../depop/scripts.ts';
import type { DepopAutomationPayload } from '../depop/payload.ts';
import { createEbayScripts } from '../ebay/scripts.ts';
import type { EbayAutomationPayload } from '../ebay/payload.ts';
import { createFakeSiteScripts } from '../fake-site/scripts.ts';
import { createMercariScripts } from '../mercari/scripts.ts';
import type { MercariListingPayload } from '../mercari/payload.ts';
import { createPoshmarkScripts } from '../poshmark/scripts.ts';
import type { PoshmarkListingPayload } from '../poshmark/payload.ts';
import { PoshmarkSite } from '../poshmark/site.ts';
import { automationProfile, type AutomationProfile, type PacingSettings } from '../profiles.ts';
import { Pacing, type PacingOptions } from '../safety/pacing.ts';
import { ScriptSession } from '../runner/script-session.ts';
import type { ScriptFailure, ScriptResult, StepRunner } from '../runner/types.ts';
import { BridgeBackend, fromBase64 } from './backend.ts';
import type { PhoneHost } from './host.ts';

/**
 * The version of `PhoneCallInput` and `PhoneCallOutput` this runtime speaks. The server hands a
 * call only to an app whose runtime speaks its version; change it with any change to either.
 */
export const PHONE_RUNTIME_VERSION = 1;

/** One script call for the phone, as the server describes it (`PhoneCall.input` in the API). */
export interface PhoneCallInput {
  runtimeVersion: number;
  scriptSet: ScriptSet;
  call: ScriptCall;
  /** The run's name in logs and history: `create`, `read listing`, `health check`. */
  name: string;
  /** The marketplace's profile as the server configured it. */
  origins: string[];
  cookieDomains: string[];
  pacing: PacingSettings;
  stepTimeoutMs: number;
  /** The whole run's deadline, not counting the time the seller spends on a check. */
  callTimeoutMs: number;
  /** The rest of the pause since the seller's last session started, waited before this one. */
  startDelayMs: number;
}

/** What the phone reports: the script ran (or stopped), and how. */
export interface PhoneCallOutput {
  type: 'ran';
  result: ScriptResult<unknown>;
}

/** Hand-offs one call may make before it stops for good. */
const MAX_HAND_OFFS = 2;

/** The checks a seller can complete themselves in the in-app browser. */
const SELLER_CHECKS = ['captcha', 'bot_check', 'login_challenge', 'session_rejected'] as const;

/** How long one listing photo may take to download. */
const PHOTO_TIMEOUT_MS = 30_000;

export interface PhoneRuntimeOptions {
  /** Pacing's randomness and sleep (tests make them quick). */
  pacing?: PacingOptions;
}

export async function runPhoneCall(
  input: PhoneCallInput,
  host: PhoneHost,
  options: PhoneRuntimeOptions = {},
): Promise<PhoneCallOutput> {
  const profile = phoneProfile(input);
  const pacing = new Pacing(profile.pacing, options.pacing);
  const photos = phonePhotos(host);
  await pacing.waitFor(input.startDelayMs, new AbortController().signal);
  for (let handOffs = 0; ; handOffs += 1) {
    const result = await runOnce(input, host, profile, pacing, photos);
    if (result.ok || result.failure.kind !== 'challenge') return { type: 'ran', result };
    const check = result.failure.challenge;
    if (!(SELLER_CHECKS as readonly string[]).includes(check)) return { type: 'ran', result };
    if (handOffs === MAX_HAND_OFFS) return { type: 'ran', result: stoppedForCheck(result) };
    const answer = await host.handOff({ kind: check, marketplace: input.scriptSet.marketplace });
    switch (answer) {
      case 'completed':
        // Nothing changed yet: the call starts over now that the page is past the check.
        if (!result.mutated) continue;
        return { type: 'ran', result: stoppedForCheck(result) };
      case 'declined':
        // A sign-in the seller won't redo now needs a new link; any other check is asked again.
        return {
          type: 'ran',
          result: check === 'session_rejected' ? result : stoppedForCheck(result),
        };
      case 'unavailable':
        return { type: 'ran', result: stoppedForCheck(result) };
      default:
        return assertNever(answer, 'hand-off answer');
    }
  }
}

async function runOnce(
  input: PhoneCallInput,
  host: PhoneHost,
  profile: AutomationProfile,
  pacing: Pacing,
  photos: PhotoSource,
): Promise<ScriptResult<unknown>> {
  const session = new ScriptSession(new BridgeBackend(host), {
    profile,
    pacing,
    logger: {
      debug: (fields, message) => {
        host.log('debug', message, fields);
      },
      warn: (fields, message) => {
        host.log('warn', message, fields);
      },
    },
    stepTimeoutMs: input.stepTimeoutMs,
    // The app keeps the seller's cookies itself.
    close: () => Promise.resolve([]),
  });
  const run = scriptRunner(input.scriptSet, photos);
  const script = (step: StepRunner): Promise<unknown> => run(input.call, step);
  const signal = AbortSignal.timeout(input.callTimeoutMs);
  try {
    return isWriteCall(input.call)
      ? await session.run(input.name, script, signal)
      : await session.read(input.name, script, signal);
  } finally {
    await session.close();
  }
}

/**
 * The marketplace's built-in profile (its challenge signs and private elements) with what the
 * server configured: the site's origins and cookie domains, and the pacing, which the server
 * never sets below `PACING_FLOOR` (settings.ts refuses it at startup).
 */
export function phoneProfile(input: PhoneCallInput): AutomationProfile {
  return {
    ...automationProfile(input.scriptSet.marketplace),
    origins: input.origins,
    cookieDomains: input.cookieDomains,
    pacing: input.pacing,
  };
}

/** Runs a call with the script set's scripts, on its site. */
function scriptRunner(
  set: ScriptSet,
  photos: PhotoSource,
): (call: ScriptCall, step: StepRunner) => Promise<unknown> {
  const origin = new URL(set.siteUrl).origin;
  switch (set.name) {
    case 'depop': {
      const scripts = createDepopScripts({ site: { origin }, photos });
      return (call, step) =>
        runScriptCall(scripts, call as ScriptCall<DepopAutomationPayload>, step);
    }
    case 'mercari': {
      const scripts = createMercariScripts({ site: { origin }, photos });
      return (call, step) =>
        runScriptCall(scripts, call as ScriptCall<MercariListingPayload>, step);
    }
    case 'ebay': {
      const scripts = createEbayScripts({ site: { origin }, photos });
      return (call, step) =>
        runScriptCall(scripts, call as ScriptCall<EbayAutomationPayload>, step);
    }
    case 'poshmark': {
      const scripts = createPoshmarkScripts({ site: new PoshmarkSite(origin), photos });
      return (call, step) =>
        runScriptCall(scripts, call as ScriptCall<PoshmarkListingPayload>, step);
    }
    case 'fake_site': {
      const scripts = createFakeSiteScripts({ site: origin, photos });
      return (call, step) => runScriptCall(scripts, call, step);
    }
    default:
      return assertNever(set.name, 'script set');
  }
}

/** Listing photos, fetched by the app (Listora's own image URLs). */
function phonePhotos(host: PhoneHost): PhotoSource {
  return {
    async fetch(url) {
      const photo = await host.fetchPhoto(url, PHOTO_TIMEOUT_MS);
      if (photo.mimeType !== 'image/jpeg') throw new Error('the photo is not a JPEG');
      const bytes = fromBase64(photo.base64);
      if (bytes.length === 0) throw new Error('the photo is empty');
      return { name: photo.name, mimeType: photo.mimeType, bytes };
    },
  };
}

/** A run that stopped at a check the seller completes on the phone, as the server reads it. */
function stoppedForCheck(
  result: Extract<ScriptResult<unknown>, { ok: false }>,
): ScriptResult<unknown> {
  const failure: ScriptFailure = {
    kind: 'error',
    step: result.failure.step,
    code: 'stopped_for_check',
    message:
      result.failure.kind === 'challenge'
        ? `the page showed a ${result.failure.challenge.replace('_', ' ')} for the seller to complete`
        : 'the page showed a check for the seller to complete',
    retryAfterMs: null,
    screenshotKey: null,
  };
  return { ...result, failure };
}
