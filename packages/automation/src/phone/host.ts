/**
 * What the iPhone app gives the phone runtime (docs/features/phone-execution.md): a thin bridge
 * to the off-screen web view that holds the seller's own marketplace session. The app only
 * relays: it loads pages, evaluates the runtime's own page functions (dom.ts), reports the main
 * frame's navigation, answers dialogs, fetches Listora's listing photos, and shows a check the
 * seller has to complete. Every rule (pacing, inspection, what a step may do, how a run ends)
 * stays in the runtime, which is the same TypeScript the browser runner runs.
 *
 * Every method rejects with an `Error` whose message is one of `HOST_FAILURES` when the bridge
 * knows why, or a short description otherwise.
 */
import type { PhoneStep } from './progress.ts';

/**
 * Why a host call failed, as the app reports it. `navigated`: the page loaded another document
 * while a page function ran, so the function's answer was lost with the old one.
 */
export const HOST_FAILURES = ['timeout', 'unreachable', 'blocked', 'closed', 'navigated'] as const;
export type HostFailure = (typeof HOST_FAILURES)[number];

/** The main frame, as the app last saw it. */
export interface HostPageState {
  url: string;
  /** The HTTP status of the main frame's last navigation, when there was one. */
  status: number | null;
  /** Its `Retry-After`, in seconds, when it sent one. */
  retryAfterSeconds: number | null;
}

/** A listing photo the app fetched from Listora's image URL. */
export interface HostPhoto {
  name: string;
  mimeType: string;
  /** The file's bytes, base64-encoded. */
  base64: string;
}

/**
 * What the seller did with a check the run stopped at: completed it in the in-app browser,
 * declined it (closed the browser), or could not be asked (the app is in the background).
 */
export type HandOffAnswer = 'completed' | 'declined' | 'unavailable';

export interface PhoneHost {
  /** Loads `url` in the main frame and waits for its document, within `timeoutMs`. */
  navigate(url: string, timeoutMs: number): Promise<HostPageState>;
  /**
   * Runs `body` as the body of an async function in the page, with `args` as its named
   * arguments, and resolves to its JSON result (WebKit's `callAsyncJavaScript`).
   */
  evaluate(body: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
  /**
   * The page's own global `name` serialized as JSON by the page (`JSON.stringify`), or `null`
   * when it has none. Unlike `evaluate`, this one fixed read runs in the page's own script
   * world, the only place a page's own data lives.
   */
  pageData(name: string, timeoutMs: number): Promise<string | null>;
  /** Waits, within `timeoutMs`, for a page load an action may have started to finish. */
  settle(timeoutMs: number): Promise<HostPageState>;
  /** The main frame now. */
  state(): Promise<HostPageState>;
  /** The page's next confirmation dialog is accepted; every other dialog is dismissed. */
  acceptNextDialog(): Promise<void>;
  /** Fetches one of Listora's listing photos over HTTPS. */
  fetchPhoto(url: string, timeoutMs: number): Promise<HostPhoto>;
  /**
   * Shows the page in a visible in-app browser so the seller can complete the check
   * themselves, and resolves once they are done. Listora never completes a check itself.
   */
  handOff(check: { kind: string; marketplace: string }): Promise<HandOffAnswer>;
  log(level: 'debug' | 'warn', message: string, fields: Record<string, unknown>): void;
  /**
   * The run started a step: the app shows where it is while it works. Like `log`, it is never
   * waited for and never fails the run (an app from before it answers that it doesn't know it).
   */
  progress(step: PhoneStep): void;
}
