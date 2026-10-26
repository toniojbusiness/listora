/**
 * The browser runner's Chromium (decision D1): headless, launched on the first session and kept
 * for the next ones while the runner process lives, one session at a time. Each session is a
 * fresh, isolated browser context holding only that seller's cookies for that marketplace.
 *
 * The browser is honest about what it is: Playwright's own headless Chromium, its own user
 * agent, no stealth plugins, no fingerprint or `navigator.webdriver` changes, no proxies. A
 * marketplace that wants to stop automation can, and the runner then stops (challenges.ts).
 */
import type { Browser, BrowserContext, BrowserType, Route } from 'playwright-core';

import type { Logger } from '@listora/shared';
import { cookieOnDomains } from '@listora/connections';

import type { AutomationProfile } from '../profiles.ts';
import { requestAllowed } from '../safety/network.ts';
import { Pacing, type PacingOptions } from '../safety/pacing.ts';
import { NetworkLog } from './network-log.ts';
import { loadChromium } from './playwright.ts';
import type { ScreenshotStore } from './screenshots.ts';
import { PlaywrightSession } from './session.ts';
import type { AutomationSession, BrowserRunner, SessionSpec } from './types.ts';

export interface PlaywrightBrowserRunnerOptions {
  logger: Logger;
  screenshots: ScreenshotStore;
  /** Each step's time unless the step sets its own (default 30 s). */
  stepTimeoutMs?: number;
  /** How long Chromium may take to start (default 30 s). */
  launchTimeoutMs?: number;
  /** Random and sleep for pacing (tests make them quick and repeatable). */
  pacing?: PacingOptions;
  /** Defaults to Playwright's Chromium (playwright.ts); tests may pass their own. */
  chromium?: () => Promise<BrowserType>;
}

/** Desktop-sized, so marketplaces serve their regular site. */
const VIEWPORT = { width: 1280, height: 900 };

export class PlaywrightBrowserRunner implements BrowserRunner {
  readonly #options: PlaywrightBrowserRunnerOptions;
  readonly #log: Logger;
  #browser: Promise<Browser> | null = null;
  /** Resolves when the current session closes; sessions queue behind it. */
  #slot: Promise<void> = Promise.resolve();
  #closing = false;

  constructor(options: PlaywrightBrowserRunnerOptions) {
    this.#options = options;
    this.#log = options.logger.child({ component: 'browser-runner' });
  }

  async openSession(spec: SessionSpec, signal: AbortSignal): Promise<AutomationSession> {
    if (this.#closing) throw new Error('the browser runner is closed');
    const release = await this.#acquire(signal);
    try {
      const browser = await this.#launch();
      const context = await browser.newContext({
        viewport: VIEWPORT,
        locale: 'en-US',
        acceptDownloads: false,
        serviceWorkers: 'block',
        storageState: {
          cookies: spec.cookies
            .filter((cookie) => cookieOnDomains(cookie, spec.profile.cookieDomains))
            .map((cookie) => ({ ...cookie })),
          origins: [],
        },
      });
      const network = new NetworkLog();
      const page = await guardNetwork(context, spec.profile, network)
        .then(() => context.newPage())
        .catch(async (error: unknown) => {
          await context.close().catch(() => undefined);
          throw error;
        });
      return new PlaywrightSession(context, page, {
        profile: spec.profile,
        pacing: new Pacing(spec.profile.pacing, this.#options.pacing),
        screenshots: this.#options.screenshots,
        logger: this.#log,
        stepTimeoutMs: this.#options.stepTimeoutMs ?? 30_000,
        accountId: spec.accountId,
        runId: spec.runId,
        network,
        onClosed: release,
      });
    } catch (error) {
      release();
      throw error;
    }
  }

  async close(): Promise<void> {
    this.#closing = true;
    const browser = this.#browser;
    this.#browser = null;
    if (browser === null) return;
    await browser.then((opened) => opened.close()).catch(() => undefined);
  }

  /** Waits for the session before this one to close; returns the release of this one. */
  async #acquire(signal: AbortSignal): Promise<() => void> {
    const previous = this.#slot;
    let release: () => void = () => undefined;
    this.#slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    let released = false;
    const once = (): void => {
      if (!released) {
        released = true;
        release();
      }
    };
    try {
      await Promise.race([
        previous,
        new Promise<never>((_, reject) => {
          if (signal.aborted) reject(new Error('aborted while waiting for the browser'));
          signal.addEventListener(
            'abort',
            () => {
              reject(new Error('aborted while waiting for the browser'));
            },
            { once: true },
          );
        }),
      ]);
    } catch (error) {
      // Keep the queue in order: this slot frees once the one before it does.
      void previous.then(once);
      throw error;
    }
    return once;
  }

  async #launch(): Promise<Browser> {
    this.#browser ??= (async () => {
      const chromium = await (this.#options.chromium ?? loadChromium)();
      const browser = await chromium.launch({
        headless: true,
        timeout: this.#options.launchTimeoutMs ?? 30_000,
      });
      browser.on('disconnected', () => {
        if (!this.#closing)
          this.#log.warn('the browser stopped; the next session starts a new one');
        this.#browser = null;
      });
      this.#log.info({ version: browser.version() }, 'browser started');
      return browser;
    })();
    try {
      return await this.#browser;
    } catch (error) {
      this.#browser = null;
      throw error;
    }
  }
}

/**
 * Checks every request of the session before Chromium sends it (safety/network.ts): the main
 * frame stays on the marketplace, and nothing reaches a private address. A refused request
 * fails in the page as if blocked by the client, and is counted in the session's network log.
 */
async function guardNetwork(
  context: BrowserContext,
  profile: AutomationProfile,
  network: NetworkLog,
): Promise<void> {
  await context.route('**/*', async (route: Route) => {
    const request = route.request();
    let mainFrame = false;
    if (request.isNavigationRequest()) {
      try {
        mainFrame = request.frame().parentFrame() === null;
      } catch {
        // A request without a frame (a service worker's; they are blocked) is no navigation.
      }
    }
    if (requestAllowed(request.url(), mainFrame, profile)) {
      await route.fallback();
    } else {
      network.refused(request.url());
      await route.abort('blockedbyclient');
    }
  });
  await context.routeWebSocket(/.*/, async (socket) => {
    if (requestAllowed(socket.url(), false, profile)) {
      socket.connectToServer();
    } else {
      network.refused(socket.url());
      await socket.close({ code: 1008, reason: 'blocked' });
    }
  });
}
