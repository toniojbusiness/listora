import type { ErrorResponse, FieldError, KnownErrorCode } from '@listora/api-contract';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** Codes an HTTP response can carry; the other two appear only inside a failed authorization. */
export type HttpErrorCode = Exclude<
  KnownErrorCode,
  'marketplace_authorization_denied' | 'marketplace_authorization_failed'
>;

/** HTTP status per error code, exactly as `KnownErrorCode` in openapi.yaml documents them. */
export const ERROR_STATUS = {
  invalid_request: 400,
  unauthenticated: 401,
  quota_exceeded: 402,
  forbidden: 403,
  not_found: 404,
  version_conflict: 409,
  invalid_state_transition: 409,
  already_exists: 409,
  idempotency_key_in_progress: 409,
  upload_incomplete: 409,
  upload_expired: 409,
  marketplace_not_connected: 409,
  marketplace_reauth_required: 409,
  marketplace_action_unavailable: 409,
  app_update_required: 409,
  payload_too_large: 413,
  validation_failed: 422,
  idempotency_key_reused: 422,
  rate_limited: 429,
  ai_budget_exceeded: 429,
  internal_error: 500,
  service_unavailable: 503,
} as const satisfies Record<HttpErrorCode, number>;

/** Codes whose request can succeed later unchanged (retried with the same Idempotency-Key). */
const RETRYABLE_CODES: ReadonlySet<HttpErrorCode> = new Set([
  'idempotency_key_in_progress',
  'rate_limited',
  'ai_budget_exceeded',
  'internal_error',
  'service_unavailable',
]);

/** The contract's `fieldErrors` holds at most 100 entries. */
const MAX_FIELD_ERRORS = 100;

export interface ApiErrorOptions {
  fieldErrors?: readonly FieldError[];
  retryAfterSeconds?: number;
  cause?: unknown;
}

/**
 * An error with a contract error code. Route code throws it; the error handler turns it into
 * an `ErrorResponse`. `message` must be safe to show to the user: no secrets, no internals.
 */
export class ApiError extends Error {
  readonly code: HttpErrorCode;
  readonly statusCode: number;
  readonly fieldErrors: readonly FieldError[] | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: HttpErrorCode, message: string, options: ApiErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = ERROR_STATUS[code];
    this.fieldErrors = options.fieldErrors;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  get retryable(): boolean {
    return RETRYABLE_CODES.has(this.code);
  }
}

/** `422 validation_failed` with one entry per problem. */
export function validationFailed(fieldErrors: readonly FieldError[], message?: string): ApiError {
  return new ApiError(
    'validation_failed',
    message ?? 'Some fields are invalid. Fix them and try again.',
    { fieldErrors },
  );
}

export function notFound(what: string): ApiError {
  return new ApiError('not_found', `${what} was not found.`);
}

export function errorBody(error: ApiError, requestId: string): ErrorResponse {
  const fieldErrors = error.fieldErrors?.slice(0, MAX_FIELD_ERRORS);
  return {
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      requestId,
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: error.retryAfterSeconds }),
      ...(fieldErrors && fieldErrors.length > 0 ? { fieldErrors } : {}),
    },
  };
}

export function sendError(reply: FastifyReply, error: ApiError): FastifyReply {
  if (error.retryAfterSeconds !== undefined) {
    reply.header('retry-after', String(error.retryAfterSeconds));
  }
  if (error.code === 'unauthenticated') reply.header('www-authenticate', 'Bearer');
  return reply.code(error.statusCode).send(errorBody(error, reply.request.id));
}

/**
 * Every error leaves the API as an `ErrorResponse`. Fastify's own errors (malformed JSON, a
 * body over the size limit, an unsupported content type) map to the contract's codes; anything
 * unexpected becomes `500 internal_error` with a generic message, and only the log has details.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const apiError = toApiError(error);
    if (apiError.statusCode >= 500) {
      request.log.error({ err: error }, 'request failed');
    } else if (!(error instanceof ApiError)) {
      request.log.info({ err: error }, 'request rejected');
    }
    return sendError(reply, apiError);
  });

  app.setNotFoundHandler((request, reply) =>
    sendError(reply, new ApiError('not_found', 'There is no such endpoint.')),
  );
}

function toApiError(error: FastifyError): ApiError {
  if (error instanceof ApiError) return error;
  switch (error.code) {
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return new ApiError('payload_too_large', 'The request body is too large.');
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return new ApiError('invalid_request', 'Send the request body as application/json.');
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
      return new ApiError('invalid_request', 'The request body is not valid JSON.');
    default:
      break;
  }
  // Fastify's body parser reports malformed JSON as a plain 400 SyntaxError.
  if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
    return new ApiError('invalid_request', 'The request is malformed.');
  }
  return new ApiError('internal_error', 'Something went wrong on our side. Try again.', {
    cause: error,
  });
}
