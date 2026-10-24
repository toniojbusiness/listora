/**
 * JSON over HTTP for adapters, with the one distinction the operation engine depends on: was
 * the request possibly received? A failure while connecting means it was not sent, so trying
 * again is safe. Any later failure (timeout, reset, abort) means it may have been applied, so
 * the engine must read the listing back before sending it again.
 */

/** Errors raised before the request left this process (DNS, refused or unreachable). */
const NOT_SENT_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

export type HttpResult =
  | { type: 'response'; status: number; headers: Headers; body: unknown }
  /** The request never left: retrying is safe. */
  | { type: 'not_sent'; code: string }
  /** The request may have been received and applied. */
  | { type: 'maybe_sent'; code: 'timeout' | 'aborted' | 'connection_lost' };

export interface JsonRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Caller cancellation (for example the worker shutting down). */
  signal: AbortSignal;
  timeoutMs: number;
}

export async function requestJson(request: JsonRequest): Promise<HttpResult> {
  const timeout = AbortSignal.timeout(request.timeoutMs);
  const signal = AbortSignal.any([request.signal, timeout]);
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: {
        accept: 'application/json',
        ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...request.headers,
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal,
    });
    const text = await response.text();
    return {
      type: 'response',
      status: response.status,
      headers: response.headers,
      body: parse(text),
    };
  } catch (error) {
    if (timeout.aborted) return { type: 'maybe_sent', code: 'timeout' };
    if (request.signal.aborted) return { type: 'maybe_sent', code: 'aborted' };
    const code = errorCode(error);
    if (code !== undefined && NOT_SENT_ERROR_CODES.has(code)) return { type: 'not_sent', code };
    return { type: 'maybe_sent', code: 'connection_lost' };
  }
}

function parse(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** The system error code of a failed fetch (`TypeError: fetch failed` wraps it in `cause`). */
function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string') return code;
    current = cause;
  }
  return undefined;
}
