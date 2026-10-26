/**
 * One seller's automation session and the page driver its scripts act through, whatever drives
 * the page: Playwright's headless Chromium in the browser runner (session.ts), or the iPhone
 * app's web view (phone/, docs/features/phone-execution.md). Both hosts run the same rules,
 * from this one implementation, over a `PageBackend` that only knows how to act on its page.
 *
 * A script is a sequence of named steps. Each step runs within its own timeout; every action in
 * it waits its paced delay first and inspects the page afterwards (safety/challenges.ts). A page
 * that stops the run (a check, a rate limit, a marketplace error) ends it whatever the script
 * does: the call throws, every later call throws before touching the page, and the run reports
 * the page even if the script caught the error and went on. A check ends the session for good:
 * later runs in it report the same check without touching the page. A failed run leaves one
 * redacted screenshot where the backend can take one. Errors are reported with sanitized
 * messages only.
 *
 * This module runs on the phone too, so it imports no Node or Playwright code.
 */
import type { ChallengeKind, Marketplace } from '@listora/db';
import type { SessionCookie } from '@listora/connections';

import type { AutomationProfile } from '../profiles.ts';
import {
  CHALLENGE_FRAME_PATTERN,
  challengeSelectors,
  inspectPage,
  type PageProblem,
  type PageSignals,
} from '../safety/challenges.ts';
import type { Pacing } from '../safety/pacing.ts';
import {
  DATA_GLOBALS,
  EVIDENCE_SCRIPT,
  redactEvidence,
  type PageEvidence,
} from '../safety/evidence.ts';
import { originForLog, sanitizeMessage } from '../safety/redaction.ts';
import { PageChangedError } from './errors.ts';
import type {
  AutomationSession,
  PageDriver,
  Script,
  ScriptErrorCode,
  ScriptFailure,
  ScriptResult,
  StepOptions,
  StepRunner,
  UploadFile,
} from './types.ts';

/** How a backend's action failed, in the terms a step reports. */
export type PageBackendFailure =
  /** The element the action needs never came (within the step's time). */
  | 'element_timeout'
  /** A page load did not finish in time. */
  | 'navigation_timeout'
  /** The page could not be loaded at all (network, DNS). */
  | 'unreachable'
  /** The page or the session is gone. */
  | 'closed'
  /** Anything else; its message is sanitized before it is kept. */
  | 'other';

export class PageBackendError extends Error {
  readonly failure: PageBackendFailure;

  constructor(failure: PageBackendFailure, message: string) {
    super(message);
    this.name = 'PageBackendError';
    this.failure = failure;
  }
}

/**
 * A page's data as a backend's `pageData` reads it: the JSON its global serializes to (the page
 * serializes it, so only JSON values cross), or `null` when the page has none.
 */
export function parsePageData(text: unknown): unknown {
  if (text === null || text === undefined) return null;
  if (typeof text !== 'string') throw new PageBackendError('other', 'the page sent no data');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PageBackendError('other', "the page's data is not JSON");
  }
}

/** What the inspection script reads in the page (`inspectionScript`). */
export type InspectedPage = Omit<PageSignals, 'url' | 'status' | 'retryAfterSeconds'>;

/**
 * The page, as the session drives it: plain actions with the page's own waiting (an element to
 * appear, a load to finish), within the time `setTimeout` gave. A failure throws a
 * `PageBackendError`. Pacing, inspection, and the read-only rule are the session's, never the
 * backend's, so every host enforces them the same way.
 */
export interface PageBackend {
  /** How long the backend's own waits may take in the step that starts now. */
  setTimeout(ms: number): void;
  /** Loads a URL in the main frame and waits for its document. */
  goto(href: string): Promise<void>;
  /** Clicks the element, then waits for any page load the click started. */
  click(selector: string): Promise<void>;
  /** Puts the whole text into the field at once, like a paste. */
  fill(selector: string, text: string): Promise<void>;
  focus(selector: string): Promise<void>;
  /** Types one character into the focused field. */
  press(character: string): Promise<void>;
  select(selector: string, value: string): Promise<void>;
  check(selector: string, checked: boolean): Promise<void>;
  upload(selector: string, files: readonly UploadFile[]): Promise<void>;
  /** The next confirmation dialog is accepted; every other dialog is dismissed. */
  acceptNextDialog(): void;
  waitFor(selector: string, state: 'attached' | 'detached' | 'visible' | 'hidden'): Promise<void>;
  /** Waits until the main frame's path matches, and its document is loaded. */
  waitForPath(pattern: RegExp): Promise<void>;
  url(): string;
  /** The HTTP status of the main frame's last navigation, and its `Retry-After` in seconds. */
  status(): number | null;
  retryAfterSeconds(): number | null;
  /** Forgets the last navigation's status, before an action that may navigate. */
  clearStatus(): void;
  exists(selector: string): Promise<boolean>;
  count(selector: string): Promise<number>;
  text(selector: string): Promise<string | null>;
  texts(selector: string): Promise<string[]>;
  attribute(selector: string, name: string): Promise<string | null>;
  attributes(selector: string, name: string): Promise<(string | null)[]>;
  /**
   * The page's global `name` as JSON (`null` when it has none), read in the page's own script
   * world, the only place a page's own data lives.
   */
  pageData(name: string): Promise<unknown>;
  /** Evaluates `inspectionScript`'s source in the page. */
  inspect(script: string): Promise<InspectedPage>;
  /** Evaluates a read-only page script of Listora's own (`EVIDENCE_SCRIPT`) and returns its value. */
  read(script: string): Promise<unknown>;
  /**
   * A redacted screenshot of the page now, stored where the host keeps them, and its key; `null`
   * when there is none (no page, a page off the marketplace, or a host without screenshots).
   * `typed` is what the run typed, which a failure's log line must not repeat.
   */
  screenshot(typed: ReadonlySet<string>): Promise<string | null>;
}

/** The part of a logger a session uses. */
export interface SessionLogger {
  debug(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface ScriptSessionDependencies {
  profile: AutomationProfile;
  pacing: Pacing;
  logger: SessionLogger;
  /** Each step's time unless it sets its own. */
  stepTimeoutMs: number;
  /** What the page's network did, for the log line of a run that stops (the runner's). */
  networkSummary?: () => unknown;
  /**
   * Ends the session once: closes the page and returns the cookies the marketplace set on its
   * own domains (for rotation), or none where the host keeps them itself.
   */
  close: () => Promise<SessionCookie[]>;
}

/** The page stopped the run: a check, a rate limit, or a marketplace error. */
class PageProblemError extends Error {
  readonly problem: PageProblem;

  constructor(problem: PageProblem) {
    super(`the page stopped the run: ${problem.type}`);
    this.problem = problem;
  }
}

/** A script failure with a code and a message that are safe to log and store. */
class StepError extends Error {
  readonly code: ScriptErrorCode;

  constructor(code: ScriptErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

class StepTimeoutError extends Error {}

/** How long a page Listora no longer understands settles before its evidence is read. */
const EVIDENCE_SETTLE_MS = 3_000;

/** Bounds of what an inspection reads of the page. */
const INSPECTED_TEXT_LENGTH = 4_000;

export class ScriptSession implements AutomationSession {
  readonly marketplace: Marketplace;
  readonly #backend: PageBackend;
  readonly #deps: ScriptSessionDependencies;
  readonly #inspection: string;
  /** Every value typed or uploaded; error messages never repeat them. */
  readonly #typed = new Set<string>();
  /** The check that stopped the session; nothing runs after it. */
  #challenge: ChallengeKind | null = null;
  /** The page that stopped the current run, if one did. */
  #stoppedBy: PageProblem | null = null;
  #closed: Promise<SessionCookie[]> | null = null;

  constructor(backend: PageBackend, deps: ScriptSessionDependencies) {
    this.marketplace = deps.profile.marketplace;
    this.#backend = backend;
    this.#deps = deps;
    this.#inspection = inspectionScript(challengeSelectors(deps.profile));
  }

  run<T>(name: string, script: Script<T>, signal: AbortSignal): Promise<ScriptResult<T>> {
    return this.#execute(name, script, signal, false);
  }

  read<T>(name: string, script: Script<T>, signal: AbortSignal): Promise<ScriptResult<T>> {
    return this.#execute(name, script, signal, true);
  }

  close(): Promise<SessionCookie[]> {
    this.#closed ??= this.#deps.close();
    return this.#closed;
  }

  async #execute<T>(
    name: string,
    script: Script<T>,
    signal: AbortSignal,
    readOnly: boolean,
  ): Promise<ScriptResult<T>> {
    const steps: string[] = [];
    let mutated = false;
    let current = 'start';
    if (this.#closed !== null) {
      return failed(steps, mutated, error('start', 'aborted', 'the session is closed'));
    }
    if (this.#challenge !== null) {
      return failed(steps, mutated, {
        kind: 'challenge',
        challenge: this.#challenge,
        step: 'start',
        screenshotKey: null,
      });
    }
    this.#stoppedBy = null;
    const runStep: StepRunner = async <S>(
      stepName: string,
      options: StepOptions,
      body: (page: PageDriver, stepSignal: AbortSignal) => Promise<S>,
    ): Promise<S> => {
      if (readOnly && options.mutates) {
        throw new StepError('script_error', `step ${stepName} would change the listing in a read`);
      }
      current = stepName;
      steps.push(stepName);
      if (options.mutates) mutated = true;
      const timeoutMs = options.timeoutMs ?? this.#deps.stepTimeoutMs;
      return this.#runStep(body, timeoutMs, signal, readOnly);
    };

    try {
      const value = await script(runStep);
      // A script that caught the page's stop and carried on still stopped there.
      const stopped = this.#stop();
      if (stopped !== null) throw new PageProblemError(stopped);
      this.#deps.logger.debug({ script: name, steps }, 'automation script finished');
      return { ok: true, value, mutated, steps };
    } catch (caught) {
      const stopped = this.#stop();
      const thrown = stopped === null ? caught : new PageProblemError(stopped);
      const failure = await this.#failure(thrown, current, signal);
      this.#deps.logger.warn(
        {
          script: name,
          step: failure.step,
          failure: failure.kind,
          ...(failure.kind === 'challenge' ? { challenge: failure.challenge } : {}),
          ...(failure.kind === 'error' ? { code: failure.code, reason: failure.message } : {}),
          ...(failure.kind === 'error' && failure.evidence !== undefined
            ? { evidence: failure.evidence }
            : {}),
          origin: originForLog(this.#safeUrl()),
          mutated,
          ...(this.#deps.networkSummary === undefined
            ? {}
            : { network: this.#deps.networkSummary() }),
        },
        'automation script stopped',
      );
      return failed(steps, mutated, failure);
    }
  }

  async #runStep<S>(
    body: (page: PageDriver, signal: AbortSignal) => Promise<S>,
    timeoutMs: number,
    outer: AbortSignal,
    readOnly: boolean,
  ): Promise<S> {
    const controller = new AbortController();
    const onAbort = (): void => {
      controller.abort(outer.reason);
    };
    outer.addEventListener('abort', onAbort, { once: true });
    if (outer.aborted) onAbort();
    // The backend's own waits give up a little before the step does, so a missing element is
    // reported as one rather than as the step's timeout.
    this.#backend.setTimeout(Math.floor(timeoutMs * 0.9));
    const driver = new Driver(this, controller.signal, readOnly);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new StepTimeoutError('the step ran out of time'));
        controller.abort(new StepTimeoutError('the step ran out of time'));
      }, timeoutMs);
    });
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => {
          reject(new StepError('aborted', 'the run was stopped'));
        },
        { once: true },
      );
      if (controller.signal.aborted) reject(new StepError('aborted', 'the run was stopped'));
    });
    const work = body(driver, controller.signal);
    // The body may still settle after the step ended; nothing waits for it then.
    work.catch(() => undefined);
    deadline.catch(() => undefined);
    aborted.catch(() => undefined);
    try {
      return await Promise.race([work, deadline, aborted]);
    } finally {
      clearTimeout(timer);
      outer.removeEventListener('abort', onAbort);
      driver.retire();
    }
  }

  async #failure(thrown: unknown, step: string, signal: AbortSignal): Promise<ScriptFailure> {
    if (thrown instanceof PageProblemError) {
      const { problem } = thrown;
      switch (problem.type) {
        case 'challenge':
          this.#challenge = problem.kind;
          return {
            kind: 'challenge',
            challenge: problem.kind,
            step,
            screenshotKey: await this.#screenshot(),
          };
        case 'rate_limited':
          return {
            ...error(step, 'rate_limited', 'the marketplace asked to slow down'),
            retryAfterMs: problem.retryAfterMs,
            screenshotKey: await this.#screenshot(),
          };
        case 'server_error':
          return {
            ...error(step, 'server_error', `the marketplace answered ${String(problem.status)}`),
            screenshotKey: await this.#screenshot(),
          };
      }
    }
    if (thrown instanceof StepTimeoutError) {
      return { kind: 'timeout', step, screenshotKey: await this.#screenshot() };
    }
    if (thrown instanceof StepError) {
      const screenshotKey = thrown.code === 'aborted' ? null : await this.#screenshot();
      return {
        ...error(step, thrown.code, thrown.message),
        screenshotKey,
        ...(thrown.code === 'element_missing' ? await this.#evidence() : {}),
      };
    }
    if (signal.aborted) return error(step, 'aborted', 'the run was stopped');
    if (thrown instanceof PageChangedError) {
      return {
        ...error(step, 'element_missing', sanitizeMessage(thrown.message, this.#typed)),
        screenshotKey: await this.#screenshot(),
        ...(await this.#evidence()),
      };
    }
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return {
      ...error(step, 'script_error', sanitizeMessage(message, this.#typed)),
      screenshotKey: await this.#screenshot(),
    };
  }

  /** The page that stopped the current run (set by `inspect` while the script runs). */
  #stop(): PageProblem | null {
    return this.#stoppedBy;
  }

  #screenshot(): Promise<string | null> {
    return this.#backend.screenshot(this.#typed).catch(() => null);
  }

  /** What the page has instead of what the script expected, structure only; none if unreadable. */
  async #evidence(): Promise<{ evidence?: PageEvidence }> {
    try {
      // A page its own scripts are still drawing shows what they drew by then, which also tells
      // whether waiting for the missing part would have found it.
      await new Promise((resolve) => setTimeout(resolve, EVIDENCE_SETTLE_MS));
      const raw = await this.#backend.read(EVIDENCE_SCRIPT);
      const data: Record<string, unknown> = {};
      for (const name of DATA_GLOBALS) {
        const value = await this.#backend.pageData(name).catch(() => null);
        if (value !== null) data[name] = value;
      }
      const evidence = redactEvidence(raw, data, {
        cookieDomains: this.#deps.profile.cookieDomains,
        typed: this.#typed,
      });
      return evidence === null ? {} : { evidence };
    } catch {
      return {};
    }
  }

  #safeUrl(): string {
    try {
      return this.#backend.url();
    } catch {
      return 'about:blank';
    }
  }

  // For the page driver -----------------------------------------------------------------------

  get backend(): PageBackend {
    return this.#backend;
  }

  get profile(): AutomationProfile {
    return this.#deps.profile;
  }

  get pacing(): Pacing {
    return this.#deps.pacing;
  }

  noteTyped(value: string): void {
    this.#typed.add(value);
  }

  /** Throws when the page already stopped this run or session. */
  ensureGoing(): void {
    if (this.#stoppedBy !== null) throw new PageProblemError(this.#stoppedBy);
    if (this.#challenge !== null) {
      throw new PageProblemError({ type: 'challenge', kind: this.#challenge, sign: 'earlier' });
    }
  }

  /** Inspects the page; throws when it shows something the run must stop at. */
  async inspect(): Promise<void> {
    this.ensureGoing();
    const read = await this.#backend.inspect(this.#inspection);
    const signals: PageSignals = {
      url: this.#backend.url(),
      status: this.#backend.status(),
      retryAfterSeconds: this.#backend.retryAfterSeconds(),
      ...read,
    };
    const problem = inspectPage(signals, this.#deps.profile);
    if (problem === null) return;
    this.#stoppedBy = problem;
    if (problem.type === 'challenge') this.#challenge = problem.kind;
    throw new PageProblemError(problem);
  }

  /** A backend failure as a step failure; the session's own errors pass through. */
  translate(thrown: unknown): Error {
    if (thrown instanceof PageProblemError || thrown instanceof StepError) return thrown;
    if (thrown instanceof StepTimeoutError) return thrown;
    if (thrown instanceof PageBackendError) {
      switch (thrown.failure) {
        case 'element_timeout':
          return new StepError('element_missing', sanitizeMessage(thrown.message, this.#typed));
        case 'navigation_timeout':
          return new StepTimeoutError('the page did not finish loading');
        case 'unreachable':
          return new StepError('unreachable', 'the marketplace could not be reached');
        case 'closed':
          return new StepError('aborted', 'the session was closed');
        case 'other':
          return new StepError('script_error', sanitizeMessage(thrown.message, this.#typed));
      }
    }
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return new StepError('script_error', sanitizeMessage(message, this.#typed));
  }
}

/**
 * What `inspect` reads in the page: one evaluation, bounded, returning plain data. It is source
 * text, so each host evaluates the same script in its own page.
 */
export function inspectionScript(selectors: readonly string[]): string {
  return `(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      const style = getComputedStyle(element);
      return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0;
    };
    const selectors = ${JSON.stringify(selectors)};
    const matchedSelectors = selectors.filter((selector) => {
      try {
        return [...document.querySelectorAll(selector)].some(visible);
      } catch {
        return false;
      }
    });
    const pattern = ${CHALLENGE_FRAME_PATTERN.toString()};
    const challengeFrames = [...document.querySelectorAll('iframe')]
      .filter((frame) => pattern.test(frame.src) && visible(frame))
      .map((frame) => { try { return new URL(frame.src).origin; } catch { return 'unknown'; } });
    const hasPasswordField = [...document.querySelectorAll('input[type="password" i]')].some(visible);
    const text = (document.body ? document.body.innerText : '').slice(0, ${String(INSPECTED_TEXT_LENGTH)}).toLowerCase();
    return { title: document.title, challengeFrames, hasPasswordField, matchedSelectors, text };
  })()`;
}

class Driver implements PageDriver {
  readonly #session: ScriptSession;
  readonly #signal: AbortSignal;
  readonly #readOnly: boolean;
  #retired = false;

  constructor(session: ScriptSession, signal: AbortSignal, readOnly: boolean) {
    this.#session = session;
    this.#signal = signal;
    this.#readOnly = readOnly;
  }

  retire(): void {
    this.#retired = true;
  }

  async goto(url: string): Promise<void> {
    const target = URL.canParse(url) ? new URL(url) : null;
    if (target === null || !this.#session.profile.origins.includes(target.origin)) {
      throw new StepError('script_error', 'the script asked for a page outside the marketplace');
    }
    await this.#act(async (backend) => {
      backend.clearStatus();
      await backend.goto(target.href);
    });
  }

  async click(selector: string): Promise<void> {
    await this.#act(async (backend) => {
      backend.clearStatus();
      await backend.click(selector);
    });
  }

  async fill(selector: string, text: string): Promise<void> {
    this.#input('fill');
    this.#session.noteTyped(text);
    await this.#act((backend) => backend.fill(selector, text));
  }

  async type(selector: string, text: string): Promise<void> {
    this.#input('type');
    this.#session.noteTyped(text);
    await this.#act(async (backend) => {
      await backend.focus(selector);
      for (const character of text) {
        await this.#session.pacing.wait('keystroke', this.#signal);
        this.#active();
        await backend.press(character);
      }
    });
  }

  async select(selector: string, value: string): Promise<void> {
    this.#input('select');
    await this.#act((backend) => backend.select(selector, value));
  }

  async check(selector: string, checked: boolean): Promise<void> {
    this.#input('check');
    await this.#act((backend) => backend.check(selector, checked));
  }

  async upload(selector: string, files: readonly UploadFile[]): Promise<void> {
    this.#input('upload');
    for (const file of files) this.#session.noteTyped(file.name);
    await this.#act((backend) => backend.upload(selector, files));
  }

  acceptNextDialog(): void {
    this.#input('acceptNextDialog');
    this.#active();
    this.#session.backend.acceptNextDialog();
  }

  async waitFor(
    selector: string,
    state: 'attached' | 'detached' | 'visible' | 'hidden' = 'visible',
  ): Promise<void> {
    await this.#observe((backend) => backend.waitFor(selector, state));
  }

  async waitForPath(pattern: RegExp): Promise<void> {
    await this.#observe((backend) => backend.waitForPath(pattern));
  }

  url(): string {
    this.#active();
    return this.#session.backend.url();
  }

  status(): number | null {
    this.#active();
    return this.#session.backend.status();
  }

  exists(selector: string): Promise<boolean> {
    return this.#query((backend) => backend.exists(selector));
  }

  count(selector: string): Promise<number> {
    return this.#query((backend) => backend.count(selector));
  }

  text(selector: string): Promise<string | null> {
    return this.#query((backend) => backend.text(selector));
  }

  texts(selector: string): Promise<string[]> {
    return this.#query((backend) => backend.texts(selector));
  }

  attribute(selector: string, name: string): Promise<string | null> {
    return this.#query((backend) => backend.attribute(selector, name));
  }

  attributes(selector: string, name: string): Promise<(string | null)[]> {
    return this.#query((backend) => backend.attributes(selector, name));
  }

  pageData(name: string): Promise<unknown> {
    return this.#query((backend) => backend.pageData(name));
  }

  /** A paced action, inspected afterwards. */
  async #act(action: (backend: PageBackend) => Promise<unknown>): Promise<void> {
    this.#active();
    await this.#session.pacing.wait('action', this.#signal);
    this.#active();
    try {
      await action(this.#session.backend);
    } catch (thrown) {
      throw this.#session.translate(thrown);
    }
    this.#active();
    await this.#inspect();
  }

  /** A wait for the page, inspected afterwards (whether or not what it waited for came). */
  async #observe(wait: (backend: PageBackend) => Promise<unknown>): Promise<void> {
    this.#active();
    let failure: Error | null = null;
    try {
      await wait(this.#session.backend);
    } catch (thrown) {
      failure = this.#session.translate(thrown);
    }
    this.#active();
    // A check that replaced the expected page is what stopped the wait.
    await this.#inspect();
    if (failure !== null) throw failure;
  }

  async #query<T>(read: (backend: PageBackend) => Promise<T>): Promise<T> {
    this.#active();
    try {
      return await read(this.#session.backend);
    } catch (thrown) {
      throw this.#session.translate(thrown);
    }
  }

  async #inspect(): Promise<void> {
    try {
      await this.#session.inspect();
    } catch (thrown) {
      throw this.#session.translate(thrown);
    }
  }

  #input(method: string): void {
    if (this.#readOnly) {
      throw new StepError('script_error', `a read cannot ${method}: it would change the listing`);
    }
  }

  #active(): void {
    this.#session.ensureGoing();
    if (this.#retired || this.#signal.aborted) {
      throw new StepError('aborted', 'the step is over');
    }
  }
}

function failed<T>(steps: string[], mutated: boolean, failure: ScriptFailure): ScriptResult<T> {
  return { ok: false, failure, mutated, steps };
}

function error(
  step: string,
  code: ScriptErrorCode,
  message: string,
): Extract<ScriptFailure, { kind: 'error' }> {
  return { kind: 'error', step, code, message, retryAfterMs: null, screenshotKey: null };
}
