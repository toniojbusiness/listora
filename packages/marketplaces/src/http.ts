/**
 * HTTP for adapters (JSON, or encoded text such as eBay's XML), with the one distinction the
 * operation engine depends on: was the request possibly received? A failure while connecting
 * means it was not sent, so trying
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

/** `HttpResult` with the response body as text, for APIs that do not speak JSON (eBay XML). */
export type HttpTextResult =
  | { type: 'response'; status: number; headers: Headers; text: string }
  | Exclude<HttpResult, { type: 'response' }>;

export interface JsonRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Caller cancellation (for example the worker shutting down). */
  signal: AbortSignal;
  timeoutMs: number;
}

/** A request whose body is already encoded; `headers` must name its content type. */
export interface TextRequest extends Omit<JsonRequest, 'body'> {
  body?: string;
}

export async function requestJson(request: JsonRequest): Promise<HttpResult> {
  const { body, headers, ...rest } = request;
  const result = await requestText({
    ...rest,
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (result.type !== 'response') return result;
  const { text, ...response } = result;
  return { ...response, body: parse(text) };
}

export async function requestText(request: TextRequest): Promise<HttpTextResult> {
  const timeout = AbortSignal.timeout(request.timeoutMs);
  const signal = AbortSignal.any([request.signal, timeout]);
  try {
    const response = await fetch(request.url, {
      method: request.method,
      ...(request.headers === undefined ? {} : { headers: request.headers }),
      ...(request.body === undefined ? {} : { body: request.body }),
      signal,
    });
    const text = await response.text();
    return { type: 'response', status: response.status, headers: response.headers, text };
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
