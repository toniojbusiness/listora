/**
 * The typed interface the per-marketplace automation adapters build on (decision D1): open a
 * session, run a scripted action of named steps (each with its own timeout, and a redacted
 * screenshot when one fails), read the page back, close. Scripts only ever reach the page
 * through `PageDriver`, which paces every action and inspects the page after it, so the safety
 * rules hold whatever a script does.
 */
import type { ChallengeKind, Marketplace } from '@listora/db';
import type { SessionCookie } from '@listora/connections';

import type { AutomationProfile } from '../profiles.ts';
import type { PageEvidence } from '../safety/evidence.ts';

/** A file a script uploads through a file input (a listing photo). */
export interface UploadFile {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

/**
 * The page, as a script sees it. Every action waits a paced delay first, runs within the
 * step's time, and is followed by an inspection: a CAPTCHA, a bot check, a login or
 * verification step, a page off the marketplace's site, a rate limit, or a marketplace error
 * ends the run at once (the method throws, and every later call does too). In a read, the
 * methods that change something (form input, uploads, accepting a dialog) refuse.
 */
export interface PageDriver {
  /** Opens a URL on the marketplace's own site; anything else ends the run. */
  goto(url: string): Promise<void>;
  click(selector: string): Promise<void>;
  /** Puts the whole text into a field at once, like a paste (for titles and descriptions). */
  fill(selector: string, text: string): Promise<void>;
  /** Types the text key by key at a person's pace (for short fields such as a search). */
  type(selector: string, text: string): Promise<void>;
  select(selector: string, value: string): Promise<void>;
  check(selector: string, checked: boolean): Promise<void>;
  upload(selector: string, files: readonly UploadFile[]): Promise<void>;
  /** Accepts the next confirmation dialog (a "Delete this listing?" prompt); others are dismissed. */
  acceptNextDialog(): void;
  waitFor(selector: string, state?: 'attached' | 'detached' | 'visible' | 'hidden'): Promise<void>;
  /** Waits until the main frame's path matches, for example after a form submission. */
  waitForPath(pattern: RegExp): Promise<void>;
  url(): string;
  /** The HTTP status of the main frame's last navigation. */
  status(): number | null;
  exists(selector: string): Promise<boolean>;
  count(selector: string): Promise<number>;
  text(selector: string): Promise<string | null>;
  texts(selector: string): Promise<string[]>;
  attribute(selector: string, name: string): Promise<string | null>;
  attributes(selector: string, name: string): Promise<(string | null)[]>;
  /**
   * The data the page keeps for its own scripts in the global `name` (`window.<name>`), as
   * JSON, or `null` when it has none. A page whose data comes in an inline script that removes
   * itself once it ran (Poshmark's `window.__INITIAL_STATE__`) has it only there.
   */
  pageData(name: string): Promise<unknown>;
}

export interface StepOptions {
  /** Whether the step may change the listing (a submit, a delete); a read's steps never do. */
  mutates: boolean;
  /** Overrides the runner's step timeout. */
  timeoutMs?: number;
}

/**
 * Runs one named step of a script; throws when it fails (the run then reports why). The body's
 * signal aborts when the step ends, for work of its own such as fetching a photo.
 */
export type StepRunner = <T>(
  name: string,
  options: StepOptions,
  body: (page: PageDriver, signal: AbortSignal) => Promise<T>,
) => Promise<T>;

export type ScriptFailure =
  /** A page automation must never pass; the session must be relinked. */
  | { kind: 'challenge'; challenge: ChallengeKind; step: string; screenshotKey: string | null }
  /** The step ran out of time; its effect, if it mutates, is unknown. */
  | { kind: 'timeout'; step: string; screenshotKey: string | null }
  | {
      kind: 'error';
      step: string;
      code: ScriptErrorCode;
      /** Sanitized: no URL path, no page text, nothing the run typed. */
      message: string;
      retryAfterMs: number | null;
      screenshotKey: string | null;
      /**
       * For a page the script no longer understands (`element_missing`): what the page has
       * instead, structure only (safety/evidence.ts), for the log line; never stored.
       */
      evidence?: PageEvidence;
    };

export type ScriptErrorCode =
  /** The marketplace answered 429. */
  | 'rate_limited'
  /** The marketplace answered 5xx. */
  | 'server_error'
  /** The page could not be loaded at all (network, DNS). */
  | 'unreachable'
  /** An element the script expects is not on the page: the site may have changed. */
  | 'element_missing'
  /** The run was aborted (the engine's deadline, or the runner stopping). */
  | 'aborted'
  /**
   * The runner's browser could not start or open the session, so the marketplace was never
   * asked: a failure on Listora's side, never the marketplace's answer.
   */
  | 'browser_unavailable'
  /** The script itself failed (a bug, or a page it does not understand). */
  | 'script_error'
  /**
   * On the phone (docs/features/phone-execution.md): the page showed a check that the seller
   * completes themselves in the app, and the run stopped there; nothing after it ran. The step
   * runs again once they have, or the read-back decides when the run had already changed
   * something.
   */
  | 'stopped_for_check';

export type ScriptResult<T> =
  | { ok: true; value: T; mutated: boolean; steps: string[] }
  | { ok: false; failure: ScriptFailure; mutated: boolean; steps: string[] };

/** A script's body: its steps, run one after the other. */
export type Script<T> = (step: StepRunner) => Promise<T>;

/** What a session is opened with: one seller's cookies on one marketplace. */
export interface SessionSpec {
  profile: AutomationProfile;
  cookies: readonly SessionCookie[];
  /** Names the run's screenshots: `automation/<accountId>/<runId>.png`. */
  accountId: string;
  runId: string;
}

/** One seller's browser session: an isolated browser context with their cookies. */
export interface AutomationSession {
  readonly marketplace: Marketplace;
  /** Runs a scripted action. Never throws for what the page does; the result says. */
  run<T>(name: string, script: Script<T>, signal: AbortSignal): Promise<ScriptResult<T>>;
  /** Runs a script that only reads (no step may mutate, and the page driver refuses input). */
  read<T>(name: string, script: Script<T>, signal: AbortSignal): Promise<ScriptResult<T>>;
  /** Closes the session and returns its cookies on the marketplace's domains, for rotation. */
  close(): Promise<SessionCookie[]>;
}

export interface BrowserRunner {
  /** Opens a session; the browser starts on the first one. One session runs at a time. */
  openSession(spec: SessionSpec, signal: AbortSignal): Promise<AutomationSession>;
  /** Closes the browser; open sessions end. */
  close(): Promise<void>;
}
