/**
 * One seller's browser session on Playwright: the browser runner's `PageBackend` for the shared
 * session rules (script-session.ts). It keeps what only Playwright knows: the main frame's
 * navigation status, the page's dialogs and popups, Playwright's errors in the session's terms,
 * and the redacted screenshot of a failed run (every form field and the profile's private
 * elements blacked out, in private storage).
 */
import type { BrowserContext, Cookie, Dialog, Page, Response } from 'playwright-core';

import type { Logger } from '@listora/shared';
import { cookieOnDomains, type SessionCookie } from '@listora/connections';

import type { AutomationProfile } from '../profiles.ts';
import type { Pacing } from '../safety/pacing.ts';
import { sanitizedError, SCREENSHOT_MASK_SELECTORS } from '../safety/redaction.ts';
import {
  PageBackendError,
  parsePageData,
  ScriptSession,
  type InspectedPage,
  type PageBackend,
} from './script-session.ts';
import type { NetworkLog } from './network-log.ts';
import type { ScreenshotStore } from './screenshots.ts';
import type { UploadFile } from './types.ts';

export interface SessionDependencies {
  profile: AutomationProfile;
  pacing: Pacing;
  screenshots: ScreenshotStore;
  logger: Logger;
  /** Each step's time unless it sets its own. */
  stepTimeoutMs: number;
  accountId: string;
  runId: string;
  /** What the session's network did, logged when a run stops (network-log.ts). */
  network: NetworkLog;
  /** Called once when the session closes, whatever happened (frees the runner's slot). */
  onClosed: () => void;
}

const SCREENSHOT_TIMEOUT_MS = 5_000;

export class PlaywrightSession extends ScriptSession {
  readonly #page: Page;

  constructor(context: BrowserContext, page: Page, deps: SessionDependencies) {
    const log = deps.logger.child({ marketplace: deps.profile.marketplace, runId: deps.runId });
    const backend = new PlaywrightBackend(context, page, deps, log);
    super(backend, {
      profile: deps.profile,
      pacing: deps.pacing,
      logger: log,
      stepTimeoutMs: deps.stepTimeoutMs,
      networkSummary: () => deps.network.summary(),
      close: async () => {
        try {
          const cookies = await context.cookies().catch((): Cookie[] => []);
          return cookies
            .map(toSessionCookie)
            .filter((cookie) => cookieOnDomains(cookie, deps.profile.cookieDomains));
        } finally {
          await context.close().catch(() => undefined);
          deps.onClosed();
        }
      },
    });
    this.#page = page;
  }

  /** The page itself, for tests that look at it. */
  get page(): Page {
    return this.#page;
  }
}

class PlaywrightBackend implements PageBackend {
  readonly #context: BrowserContext;
  readonly #page: Page;
  readonly #deps: SessionDependencies;
  readonly #log: Logger;
  #status: number | null = null;
  #retryAfterSeconds: number | null = null;
  #acceptDialog = false;
  #screenshots = 0;

  constructor(context: BrowserContext, page: Page, deps: SessionDependencies, log: Logger) {
    this.#context = context;
    this.#page = page;
    this.#deps = deps;
    this.#log = log;
    page.on('response', (response) => {
      this.#noteResponse(response);
      deps.network.response(response.url(), response.status());
    });
    page.on('requestfailed', (request) => {
      deps.network.failed(request.url(), request.failure()?.errorText ?? 'failed');
    });
    page.on('dialog', (dialog) => {
      void this.#answerDialog(dialog);
    });
    // Scripts work in one page; a window the site opens is closed at once.
    page.on('popup', (popup) => {
      void popup.close().catch(() => undefined);
    });
  }

  setTimeout(ms: number): void {
    this.#page.setDefaultTimeout(ms);
    this.#page.setDefaultNavigationTimeout(ms);
  }

  async goto(href: string): Promise<void> {
    await navigation(this.#page.goto(href, { waitUntil: 'domcontentloaded' }));
  }

  async click(selector: string): Promise<void> {
    await element(this.#page.locator(selector).click());
    await navigation(this.#page.waitForLoadState('domcontentloaded'));
  }

  async fill(selector: string, text: string): Promise<void> {
    await element(this.#page.locator(selector).fill(text));
  }

  async focus(selector: string): Promise<void> {
    await element(this.#page.locator(selector).focus());
  }

  async press(character: string): Promise<void> {
    await element(this.#page.keyboard.type(character));
  }

  async select(selector: string, value: string): Promise<void> {
    await element(this.#page.locator(selector).selectOption(value));
  }

  async check(selector: string, checked: boolean): Promise<void> {
    await element(this.#page.locator(selector).setChecked(checked));
  }

  async upload(selector: string, files: readonly UploadFile[]): Promise<void> {
    await element(
      this.#page.locator(selector).setInputFiles(
        files.map((file) => ({
          name: file.name,
          mimeType: file.mimeType,
          buffer: Buffer.from(file.bytes),
        })),
      ),
    );
  }

  acceptNextDialog(): void {
    this.#acceptDialog = true;
  }

  async waitFor(
    selector: string,
    state: 'attached' | 'detached' | 'visible' | 'hidden',
  ): Promise<void> {
    await element(this.#page.locator(selector).first().waitFor({ state }));
  }

  async waitForPath(pattern: RegExp): Promise<void> {
    await navigation(
      this.#page.waitForURL((url) => pattern.test(url.pathname), { waitUntil: 'domcontentloaded' }),
    );
  }

  url(): string {
    return this.#page.isClosed() ? 'about:blank' : this.#page.url();
  }

  status(): number | null {
    return this.#status;
  }

  retryAfterSeconds(): number | null {
    return this.#retryAfterSeconds;
  }

  clearStatus(): void {
    this.#status = null;
    this.#retryAfterSeconds = null;
  }

  exists(selector: string): Promise<boolean> {
    return element(
      this.#page
        .locator(selector)
        .count()
        .then((count) => count > 0),
    );
  }

  count(selector: string): Promise<number> {
    return element(this.#page.locator(selector).count());
  }

  text(selector: string): Promise<string | null> {
    const locator = this.#page.locator(selector);
    return element(
      (async () => {
        if ((await locator.count()) === 0) return null;
        return (await locator.first().textContent())?.trim() ?? null;
      })(),
    );
  }

  texts(selector: string): Promise<string[]> {
    return element(
      this.#page
        .locator(selector)
        .allTextContents()
        .then((texts) => texts.map((text) => text.trim())),
    );
  }

  value(selector: string): Promise<string | null> {
    const locator = this.#page.locator(selector);
    return element(
      (async () => {
        if ((await locator.count()) === 0) return null;
        return locator.first().evaluate((node): string | null => {
          const value: unknown = (node as unknown as { value?: unknown }).value;
          return typeof value === 'string' ? value : null;
        });
      })(),
    );
  }

  attribute(selector: string, name: string): Promise<string | null> {
    const locator = this.#page.locator(selector);
    return element(
      (async () => {
        if ((await locator.count()) === 0) return null;
        return locator.first().getAttribute(name);
      })(),
    );
  }

  attributes(selector: string, name: string): Promise<(string | null)[]> {
    return element(
      this.#page
        .locator(selector)
        .evaluateAll(
          (elements, attribute) =>
            elements.map((node) =>
              (node as { getAttribute(name: string): string | null }).getAttribute(attribute),
            ),
          name,
        ),
    );
  }

  async pageData(name: string): Promise<unknown> {
    // `page.evaluate` runs in the page's own world, where its scripts keep their data.
    const text = await element(
      this.#page.evaluate((key) => {
        const value: unknown = (globalThis as Record<string, unknown>)[key];
        return value === undefined ? null : JSON.stringify(value);
      }, name),
    );
    return parsePageData(text);
  }

  inspect(script: string): Promise<InspectedPage> {
    return element(this.#page.evaluate<InspectedPage>(script));
  }

  read(script: string): Promise<unknown> {
    return element(this.#page.evaluate<unknown>(script));
  }

  async screenshot(typed: ReadonlySet<string>): Promise<string | null> {
    if (this.#page.isClosed()) return null;
    const url = URL.canParse(this.#page.url()) ? new URL(this.#page.url()) : null;
    if (url === null || !this.#deps.profile.origins.includes(url.origin)) return null;
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
      this.#log.warn({ err: sanitizedError(thrown, typed) }, 'no screenshot of the failed run');
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
}

/** An action on an element: Playwright's failures in the session's terms. */
async function element<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (thrown) {
    throw backendError(thrown, 'element_timeout');
  }
}

/** A page load, whose timeout is the step's. */
async function navigation<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (thrown) {
    throw backendError(thrown, 'navigation_timeout');
  }
}

/**
 * A Playwright failure as a backend failure. A wait for an element that never came means the
 * page lacks what the script expects; a wait for a page load that never ended is the step
 * running out of time.
 */
function backendError(
  thrown: unknown,
  timeout: 'element_timeout' | 'navigation_timeout',
): PageBackendError {
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  const name = thrown instanceof Error ? thrown.name : '';
  if (name === 'TimeoutError') return new PageBackendError(timeout, message);
  if (/net::ERR_|ECONNREFUSED|ENOTFOUND|NS_ERROR/.test(message)) {
    return new PageBackendError('unreachable', message);
  }
  if (
    /Target (page, context or browser )?(has been )?closed|browser has been closed/i.test(message)
  ) {
    return new PageBackendError('closed', message);
  }
  return new PageBackendError('other', message);
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
