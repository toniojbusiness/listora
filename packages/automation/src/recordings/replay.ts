/**
 * Runs a marketplace's script against a recording (recording.ts) of the real pages, in a real
 * headless Chromium, the way the browser runner runs it against the marketplace: the same
 * session rules (`ScriptSession`: steps, the read-only rule, the page inspection after every
 * action), the same Playwright backend for every read, and the marketplace's own addresses. Only
 * the network is the recording's: every request the page makes is answered from it, so nothing
 * reaches a marketplace.
 *
 * It runs on the host the recording was made on (`host`): the phone runtime's backend and page
 * functions (phone/), as the iPhone app runs Depop, Mercari, and Poshmark, or the runner's.
 *
 * The page is the recorded document of the moment: the state before an action is the one the
 * live action acted on, so each action is checked there (a click's target is there, visible,
 * enabled, and the only match; a field takes input) and must be the one the recording made next
 * (the same kind, selector, and text). The page then shows the state the action led to. A
 * script that acts differently has diverged from the recording: the run fails, and
 * `divergences` says how, so a changed script is re-recorded rather than tested against pages
 * it never saw. Reads (the API's included) are answered by the recorded pages themselves, so a
 * selector, a data key, or a parser the real page no longer satisfies fails here as it would
 * live.
 */
import type { Browser, BrowserContext, Page, Route } from 'playwright-core';

import type { SessionCookie } from '@listora/connections';

import type { AutomationProfile } from '../profiles.ts';
import { NetworkLog } from '../runner/network-log.ts';
import { MemoryScreenshotStore } from '../runner/screenshots.ts';
import {
  PageBackendError,
  ScriptSession,
  type InspectedPage,
  type PageBackend,
} from '../runner/script-session.ts';
import { BridgeBackend } from '../phone/backend.ts';
import { PlaywrightPhoneHost } from '../phone/test-host.ts';
import { PlaywrightBackend } from '../runner/session.ts';
import type { Script, ScriptResult, UploadFile } from '../runner/types.ts';
import { Pacing } from '../safety/pacing.ts';
import { silentLogger, TINY_JPEG } from '../test-support.ts';
import type {
  CapturedState,
  ExpandedRecording,
  RecordedEvent,
  RecordingHost,
} from './recording.ts';
import { replayDocument } from './snapshot.ts';

/** How long a replay's waits look for an element: a recorded page never changes by itself. */
const REPLAY_WAIT_MS = 2_000;

/** No pacing: a replay waits for nothing. */
const NO_PACING = {
  actionDelayMs: [0, 0],
  keystrokeDelayMs: [0, 0],
  sessionGapMs: [0, 0],
} as const;

export interface Replay<T> {
  result: ScriptResult<T>;
  /** How the script acted differently from the recording, in order; empty when it did not. */
  divergences: string[];
}

/** Runs `script` against the recording in `browser`; a read runs as one (`read`). */
export async function replayRecording<T>(
  browser: Browser,
  recording: ExpandedRecording,
  options: { profile: AutomationProfile; stepTimeoutMs: number; read: boolean },
  script: Script<T>,
): Promise<Replay<T>> {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    const backend = new ReplayBackend(context, page, recording, options.profile);
    await context.route('**/*', (route) => backend.answer(route));
    const session = new ScriptSession(backend, {
      profile: options.profile,
      pacing: new Pacing(NO_PACING),
      logger: silentLogger,
      stepTimeoutMs: options.stepTimeoutMs,
      close: () => Promise.resolve<SessionCookie[]>([]),
    });
    const signal = new AbortController().signal;
    const result = options.read
      ? await session.read(recording.name, script, signal)
      : await session.run(recording.name, script, signal);
    backend.finish(result.ok);
    return { result, divergences: backend.divergences };
  } finally {
    await context.close();
  }
}

class ReplayBackend implements PageBackend {
  readonly divergences: string[] = [];
  readonly #page: Page;
  readonly #inner: PageBackend;
  readonly #host: RecordingHost;
  readonly #recording: ExpandedRecording;
  /** The next recorded event the script must make. */
  #next = 0;
  /** Where the current focus event's typed keys are up to. */
  #typed = 0;
  /** The state the page shows (-1: none yet), and the one a navigation now gets. */
  #shown = -1;
  #serving = -1;
  /** API answers already given, by their index in the recording. */
  readonly #answered = new Set<number>();

  constructor(
    context: BrowserContext,
    page: Page,
    recording: ExpandedRecording,
    profile: AutomationProfile,
  ) {
    this.#page = page;
    this.#recording = recording;
    this.#host = recording.host;
    this.#inner =
      recording.host === 'phone'
        ? new BridgeBackend(new PlaywrightPhoneHost(page))
        : new PlaywrightBackend(
            context,
            page,
            {
              profile,
              pacing: new Pacing(NO_PACING),
              screenshots: new MemoryScreenshotStore(),
              logger: silentLogger,
              stepTimeoutMs: REPLAY_WAIT_MS,
              accountId: 'replay',
              runId: recording.name,
              network: new NetworkLog(),
              onClosed: () => undefined,
            },
            silentLogger,
          );
  }

  /** Answers one of the page's requests from the recording; nothing goes to the network. */
  async answer(route: Route): Promise<void> {
    const request = route.request();
    const url = request.url();
    if (request.isNavigationRequest() && request.frame() === this.#page.mainFrame()) {
      const state = this.#recording.states[this.#serving];
      if (state === undefined) {
        await route.fulfill({ status: 404, body: '' });
        return;
      }
      // A redirect the live navigation followed (Depop sends a seller to their product's
      // manage page) is followed here too.
      if (url !== state.url) {
        await route.fulfill({ status: 302, headers: { location: state.url }, body: '' });
        return;
      }
      await route.fulfill({
        status: state.status ?? 200,
        contentType: 'text/html; charset=utf-8',
        body: replayDocument(state.lines, state.data),
      });
      return;
    }
    const cors = { 'access-control-allow-origin': '*' };
    if (request.method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          ...cors,
          'access-control-allow-methods': 'GET',
          'access-control-allow-headers': 'accept, authorization',
        },
      });
      return;
    }
    if (request.method() === 'GET') {
      const index = this.#apiAnswer(url);
      const recorded = index === null ? undefined : this.#recording.api[index];
      if (index !== null && recorded !== undefined) {
        this.#answered.add(index);
        await route.fulfill({
          status: recorded.status,
          headers: {
            ...cors,
            'content-type': 'application/json',
            ...(recorded.retryAfter === null ? {} : { 'retry-after': recorded.retryAfter }),
          },
          body: recorded.json === undefined ? (recorded.text ?? '') : JSON.stringify(recorded.json),
        });
        return;
      }
      if (request.resourceType() === 'image') {
        await route.fulfill({
          status: 200,
          contentType: 'image/jpeg',
          body: Buffer.from(TINY_JPEG),
        });
        return;
      }
    }
    await route.fulfill({ status: 404, headers: cors, body: '' });
  }

  /** The recorded answer to a read of `url`: the first not yet given, else the last given. */
  #apiAnswer(url: string): number | null {
    let last: number | null = null;
    for (const [index, recorded] of this.#recording.api.entries()) {
      if (recorded.url !== url) continue;
      if (!this.#answered.has(index)) return index;
      last = index;
    }
    return last;
  }

  /** Notes the recorded actions a finished script never made. */
  finish(ok: boolean): void {
    const left = this.#recording.events.slice(this.#next);
    if (ok && left.length > 0 && this.divergences.length === 0) {
      this.divergences.push(
        `the script finished before the recording's ${describe(left[0])} (${String(left.length)} recorded actions left)`,
      );
    }
  }

  /** The next recorded event, which must be the one the script makes now. */
  #expect(made: string, matches: (event: RecordedEvent) => boolean): RecordedEvent {
    const event = this.#recording.events[this.#next];
    if (event === undefined || !matches(event)) {
      const message = `the script ${made} where the recording ${event === undefined ? 'had no more actions' : describe(event)}`;
      this.divergences.push(message);
      throw new PageBackendError('other', `the replay diverged from the recording: ${message}`);
    }
    this.#next += 1;
    this.#typed = 0;
    return event;
  }

  /** Shows the state an action led to. */
  async #show(index: number): Promise<void> {
    if (index === this.#shown) return;
    const state: CapturedState | undefined = this.#recording.states[index];
    if (state === undefined) throw new PageBackendError('other', 'the recording has no such state');
    this.#serving = index;
    this.#shown = index;
    await this.#inner.goto(state.url);
  }

  /**
   * Checks the action's target on the recorded page the way the recording's host would act on
   * it (the runner: Playwright's actionability, without acting; the phone: its page functions'
   * one match), then shows the state the action led to.
   */
  async #acted(
    event: RecordedEvent,
    selector: string,
    check: () => Promise<unknown>,
  ): Promise<void> {
    try {
      if (this.#host === 'runner') await check();
      else {
        const matches = await this.#inner.count(selector);
        if (matches !== 1) throw new Error(`${String(matches)} elements match, not one`);
      }
    } catch (thrown) {
      throw new PageBackendError(
        'element_timeout',
        `the recorded page does not take the action: ${thrown instanceof Error ? (thrown.message.split('\n')[0] ?? '') : String(thrown)}`,
      );
    }
    await this.#show(event.state);
  }

  setTimeout(ms: number): void {
    this.#inner.setTimeout(Math.min(ms, REPLAY_WAIT_MS));
  }

  async goto(href: string): Promise<void> {
    const event = this.#expect(
      `opened ${href}`,
      (recorded) => recorded.op === 'goto' && recorded.url === href,
    );
    await this.#show(event.state);
  }

  async click(selector: string): Promise<void> {
    const event = this.#expect(
      `clicked ${selector}`,
      (recorded) => recorded.op === 'click' && recorded.selector === selector,
    );
    await this.#acted(event, selector, () =>
      this.#page.locator(selector).click({ trial: true, timeout: REPLAY_WAIT_MS }),
    );
  }

  async fill(selector: string, text: string): Promise<void> {
    const event = this.#expect(
      `filled ${selector}`,
      (recorded) =>
        recorded.op === 'fill' && recorded.selector === selector && recorded.text === text,
    );
    await this.#acted(event, selector, () =>
      this.#page.locator(selector).fill(text, { timeout: REPLAY_WAIT_MS }),
    );
  }

  async focus(selector: string): Promise<void> {
    const event = this.#expect(
      `focused ${selector}`,
      (recorded) => recorded.op === 'focus' && recorded.selector === selector,
    );
    await this.#acted(event, selector, () =>
      this.#page.locator(selector).focus({ timeout: REPLAY_WAIT_MS }),
    );
  }

  press(character: string): Promise<void> {
    const event = this.#recording.events[this.#next - 1];
    if (event?.op !== 'focus' || event.typed[this.#typed] !== character) {
      const message = `the script typed a key the recording did not type there`;
      this.divergences.push(message);
      return Promise.reject(
        new PageBackendError('other', `the replay diverged from the recording: ${message}`),
      );
    }
    this.#typed += 1;
    return Promise.resolve();
  }

  async select(selector: string, value: string): Promise<void> {
    const event = this.#expect(
      `selected ${value} in ${selector}`,
      (recorded) =>
        recorded.op === 'select' && recorded.selector === selector && recorded.value === value,
    );
    await this.#acted(event, selector, () =>
      this.#page.locator(selector).selectOption(value, { timeout: REPLAY_WAIT_MS }),
    );
  }

  async check(selector: string, checked: boolean): Promise<void> {
    const event = this.#expect(
      `${checked ? 'checked' : 'unchecked'} ${selector}`,
      (recorded) =>
        recorded.op === 'check' && recorded.selector === selector && recorded.checked === checked,
    );
    await this.#acted(event, selector, () =>
      this.#page.locator(selector).setChecked(checked, { trial: true, timeout: REPLAY_WAIT_MS }),
    );
  }

  async upload(selector: string, files: readonly UploadFile[]): Promise<void> {
    const names = files.map((file) => file.name);
    const event = this.#expect(
      `uploaded to ${selector}`,
      (recorded) =>
        recorded.op === 'upload' &&
        recorded.selector === selector &&
        recorded.files.join('\n') === names.join('\n'),
    );
    await this.#acted(event, selector, () => this.#page.locator(selector).count());
  }

  acceptNextDialog(): void {
    this.#inner.acceptNextDialog();
  }

  waitFor(selector: string, state: 'attached' | 'detached' | 'visible' | 'hidden'): Promise<void> {
    return this.#inner.waitFor(selector, state);
  }

  waitForPath(pattern: RegExp): Promise<void> {
    return this.#inner.waitForPath(pattern);
  }

  url(): string {
    return this.#inner.url();
  }

  status(): number | null {
    return this.#recording.states[this.#shown]?.status ?? null;
  }

  retryAfterSeconds(): number | null {
    return null;
  }

  clearStatus(): void {
    // The status is the recorded state's.
  }

  exists(selector: string): Promise<boolean> {
    return this.#inner.exists(selector);
  }

  count(selector: string): Promise<number> {
    return this.#inner.count(selector);
  }

  text(selector: string): Promise<string | null> {
    return this.#inner.text(selector);
  }

  texts(selector: string): Promise<string[]> {
    return this.#inner.texts(selector);
  }

  attribute(selector: string, name: string): Promise<string | null> {
    return this.#inner.attribute(selector, name);
  }

  attributes(selector: string, name: string): Promise<(string | null)[]> {
    return this.#inner.attributes(selector, name);
  }

  value(selector: string): Promise<string | null> {
    return this.#inner.value(selector);
  }

  pageData(name: string): Promise<unknown> {
    return this.#inner.pageData(name);
  }

  inspect(script: string): Promise<InspectedPage> {
    return this.#inner.inspect(script);
  }

  read(script: string): Promise<unknown> {
    return this.#inner.read(script);
  }

  screenshot(): Promise<string | null> {
    return Promise.resolve(null);
  }
}

function describe(event: RecordedEvent | undefined): string {
  if (event === undefined) return 'nothing';
  switch (event.op) {
    case 'goto':
      return `opened ${event.url}`;
    case 'click':
      return `clicked ${event.selector}`;
    case 'focus':
      return `focused ${event.selector}`;
    case 'fill':
      return `filled ${event.selector}`;
    case 'select':
      return `selected ${event.value} in ${event.selector}`;
    case 'check':
      return `${event.checked ? 'checked' : 'unchecked'} ${event.selector}`;
    case 'upload':
      return `uploaded to ${event.selector}`;
  }
}
