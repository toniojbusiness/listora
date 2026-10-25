/**
 * One seller's browser session on Playwright, and the page driver its scripts act through.
 *
 * A script is a sequence of named steps. Each step runs within its own timeout; every action in
 * it waits its paced delay first and inspects the page afterwards (safety/challenges.ts). A page
 * that stops the run (a check, a rate limit, a marketplace error) ends it whatever the script
 * does: the call throws, every later call throws before touching the page, and the run reports
 * the page even if the script caught the error and went on. A check ends the session for good:
 * later runs in it report the same check without touching the page. A failed run leaves one screenshot of the viewport with every form field and the
 * profile's private elements blacked out. Errors are reported with sanitized messages only.
 */
import type { BrowserContext, Cookie, Dialog, Locator, Page, Response } from 'playwright-core';

import type { ChallengeKind, Marketplace } from '@listora/db';
import type { Logger } from '@listora/shared';
import { cookieOnDomains, type SessionCookie } from '@listora/connections';

import type { AutomationProfile } from '../profiles.ts';
import {
  CHALLENGE_FRAME_PATTERN,
  challengeSelectors,
  inspectPage,
  type PageProblem,
  type PageSignals,
} from '../safety/challenges.ts';
import type { Pacing } from '../safety/pacing.ts';
import { originForLog, sanitizeMessage, SCREENSHOT_MASK_SELECTORS } from '../safety/redaction.ts';
import type { ScreenshotStore } from './screenshots.ts';
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

export interface SessionDependencies {
  profile: AutomationProfile;
  pacing: Pacing;
  screenshots: ScreenshotStore;
  logger: Logger;
  /** Each step's time unless it sets its own. */
  stepTimeoutMs: number;
  accountId: string;
  runId: string;
  /** Called once when the session closes, whatever happened (frees the runner's slot). */
  onClosed: () => void;
}

/** Bounds of what an inspection reads of the page. */
const INSPECTED_TEXT_LENGTH = 4_000;
const SCREENSHOT_TIMEOUT_MS = 5_000;

export class PlaywrightSession implements AutomationSession {
  readonly marketplace: Marketplace;
  readonly #context: BrowserContext;
  readonly #page: Page;
  readonly #deps: SessionDependencies;
  readonly #log: Logger;
  readonly #inspection: string;
  /** Every value typed or uploaded; error messages never repeat them. */
  readonly #typed = new Set<string>();
  #status: number | null = null;
  #retryAfterSeconds: number | null = null;
  #acceptDialog = false;
  /** The check that stopped the session; nothing runs after it. */
  #challenge: ChallengeKind | null = null;
  /** The page that stopped the current run, if one did. */
  #stoppedBy: PageProblem | null = null;
  #screenshots = 0;
  #closed: Promise<SessionCookie[]> | null = null;

  constructor(context: BrowserContext, page: Page, deps: SessionDependencies) {
    this.marketplace = deps.profile.marketplace;
    this.#context = context;
    this.#page = page;
    this.#deps = deps;
    this.#log = deps.logger.child({ marketplace: this.marketplace, runId: deps.runId });
    this.#inspection = inspectionScript(challengeSelectors(deps.profile));
    page.on('response', (response) => {
      this.#noteResponse(response);
    });
    page.on('dialog', (dialog) => {
      void this.#answerDialog(dialog);
    });
    // Scripts work in one page; a window the site opens is closed at once.
    page.on('popup', (popup) => {
      void popup.close().catch(() => undefined);
    });
  }

  run<T>(name: string, script: Script<T>, signal: AbortSignal): Promise<ScriptResult<T>> {
    return this.#execute(name, script, signal, false);
  }

  read<T>(name: string, script: Script<T>, signal: AbortSignal): Promise<ScriptResult<T>> {
    return this.#execute(name, script, signal, true);
  }

  close(): Promise<SessionCookie[]> {
    this.#closed ??= (async () => {
      try {
        const cookies = await this.#context.cookies().catch((): Cookie[] => []);
        return cookies
          .map(toSessionCookie)
          .filter((cookie) => cookieOnDomains(cookie, this.#deps.profile.cookieDomains));
      } finally {
        await this.#context.close().catch(() => undefined);
        this.#deps.onClosed();
      }
    })();
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
      this.#log.debug({ script: name, steps }, 'automation script finished');
      return { ok: true, value, mutated, steps };
    } catch (caught) {
      const stopped = this.#stop();
      const thrown = stopped === null ? caught : new PageProblemError(stopped);
      const failure = await this.#failure(thrown, current, signal);
      this.#log.warn(
        {
          script: name,
          step: failure.step,
          failure: failure.kind,
          ...(failure.kind === 'challenge' ? { challenge: failure.challenge } : {}),
          ...(failure.kind === 'error' ? { code: failure.code, reason: failure.message } : {}),
          origin: originForLog(this.#safeUrl()),
          mutated,
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
    // Playwright's own waits give up a little before the step does, so a missing element is
    // reported as one rather than as the step's timeout.
    this.#page.setDefaultTimeout(Math.floor(timeoutMs * 0.9));
    this.#page.setDefaultNavigationTimeout(Math.floor(timeoutMs * 0.9));
    const driver = new Driver(this, controller.signal, readOnly);
    let timer: NodeJS.Timeout | undefined;
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
      return { ...error(step, thrown.code, thrown.message), screenshotKey };
    }
    if (signal.aborted) return error(step, 'aborted', 'the run was stopped');
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return {
      ...error(step, 'script_error', sanitizeMessage(message, this.#typed)),
      screenshotKey: await this.#screenshot(),
    };
  }

  /** A redacted viewport screenshot in private storage; `null` when there is no page left. */
  async #screenshot(): Promise<string | null> {
    if (this.#page.isClosed()) return null;
    try {
      const page = this.#page;
      // A page load still under way (the step that timed out) holds every screenshot back.
      const cdp = await this.#context.newCDPSession(page);
      await cdp.send('Page.stopLoading').finally(() => cdp.detach().catch(() => undefined));
      const mask = [
        SCREENSHOT_MASK_SELECTORS.join(', '),
        ...this.#deps.profile.privateSelectors,
      ].map((selector) => page.locator(selector));
      const png = await page.screenshot({
        type: 'png',
        fullPage: false,
        mask,
        maskColor: '#000000',
        animations: 'disabled',
        caret: 'hide',
        timeout: SCREENSHOT_TIMEOUT_MS,
      });
      this.#screenshots += 1;
      return await this.#deps.screenshots.save(
        this.#deps.accountId,
        `${this.#deps.runId}-${String(this.#screenshots)}`,
        png,
      );
    } catch (thrown) {
      this.#log.warn(
        { err: sanitizedError(thrown, this.#typed) },
        'no screenshot of the failed run',
      );
      return null;
    }
  }

  #noteResponse(response: Response): void {
    const request = response.request();
    if (!request.isNavigationRequest() || response.frame() !== this.#page.mainFrame()) return;
    this.#status = response.status();
    const retryAfter = Number(response.headers()['retry-after']);
    this.#retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : null;
  }

  async #answerDialog(dialog: Dialog): Promise<void> {
    const accept = this.#acceptDialog && dialog.type() === 'confirm';
    this.#acceptDialog = false;
    await (accept ? dialog.accept() : dialog.dismiss()).catch(() => undefined);
  }

  #safeUrl(): string {
    return this.#page.isClosed() ? 'about:blank' : this.#page.url();
  }

  // For the page driver -----------------------------------------------------------------------

  get page(): Page {
    return this.#page;
  }

  get profile(): AutomationProfile {
    return this.#deps.profile;
  }

  get pacing(): Pacing {
    return this.#deps.pacing;
  }

  get status(): number | null {
    return this.#status;
  }

  noteTyped(value: string): void {
    this.#typed.add(value);
  }

  acceptNextDialog(): void {
    this.#acceptDialog = true;
  }

  clearStatus(): void {
    this.#status = null;
    this.#retryAfterSeconds = null;
  }

  /** The page that stopped the current run (set by `inspect` while the script runs). */
  #stop(): PageProblem | null {
    return this.#stoppedBy;
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
    const signals = await this.#signals();
    const problem = inspectPage(signals, this.#deps.profile);
    if (problem === null) return;
    this.#stoppedBy = problem;
    if (problem.type === 'challenge') this.#challenge = problem.kind;
    throw new PageProblemError(problem);
  }

  async #signals(): Promise<PageSignals> {
    const read = await this.#page.evaluate<
      Omit<PageSignals, 'url' | 'status' | 'retryAfterSeconds'>
    >(this.#inspection);
    return {
      url: this.#page.url(),
      status: this.#status,
      retryAfterSeconds: this.#retryAfterSeconds,
      ...read,
    };
  }

  /**
   * A Playwright failure as a step failure. A wait for an element that never came means the
   * page lacks what the script expects; a wait for a page load that never ended is the step
   * running out of time.
   */
  translate(thrown: unknown, waitingFor: 'element' | 'navigation' = 'element'): Error {
    if (thrown instanceof PageProblemError || thrown instanceof StepError) return thrown;
    if (thrown instanceof StepTimeoutError) return thrown;
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    const name = thrown instanceof Error ? thrown.name : '';
    if (name === 'TimeoutError') {
      return waitingFor === 'navigation'
        ? new StepTimeoutError('the page did not finish loading')
        : new StepError('element_missing', sanitizeMessage(message, this.#typed));
    }
    if (/net::ERR_|ECONNREFUSED|ENOTFOUND|NS_ERROR/.test(message)) {
      return new StepError('unreachable', 'the marketplace could not be reached');
    }
    if (
      /Target (page, context or browser )?(has been )?closed|browser has been closed/i.test(message)
    ) {
      return new StepError('aborted', 'the session was closed');
    }
    return new StepError('script_error', sanitizeMessage(message, this.#typed));
  }
}

/** What `inspect` reads in the page: one evaluation, bounded, returning plain data. */
function inspectionScript(selectors: readonly string[]): string {
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
  readonly #session: PlaywrightSession;
  readonly #signal: AbortSignal;
  readonly #readOnly: boolean;
  #retired = false;

  constructor(session: PlaywrightSession, signal: AbortSignal, readOnly: boolean) {
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
    await this.#act(async (page) => {
      this.#session.clearStatus();
      await this.#navigation(page.goto(target.href, { waitUntil: 'domcontentloaded' }));
    });
  }

  async click(selector: string): Promise<void> {
    await this.#act(async (page) => {
      this.#session.clearStatus();
      await page.locator(selector).click();
      await this.#navigation(page.waitForLoadState('domcontentloaded'));
    });
  }

  async fill(selector: string, text: string): Promise<void> {
    this.#input('fill');
    this.#session.noteTyped(text);
    await this.#act((page) => page.locator(selector).fill(text));
  }

  async type(selector: string, text: string): Promise<void> {
    this.#input('type');
    this.#session.noteTyped(text);
    await this.#act(async (page) => {
      const field = page.locator(selector);
      await field.focus();
      for (const character of text) {
        await this.#session.pacing.wait('keystroke', this.#signal);
        this.#active();
        await page.keyboard.type(character);
      }
    });
  }

  async select(selector: string, value: string): Promise<void> {
    this.#input('select');
    await this.#act(async (page) => {
      await page.locator(selector).selectOption(value);
    });
  }

  async check(selector: string, checked: boolean): Promise<void> {
    this.#input('check');
    await this.#act((page) => page.locator(selector).setChecked(checked));
  }

  async upload(selector: string, files: readonly UploadFile[]): Promise<void> {
    this.#input('upload');
    for (const file of files) this.#session.noteTyped(file.name);
    await this.#act((page) =>
      page
        .locator(selector)
        .setInputFiles(
          files.map((file) => ({ name: file.name, mimeType: file.mimeType, buffer: file.buffer })),
        ),
    );
  }

  acceptNextDialog(): void {
    this.#input('acceptNextDialog');
    this.#active();
    this.#session.acceptNextDialog();
  }

  async waitFor(
    selector: string,
    state: 'attached' | 'detached' | 'visible' | 'hidden' = 'visible',
  ): Promise<void> {
    await this.#observe((page) => page.locator(selector).first().waitFor({ state }));
  }

  async waitForPath(pattern: RegExp): Promise<void> {
    await this.#observe((page) =>
      this.#navigation(
        page.waitForURL((url) => pattern.test(url.pathname), { waitUntil: 'domcontentloaded' }),
      ),
    );
  }

  url(): string {
    this.#active();
    return this.#session.page.url();
  }

  status(): number | null {
    this.#active();
    return this.#session.status;
  }

  exists(selector: string): Promise<boolean> {
    return this.#query(async (locator) => (await locator.count()) > 0, selector);
  }

  count(selector: string): Promise<number> {
    return this.#query((locator) => locator.count(), selector);
  }

  text(selector: string): Promise<string | null> {
    return this.#query(async (locator) => {
      if ((await locator.count()) === 0) return null;
      return (await locator.first().textContent())?.trim() ?? null;
    }, selector);
  }

  texts(selector: string): Promise<string[]> {
    return this.#query(
      async (locator) => (await locator.allTextContents()).map((text) => text.trim()),
      selector,
    );
  }

  attribute(selector: string, name: string): Promise<string | null> {
    return this.#query(async (locator) => {
      if ((await locator.count()) === 0) return null;
      return locator.first().getAttribute(name);
    }, selector);
  }

  attributes(selector: string, name: string): Promise<(string | null)[]> {
    return this.#query(
      (locator) =>
        locator.evaluateAll(
          (elements, attribute) =>
            elements.map((element) =>
              (element as { getAttribute(name: string): string | null }).getAttribute(attribute),
            ),
          name,
        ),
      selector,
    );
  }

  /** A page load, whose timeout is the step's. */
  async #navigation(loading: Promise<unknown>): Promise<void> {
    try {
      await loading;
    } catch (thrown) {
      throw this.#session.translate(thrown, 'navigation');
    }
  }

  /** A paced action, inspected afterwards. */
  async #act(action: (page: Page) => Promise<unknown>): Promise<void> {
    this.#active();
    await this.#session.pacing.wait('action', this.#signal);
    this.#active();
    try {
      await action(this.#session.page);
    } catch (thrown) {
      throw this.#session.translate(thrown);
    }
    this.#active();
    await this.#inspect();
  }

  /** A wait for the page, inspected afterwards (whether or not what it waited for came). */
  async #observe(wait: (page: Page) => Promise<unknown>): Promise<void> {
    this.#active();
    let failure: Error | null = null;
    try {
      await wait(this.#session.page);
    } catch (thrown) {
      failure = this.#session.translate(thrown);
    }
    this.#active();
    // A check that replaced the expected page is what stopped the wait.
    await this.#inspect();
    if (failure !== null) throw failure;
  }

  async #query<T>(read: (locator: Locator) => Promise<T>, selector: string): Promise<T> {
    this.#active();
    try {
      return await read(this.#session.page.locator(selector));
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

function sanitizedError(
  thrown: unknown,
  typed: Iterable<string>,
): { name: string; message: string } {
  const name = thrown instanceof Error ? thrown.name : 'Error';
  return {
    name,
    message: sanitizeMessage(thrown instanceof Error ? thrown.message : String(thrown), typed),
  };
}

function toSessionCookie(cookie: Cookie): SessionCookie {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.expires > 0 ? cookie.expires : -1,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
  };
}
