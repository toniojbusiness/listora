/**
 * How an automation adapter gets a browser session for a connection. In the browser runner,
 * `RunnerSessions` (runner-sessions.ts) loads the seller's session from the vault, applies the
 * rate limit and the pause between sessions, opens the browser, records the run, stores the
 * cookies the marketplace refreshed, and asks the seller to relink when the page showed a check.
 * Every other process has `NoBrowserSessions`: automated steps never run there (the engine
 * hands them to the runner first), and one that tried would fail loudly, never silently.
 */
import type { AutomationRunPurpose } from '@listora/db';
import type { ConnectionRef } from '@listora/marketplaces';

import type { AutomationSession, ScriptResult } from '../runner/types.ts';

export interface SessionRequest {
  connection: ConnectionRef;
  purpose: AutomationRunPurpose;
  /** The operation an `operation` run is a step of; `null` for other runs. */
  operationId: string | null;
  /** What runs, for the run record and logs: `create`, `read listing`. */
  script: string;
}

export type SessionRun<T> =
  /** The script ran (or stopped); its result says how it went. */
  | { type: 'ran'; result: ScriptResult<T> }
  /** The connection holds no usable session: it waits for the seller to relink it. */
  | { type: 'no_session' }
  /** The seller's account had its share of runs for now; nothing was opened. */
  | { type: 'rate_limited'; retryAfterMs: number }
  /** Another runner is using this seller's session right now; nothing was opened. */
  | { type: 'busy'; retryAfterMs: number };

export interface AutomationSessions {
  /**
   * Runs `body` in the connection's browser session. `body` runs one script and returns its
   * result; the session closes when it returns. Throws only for a failure of Listora's own
   * (the database, the vault), never for what the marketplace's pages do.
   */
  use<T>(
    request: SessionRequest,
    body: (session: AutomationSession, signal: AbortSignal) => Promise<ScriptResult<T>>,
    signal: AbortSignal,
  ): Promise<SessionRun<T>>;
}

/** For processes without a browser (the worker, the API). */
export const NoBrowserSessions: AutomationSessions = {
  use: () =>
    Promise.reject(
      new Error('this process has no browser; automated steps run on the browser runner'),
    ),
};
