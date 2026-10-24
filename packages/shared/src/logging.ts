import { pino, type DestinationStream, type Logger } from 'pino';

export type { Logger } from 'pino';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const SENSITIVE_LOG_FIELDS = [
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'clientSecret',
  'apiKey',
] as const;

/** Deepest nesting level (0 = top-level field) at which sensitive fields are redacted. */
export const MAX_REDACTED_FIELD_DEPTH = 4;

/**
 * Log paths that may carry credentials. Marketplace tokens and auth headers must never reach
 * logs; add new sensitive field names to SENSITIVE_LOG_FIELDS rather than redacting at call
 * sites. Pino's redaction has no recursive wildcard, so each field is matched at the top level
 * and under up to MAX_REDACTED_FIELD_DEPTH levels of nesting; never log credential-bearing
 * objects nested deeper than that.
 */
export const REDACTED_LOG_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  ...SENSITIVE_LOG_FIELDS.flatMap((field) =>
    Array.from(
      { length: MAX_REDACTED_FIELD_DEPTH + 1 },
      (_, depth) => `${'*.'.repeat(depth)}${field}`,
    ),
  ),
];

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

export interface LoggerOptions {
  /** Process name, for example `api` or `worker`; added to every line as `service`. */
  service: string;
  level: LogLevel;
  /** Defaults to synchronous stdout. Tests pass an in-memory stream. */
  destination?: DestinationStream;
}

/**
 * Structured JSON logger used by every backend process. Stdout is written synchronously: with
 * pino's default asynchronous writer, `process.exit()` flushes buffered lines while an earlier
 * write is still in flight, so the last lines before an exit can land out of order or be lost.
 */
export function createLogger(options: LoggerOptions): Logger {
  return pino(
    {
      level: options.level,
      base: { service: options.service },
      redact: { paths: REDACTED_LOG_PATHS, censor: '[redacted]' },
    },
    options.destination ?? pino.destination({ dest: 1, sync: true }),
  );
}
