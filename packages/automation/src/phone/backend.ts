/**
 * The phone's `PageBackend`: the shared session rules (runner/script-session.ts) drive the
 * seller's own web view in the iPhone app through its bridge (host.ts), evaluating the page
 * functions in dom.ts. The page's URL and navigation status are the app's, refreshed by every
 * navigation, page load, and inspection.
 *
 * The phone takes no screenshots: a failed run's evidence is its steps and its error code, and
 * the seller's page never leaves their phone.
 */
import type { InspectedPage, PageBackend } from '../runner/script-session.ts';
import {
  PageBackendError,
  parsePageData,
  type PageBackendFailure,
} from '../runner/script-session.ts';
import type { UploadFile } from '../runner/types.ts';
import { CHECK, CLICK, FILL, FOCUS, PRESS, QUERY, SELECT, UPLOAD, WAIT_FOR } from './dom.ts';
import { HOST_FAILURES, type HostPageState, type PhoneHost } from './host.ts';

/** Extra time a host call gets over the wait it runs, so the page's own timeout reports first. */
const HOST_MARGIN_MS = 2_000;
/** How often a wait for the main frame's path looks at it. */
const PATH_POLL_MS = 100;

export class BridgeBackend implements PageBackend {
  readonly #host: PhoneHost;
  #waitMs = 30_000;
  #state: HostPageState = { url: 'about:blank', status: null, retryAfterSeconds: null };

  constructor(host: PhoneHost) {
    this.#host = host;
  }

  setTimeout(ms: number): void {
    this.#waitMs = ms;
  }

  async goto(href: string): Promise<void> {
    this.#state = await this.#call('navigation', () => this.#host.navigate(href, this.#waitMs));
  }

  async click(selector: string): Promise<void> {
    await this.#page(CLICK, { selector });
    this.#state = await this.#call('navigation', () => this.#host.settle(this.#waitMs));
  }

  async fill(selector: string, text: string): Promise<void> {
    await this.#page(FILL, { selector, text });
  }

  async focus(selector: string): Promise<void> {
    await this.#page(FOCUS, { selector });
  }

  async press(character: string): Promise<void> {
    await this.#page(PRESS, { character });
  }

  async select(selector: string, value: string): Promise<void> {
    await this.#page(SELECT, { selector, value });
  }

  async check(selector: string, checked: boolean): Promise<void> {
    await this.#page(CHECK, { selector, checked });
  }

  async upload(selector: string, files: readonly UploadFile[]): Promise<void> {
    await this.#page(UPLOAD, {
      selector,
      files: files.map((file) => ({
        name: file.name,
        mimeType: file.mimeType,
        base64: toBase64(file.bytes),
      })),
    });
  }

  acceptNextDialog(): void {
    void this.#host.acceptNextDialog().catch(() => undefined);
  }

  async waitFor(
    selector: string,
    state: 'attached' | 'detached' | 'visible' | 'hidden',
  ): Promise<void> {
    await this.#page(WAIT_FOR, { selector, state });
  }

  async waitForPath(pattern: RegExp): Promise<void> {
    const end = Date.now() + this.#waitMs;
    for (;;) {
      this.#state = await this.#call('navigation', () => this.#host.state());
      const path = URL.canParse(this.#state.url) ? new URL(this.#state.url).pathname : '';
      if (pattern.test(path)) break;
      if (Date.now() >= end) {
        throw new PageBackendError('navigation_timeout', 'the page never reached the path');
      }
      await sleep(PATH_POLL_MS);
    }
    this.#state = await this.#call('navigation', () =>
      this.#host.settle(Math.max(0, end - Date.now())),
    );
  }

  url(): string {
    return this.#state.url;
  }

  status(): number | null {
    return this.#state.status;
  }

  retryAfterSeconds(): number | null {
    return this.#state.retryAfterSeconds;
  }

  clearStatus(): void {
    this.#state = { ...this.#state, status: null, retryAfterSeconds: null };
  }

  async exists(selector: string): Promise<boolean> {
    return (await this.count(selector)) > 0;
  }

  async count(selector: string): Promise<number> {
    return expectNumber(await this.#page(QUERY, { selector, what: 'count', name: null }));
  }

  async text(selector: string): Promise<string | null> {
    return expectText(await this.#page(QUERY, { selector, what: 'text', name: null }));
  }

  async texts(selector: string): Promise<string[]> {
    return expectTexts(await this.#page(QUERY, { selector, what: 'texts', name: null }));
  }

  async attribute(selector: string, name: string): Promise<string | null> {
    return expectText(await this.#page(QUERY, { selector, what: 'attribute', name }));
  }

  async attributes(selector: string, name: string): Promise<(string | null)[]> {
    const values = await this.#page(QUERY, { selector, what: 'attributes', name });
    if (!Array.isArray(values)) throw new PageBackendError('other', 'the page sent no list');
    return values.map(expectText);
  }

  async pageData(name: string): Promise<unknown> {
    return parsePageData(
      await this.#call('element', () => this.#host.pageData(name, this.#waitMs + HOST_MARGIN_MS)),
    );
  }

  async inspect(script: string): Promise<InspectedPage> {
    // The URL a script reads after an action is the one its inspection saw.
    this.#state = await this.#call('navigation', () => this.#host.state());
    return (await this.#call('element', () =>
      this.#host.evaluate(`return ${script};`, {}, this.#waitMs + HOST_MARGIN_MS),
    )) as InspectedPage;
  }

  screenshot(): Promise<string | null> {
    return Promise.resolve(null);
  }

  /** Evaluates one of dom.ts's functions with the step's wait. */
  #page(body: string, args: Record<string, unknown>): Promise<unknown> {
    return this.#call('element', () =>
      this.#host.evaluate(
        body,
        { ...args, timeoutMs: this.#waitMs },
        this.#waitMs + HOST_MARGIN_MS,
      ),
    );
  }

  /** A host call, its failure in the session's terms. */
  async #call<T>(kind: 'element' | 'navigation', work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (thrown) {
      throw backendError(thrown, kind);
    }
  }
}

function backendError(thrown: unknown, kind: 'element' | 'navigation'): PageBackendError {
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  if (message.startsWith('element_timeout'))
    return new PageBackendError('element_timeout', message);
  const failure = HOST_FAILURES.find((candidate) => candidate === message);
  const mapped: PageBackendFailure =
    failure === undefined
      ? 'other'
      : failure === 'timeout'
        ? kind === 'navigation'
          ? 'navigation_timeout'
          : 'element_timeout'
        : failure === 'closed'
          ? 'closed'
          : 'unreachable';
  return new PageBackendError(mapped, message);
}

function expectNumber(value: unknown): number {
  if (typeof value !== 'number') throw new PageBackendError('other', 'the page sent no number');
  return value;
}

function expectText(value: unknown): string | null {
  if (value !== null && typeof value !== 'string') {
    throw new PageBackendError('other', 'the page sent no text');
  }
  return value;
}

function expectTexts(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new PageBackendError('other', 'the page sent no texts');
  }
  return value;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let start = 0; start < bytes.length; start += chunk) {
    binary += String.fromCharCode(...bytes.subarray(start, start + chunk));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
