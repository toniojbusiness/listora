/**
 * The server's side of a phone run (docs/features/phone-execution.md): automation sessions
 * answered from a transcript of the phone's answers. An operation step, a session check, or a
 * sale check runs on the server exactly as it would with the browser runner (the executor, the
 * automation adapter, the checks' own code), except that each script call is answered by the
 * phone. The server runs the step again for every answer it gets (the step is a pure function of
 * the answers), so the first call it has no answer for is the one the phone runs next, and a
 * step all of whose calls are answered has its result. Nothing the phone says decides more than
 * a runner's answer would: the server maps it to an outcome, and only a read-back it asked for
 * can confirm a change.
 */
import type { JsonValue } from '@listora/db';

import type { ScriptCall, ScriptSet } from '../adapter/script-call.ts';
import type { AutomationSessions, SessionRequest, SessionRun } from '../adapter/sessions.ts';
import { readPhoneAnswer } from './answers.ts';

/** One answered call: what was asked, and the phone's (or the server's own) answer. */
export interface TranscriptEntry {
  /** `callKey` of the request, so a later run of the step can tell it asks the same. */
  key: string;
  run: SessionRun<unknown>;
}

/** The call a step needs answered next. */
export interface PendingCall {
  index: number;
  request: SessionRequest;
}

/** What answers no call: a step run with it stops short of anything it would do with an answer. */
const UNANSWERED: SessionRun<never> = { type: 'busy', retryAfterMs: 0 };

export class TranscriptSessions implements AutomationSessions {
  readonly #entries: readonly TranscriptEntry[];
  #next = 0;
  #pending: PendingCall | null = null;
  #diverged = false;

  constructor(entries: readonly TranscriptEntry[]) {
    this.#entries = entries;
  }

  /** The first call this run had no answer for, if any. */
  get pending(): PendingCall | null {
    return this.#pending;
  }

  /** Whether this run asked something else than the transcript answered (a different step). */
  get diverged(): boolean {
    return this.#diverged;
  }

  use<T>(request: SessionRequest): Promise<SessionRun<T>> {
    const index = this.#next;
    this.#next += 1;
    const entry = this.#entries[index];
    if (entry === undefined) {
      this.#pending ??= { index, request };
      return Promise.resolve(UNANSWERED);
    }
    if (entry.key !== callKey(request)) {
      this.#diverged = true;
      return Promise.resolve(UNANSWERED);
    }
    // The phone's answer, checked again as it is read back (its times become dates again); the
    // server's own answers (a rate limit) are as it stored them.
    const run =
      entry.run.type === 'ran' || entry.run.type === 'no_session'
        ? readPhoneAnswer(request.call, entry.run)
        : entry.run;
    return Promise.resolve(run as SessionRun<T>);
  }
}

/** What identifies a call: whose scripts, and the call with its input (key order ignored). */
export function callKey(request: { scriptSet: ScriptSet; call: ScriptCall }): string {
  return stableJson({ scriptSet: request.scriptSet, call: request.call });
}

/** JSON with every object's keys sorted, so equal values give equal text (as jsonb stores them). */
export function stableJson(value: unknown): string {
  return JSON.stringify(sorted(value));
}

function sorted(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .flatMap((key) => {
          const item = (value as Record<string, unknown>)[key];
          return item === undefined ? [] : [[key, sorted(item)]];
        }),
    );
  }
  return value as JsonValue;
}
