/**
 * The page backend a recording session runs a script through (record.ts): the seller's own
 * browser tab's backend, with every page action, every state the page was in after one, every
 * data global the script read, and every read of the marketplace's web API written down
 * (recording.ts).
 *
 * A state is captured as late as it can be: just before the next action (or when the script
 * ends), and only when the script looked at the page since the last one. That is the page the
 * script's reads saw at their latest and the one its next action acted on, so a replay that
 * shows it after the action answers the same reads and checks the same target. A keystroke run
 * (`PageDriver.type`) is one action: nothing looks at the page between its keys.
 */
import type { InspectedPage, PageBackend } from '../runner/script-session.ts';
import type { CapturedState, RecordedApiAnswer, RecordedEvent } from './recording.ts';
import { snapshotScript, type Snapshot } from './snapshot.ts';

/** An event, its `state` -1 until the state after it is captured. */
type PendingEvent = RecordedEvent;

export class RecordingBackend implements PageBackend {
  readonly events: PendingEvent[] = [];
  readonly states: CapturedState[] = [];
  readonly api: RecordedApiAnswer[] = [];
  /** The texts of the private parts of the pages captured: redacted wherever they appear. */
  readonly privateTexts = new Set<string>();
  readonly #inner: PageBackend;
  readonly #snapshot: string;
  /** Events whose state is the next one captured. */
  #pending: number[] = [];
  /** Whether the script looked at the page since the last capture. */
  #observed = false;
  /** Data globals read since the last capture. */
  #data: Record<string, unknown> = {};
  /** The session forgot the status for the next action, which the state before it keeps. */
  #clearStatus = false;

  constructor(inner: PageBackend, privateSelectors: readonly string[]) {
    this.#inner = inner;
    this.#snapshot = snapshotScript(privateSelectors);
  }

  /** Captures the page now as the state after the actions since the last capture, if any. */
  async capture(): Promise<void> {
    if (this.#pending.length === 0) return;
    const snapshot = (await this.#inner.read(this.#snapshot)) as Partial<Snapshot> | null;
    const html = snapshot?.html;
    if (typeof html !== 'string') throw new Error('the page could not be serialized');
    for (const text of snapshot?.privateTexts ?? []) this.privateTexts.add(text);
    const url = this.#inner.url();
    const previous = this.states.at(-1);
    const navigated = this.#pending.some((index) => this.events[index]?.op === 'goto');
    // A global stays on its page: the data read before carries on until the page changes.
    const carried = previous?.url === url && !navigated ? previous.data : {};
    const index =
      this.states.push({
        url,
        status: this.#inner.status(),
        data: { ...carried, ...this.#data },
        lines: html.split('\n'),
      }) - 1;
    for (const event of this.#pending) {
      const pending = this.events[event];
      if (pending !== undefined) pending.state = index;
    }
    this.#pending = [];
    this.#observed = false;
    this.#data = {};
  }

  async #act(event: PendingEvent, perform: () => Promise<void>): Promise<void> {
    // Actions nothing looked at the page between share the state after the last of them.
    if (this.#observed) await this.capture();
    // The status the session forgot before this action is the page's until now.
    if (this.#clearStatus) {
      this.#clearStatus = false;
      this.#inner.clearStatus();
    }
    this.#pending.push(this.events.push(event) - 1);
    await perform();
  }

  #look(): void {
    this.#observed = true;
  }

  setTimeout(ms: number): void {
    this.#inner.setTimeout(ms);
  }

  goto(href: string): Promise<void> {
    return this.#act({ op: 'goto', url: href, state: -1 }, () => this.#inner.goto(href));
  }

  click(selector: string): Promise<void> {
    return this.#act({ op: 'click', selector, state: -1 }, () => this.#inner.click(selector));
  }

  fill(selector: string, text: string): Promise<void> {
    return this.#act({ op: 'fill', selector, text, state: -1 }, () =>
      this.#inner.fill(selector, text),
    );
  }

  focus(selector: string): Promise<void> {
    return this.#act({ op: 'focus', selector, typed: '', state: -1 }, () =>
      this.#inner.focus(selector),
    );
  }

  async press(character: string): Promise<void> {
    const last = this.events.at(-1);
    if (last?.op !== 'focus') throw new Error('a key was pressed without a focused field');
    last.typed += character;
    await this.#inner.press(character);
  }

  select(selector: string, value: string): Promise<void> {
    return this.#act({ op: 'select', selector, value, state: -1 }, () =>
      this.#inner.select(selector, value),
    );
  }

  check(selector: string, checked: boolean): Promise<void> {
    return this.#act({ op: 'check', selector, checked, state: -1 }, () =>
      this.#inner.check(selector, checked),
    );
  }

  /** Never: a recording sends no photo to the marketplace. */
  upload(): Promise<void> {
    return Promise.reject(new Error('a recording session uploads nothing'));
  }

  acceptNextDialog(): void {
    this.#inner.acceptNextDialog();
  }

  waitFor(selector: string, state: 'attached' | 'detached' | 'visible' | 'hidden'): Promise<void> {
    this.#look();
    return this.#inner.waitFor(selector, state);
  }

  waitForPath(pattern: RegExp): Promise<void> {
    this.#look();
    return this.#inner.waitForPath(pattern);
  }

  url(): string {
    this.#look();
    return this.#inner.url();
  }

  status(): number | null {
    this.#look();
    return this.#clearStatus ? null : this.#inner.status();
  }

  retryAfterSeconds(): number | null {
    return this.#clearStatus ? null : this.#inner.retryAfterSeconds();
  }

  clearStatus(): void {
    this.#clearStatus = true;
  }

  exists(selector: string): Promise<boolean> {
    this.#look();
    return this.#inner.exists(selector);
  }

  count(selector: string): Promise<number> {
    this.#look();
    return this.#inner.count(selector);
  }

  text(selector: string): Promise<string | null> {
    this.#look();
    return this.#inner.text(selector);
  }

  texts(selector: string): Promise<string[]> {
    this.#look();
    return this.#inner.texts(selector);
  }

  attribute(selector: string, name: string): Promise<string | null> {
    this.#look();
    return this.#inner.attribute(selector, name);
  }

  attributes(selector: string, name: string): Promise<(string | null)[]> {
    this.#look();
    return this.#inner.attributes(selector, name);
  }

  value(selector: string): Promise<string | null> {
    this.#look();
    return this.#inner.value(selector);
  }

  async pageData(name: string): Promise<unknown> {
    this.#look();
    const value = await this.#inner.pageData(name);
    this.#data[name] = value;
    return value;
  }

  inspect(script: string): Promise<InspectedPage> {
    this.#look();
    return this.#inner.inspect(script);
  }

  async read(script: string): Promise<unknown> {
    this.#look();
    const answer = await this.#inner.read(script);
    const url = apiGetUrl(script);
    if (url !== null) this.api.push(apiAnswer(url, answer));
    return answer;
  }

  screenshot(): Promise<string | null> {
    // A recording keeps the page itself; it takes no screenshot.
    return Promise.resolve(null);
  }
}

/** The URL an `apiGetScript` (runner/script-session.ts) reads, or `null` for another script. */
export function apiGetUrl(script: string): string | null {
  const found = /await fetch\(("(?:[^"\\]|\\.)*")/.exec(script)?.[1];
  if (found === undefined) return null;
  try {
    const url: unknown = JSON.parse(found);
    return typeof url === 'string' ? url : null;
  } catch {
    return null;
  }
}

function apiAnswer(url: string, answer: unknown): RecordedApiAnswer {
  const read = (answer ?? {}) as { status?: unknown; retryAfter?: unknown; text?: unknown };
  const status = typeof read.status === 'number' ? read.status : 0;
  const retryAfter = typeof read.retryAfter === 'string' ? read.retryAfter : null;
  const text = typeof read.text === 'string' ? read.text : null;
  if (text !== null) {
    try {
      return { url, status, retryAfter, json: JSON.parse(text) as unknown };
    } catch {
      // Not JSON: kept as text.
    }
  }
  return { url, status, retryAfter, text };
}
