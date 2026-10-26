/**
 * Test-only: the phone runtime's host played by Playwright's headless Chromium instead of the
 * iPhone app's web view, so this package's tests run the phone's own code (runtime, backend,
 * page functions, and the marketplace scripts) against the fake marketplace sites. `PhoneTestSessions`
 * serves an automation adapter's session requests through it, the way the server's phone
 * transcript serves them from the phone's answers, so the shared conformance suites run on the
 * phone runtime unchanged. The app's own bridge is tested on the iPhone simulator
 * (PhoneExecutionFeatureTests).
 */
import type { Browser, Page, Response } from 'playwright-core';

import type { AutomationSessions, SessionRequest, SessionRun } from '../adapter/sessions.ts';
import type { AutomationProfile } from '../profiles.ts';
import { loadChromium } from '../runner/playwright.ts';
import { TINY_JPEG, type SessionIssuer } from '../test-support.ts';
import { toBase64 } from './backend.ts';
import type { HandOffAnswer, HostPageState, HostPhoto, PhoneHost } from './host.ts';
import { PHONE_RUNTIME_VERSION, runPhoneCall, type PhoneCallInput } from './runtime.ts';

/** How long after an action a page load it started has to begin to be waited for. */
const SETTLE_GRACE_MS = 150;

export class PlaywrightPhoneHost implements PhoneHost {
  readonly page: Page;
  /** Every check the runtime handed to the seller, in order. */
  readonly handOffs: { kind: string; marketplace: string }[] = [];
  /** What the "seller" does with the next checks; the default answer after them. */
  answers: (HandOffAnswer | (() => Promise<HandOffAnswer>))[] = [];
  defaultAnswer: HandOffAnswer = 'unavailable';
  #status: number | null = null;
  #retryAfter: number | null = null;
  #acceptDialog = false;

  constructor(page: Page) {
    this.page = page;
    page.on('response', (response) => {
      this.#note(response);
    });
    page.on('dialog', (dialog) => {
      const accept = this.#acceptDialog && dialog.type() === 'confirm';
      this.#acceptDialog = false;
      void (accept ? dialog.accept() : dialog.dismiss()).catch(() => undefined);
    });
  }

  async navigate(url: string, timeoutMs: number): Promise<HostPageState> {
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    } catch (thrown) {
      throw hostError(thrown);
    }
    return this.state();
  }

  async evaluate(body: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const work = this.page.evaluate(
      async ([source, named]) => {
        const AsyncFunction = (async () => {
          await Promise.resolve();
        }).constructor as new (
          ...parameters: string[]
        ) => (...values: unknown[]) => Promise<unknown>;
        const names = Object.keys(named);
        return new AsyncFunction(...names, source)(...names.map((name) => named[name]));
      },
      [body, args] as const,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('timeout'));
      }, timeoutMs);
    });
    try {
      return await Promise.race([work, deadline]);
    } catch (thrown) {
      throw hostError(thrown);
    } finally {
      clearTimeout(timer);
    }
  }

  async settle(timeoutMs: number): Promise<HostPageState> {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_GRACE_MS));
    try {
      await this.page.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
    } catch (thrown) {
      throw hostError(thrown);
    }
    return this.state();
  }

  state(): Promise<HostPageState> {
    return Promise.resolve({
      url: this.page.url(),
      status: this.#status,
      retryAfterSeconds: this.#retryAfter,
    });
  }

  acceptNextDialog(): Promise<void> {
    this.#acceptDialog = true;
    return Promise.resolve();
  }

  fetchPhoto(url: string): Promise<HostPhoto> {
    return Promise.resolve({
      name: url.split('/').at(-1) ?? 'photo.jpg',
      mimeType: 'image/jpeg',
      base64: toBase64(TINY_JPEG),
    });
  }

  async handOff(check: { kind: string; marketplace: string }): Promise<HandOffAnswer> {
    this.handOffs.push(check);
    const next = this.answers.shift() ?? this.defaultAnswer;
    return typeof next === 'function' ? next() : next;
  }

  log(): void {
    // Tests read results, not logs.
  }

  #note(response: Response): void {
    if (!response.request().isNavigationRequest() || response.frame() !== this.page.mainFrame()) {
      return;
    }
    this.#status = response.status();
    const retryAfter = Number(response.headers()['retry-after']);
    this.#retryAfter = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : null;
  }
}

function hostError(thrown: unknown): Error {
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  const name = thrown instanceof Error ? thrown.name : '';
  if (name === 'TimeoutError' || message === 'timeout') return new Error('timeout');
  if (/net::ERR_|ECONNREFUSED/.test(message)) return new Error('unreachable');
  if (/closed/i.test(message)) return new Error('closed');
  // A page function's own failure (`element_timeout: ...`) passes through as it is.
  return new Error(message.replace(/^page\.evaluate: (Error: )?/, '').split('\n')[0]);
}

/**
 * An automation adapter's sessions run by the phone runtime in Chromium: each run is a fresh
 * page with a freshly issued session cookie, its call is the request's `call`, and the
 * profile's settings travel as the server would send them.
 */
export class PhoneTestSessions implements AutomationSessions {
  readonly requests: SessionRequest[] = [];
  readonly hosts: PlaywrightPhoneHost[] = [];
  /**
   * Sets up each run's host before it runs. By default the seller declines every check, so a
   * session the marketplace rejected asks for a new link, as it does on the runner.
   */
  prepare: (host: PlaywrightPhoneHost) => void = (host) => {
    host.defaultAnswer = 'declined';
  };
  readonly #browser: Promise<Browser>;
  readonly #site: SessionIssuer;
  readonly #profile: AutomationProfile;
  readonly #stepTimeoutMs: number;

  constructor(site: SessionIssuer, profile: AutomationProfile, stepTimeoutMs: number) {
    this.#browser = loadChromium().then((chromium) => chromium.launch({ headless: true }));
    this.#site = site;
    this.#profile = profile;
    this.#stepTimeoutMs = stepTimeoutMs;
  }

  async use<T>(request: SessionRequest): Promise<SessionRun<T>> {
    this.requests.push(request);
    const browser = await this.#browser;
    // The app's off-screen web view is desktop-sized and asks for desktop pages, as the runner's
    // browser does.
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      storageState: { cookies: [{ ...this.#site.issueSession() }], origins: [] },
    });
    try {
      const host = new PlaywrightPhoneHost(await context.newPage());
      this.hosts.push(host);
      this.prepare(host);
      const input: PhoneCallInput = {
        runtimeVersion: PHONE_RUNTIME_VERSION,
        scriptSet: request.scriptSet,
        call: request.call,
        name: request.script,
        origins: [...this.#profile.origins],
        cookieDomains: [...this.#profile.cookieDomains],
        pacing: this.#profile.pacing,
        stepTimeoutMs: this.#stepTimeoutMs,
        callTimeoutMs: 60_000,
        startDelayMs: 0,
      };
      // What crosses the API is JSON, so the test sends it as JSON too.
      const output = await runPhoneCall(JSON.parse(JSON.stringify(input)) as PhoneCallInput, host, {
        pacing: { random: () => 0 },
      });
      return JSON.parse(JSON.stringify(output)) as SessionRun<T>;
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> {
    await (await this.#browser).close();
  }
}
