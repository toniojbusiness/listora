import { pino, type DestinationStream, type Logger } from 'pino';

export type { Logger } from 'pino';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Log paths that may carry credentials. Marketplace tokens and auth headers must never reach
 * logs; add new sensitive field names here rather than redacting at call sites.
 */
export const REDACTED_LOG_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.clientSecret',
  '*.apiKey',
];

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

export interface LoggerOptions {
  /** Process name, for example `api` or `worker`; added to every line as `service`. */
  service: string;
  level: LogLevel;
  /** Defaults to stdout. Tests pass an in-memory stream. */
  destination?: DestinationStream;
}

/** Structured JSON logger used by every backend process. */
export function createLogger(options: LoggerOptions): Logger {
  return pino(
    {
      level: options.level,
      base: { service: options.service },
      redact: { paths: REDACTED_LOG_PATHS, censor: '[redacted]' },
    },
    options.destination,
  );
}
