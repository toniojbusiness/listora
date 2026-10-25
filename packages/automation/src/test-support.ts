/**
 * Test-only helpers for this package's tests (not exported from the package): quick pacing, a
 * browser runner with in-memory screenshots, browser sessions on the fake site without a
 * database, and photos that need no network.
 */
import { createLogger, type Logger } from '@listora/shared';
import type { SessionCookie } from '@listora/vault';

import type { PhotoSource } from './adapter/photos.ts';
import type { AutomationSessions, SessionRequest, SessionRun } from './adapter/sessions.ts';
import type { FakeAutomationSite } from './fake-site/fake-site.ts';
import {
  automationProfile,
  standInProfile,
  type AutomatedMarketplace,
  type AutomationProfile,
} from './profiles.ts';
import { PlaywrightBrowserRunner } from './runner/browser-runner.ts';
import { MemoryScreenshotStore } from './runner/screenshots.ts';
import type { AutomationSession, ScriptResult } from './runner/types.ts';

export const silentLogger: Logger = createLogger({ service: 'automation-test', level: 'silent' });

/** Pacing a few milliseconds long, so tests stay quick but every wait still happens. */
export const QUICK_PACING = {
  actionDelayMs: [2, 4],
  keystrokeDelayMs: [0, 1],
  sessionGapMs: [0, 0],
} as const;

/** A marketplace's profile pointed at the fake site, with quick pacing. */
export function fakeSiteProfile(
  site: FakeAutomationSite,
  marketplace: AutomatedMarketplace = 'mercari',
): AutomationProfile {
  return { ...standInProfile(automationProfile(marketplace), site.url), pacing: QUICK_PACING };
}

export function testRunner(options: { stepTimeoutMs?: number } = {}) {
  const screenshots = new MemoryScreenshotStore();
  const runner = new PlaywrightBrowserRunner({
    logger: silentLogger,
    screenshots,
    stepTimeoutMs: options.stepTimeoutMs ?? 5_000,
  });
  return { runner, screenshots };
}

/** Stands in for a JPEG (start and end markers); the fake site only checks a photo came. */
export const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

/** Any photo URL gives the same tiny JPEG. */
export const stubPhotos: PhotoSource = {
  fetch: (url) =>
    Promise.resolve({
      name: url.split('/').at(-1) ?? 'photo.jpg',
      mimeType: 'image/jpeg',
      buffer: TINY_JPEG,
    }),
};

/**
 * Browser sessions on the fake site without a database: each run gets a freshly logged-in
 * session (as if the seller relinked at once), and checks are only recorded.
 */
export class FakeSiteSessions implements AutomationSessions {
  readonly challenges: string[] = [];
  readonly requests: SessionRequest[] = [];
  readonly #site: FakeAutomationSite;
  readonly #runner: PlaywrightBrowserRunner;
  readonly #profile: AutomationProfile;
  #runs = 0;

  constructor(
    site: FakeAutomationSite,
    runner: PlaywrightBrowserRunner,
    profile: AutomationProfile,
  ) {
    this.#site = site;
    this.#runner = runner;
    this.#profile = profile;
  }

  async use<T>(
    request: SessionRequest,
    body: (session: AutomationSession, signal: AbortSignal) => Promise<ScriptResult<T>>,
    signal: AbortSignal,
  ): Promise<SessionRun<T>> {
    this.requests.push(request);
    this.#runs += 1;
    const cookies: SessionCookie[] = [this.#site.issueSession()];
    const session = await this.#runner.openSession(
      { profile: this.#profile, cookies, accountId: 'account', runId: `run-${String(this.#runs)}` },
      signal,
    );
    try {
      const result = await body(session, signal);
      if (!result.ok && result.failure.kind === 'challenge') {
        this.challenges.push(result.failure.challenge);
      }
      return { type: 'ran', result };
    } finally {
      await session.close();
    }
  }
}
