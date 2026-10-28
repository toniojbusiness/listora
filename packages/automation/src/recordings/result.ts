/** What a script got, as a recording keeps it (recording.ts): plain JSON, comparable. */
import type { ScriptFailure, ScriptResult } from '../runner/types.ts';
import type { RecordedResult } from './recording.ts';

export function recordedResult(result: ScriptResult<unknown>): RecordedResult {
  if (result.ok) {
    return { ok: true, value: JSON.parse(JSON.stringify(result.value ?? null)) as unknown };
  }
  return { ok: false, failure: failureSummary(result.failure) };
}

/** A failure as a recording keeps it: no screenshot key, no evidence. */
export function failureSummary(failure: ScriptFailure): Record<string, unknown> {
  switch (failure.kind) {
    case 'challenge':
      return { kind: failure.kind, challenge: failure.challenge, step: failure.step };
    case 'timeout':
      return { kind: failure.kind, step: failure.step };
    case 'error':
      return {
        kind: failure.kind,
        code: failure.code,
        step: failure.step,
        message: failure.message,
      };
  }
}
