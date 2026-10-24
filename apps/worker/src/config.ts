import { isLogLevel, type LogLevel } from '@listora/shared';

export interface WorkerConfig {
  databaseUrl: string;
  logLevel: LogLevel;
  /** Operation steps run at the same time. */
  concurrency: number;
  /** Base URL of the fake marketplace every adapter uses (development and tests only). */
  fakeMarketplaceUrl: string | undefined;
}

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid worker configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/**
 * Reads worker settings from the environment (see `.env.example`). Error messages name the
 * offending key but never echo its value, because values such as DATABASE_URL hold secrets.
 */
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const issues: string[] = [];

  const databaseUrl = env['DATABASE_URL'] ?? '';
  if (databaseUrl === '') {
    issues.push('DATABASE_URL is required');
  } else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    issues.push('DATABASE_URL must be a postgres:// URL');
  }

  const logLevel = env['LOG_LEVEL'] ?? 'info';
  if (!isLogLevel(logLevel)) {
    issues.push('LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent');
  }

  const rawConcurrency = env['WORKER_CONCURRENCY'] ?? '5';
  const concurrency = Number(rawConcurrency);
  if (!/^\d+$/.test(rawConcurrency) || concurrency < 1 || concurrency > 100) {
    issues.push('WORKER_CONCURRENCY must be an integer from 1 to 100');
  }

  // Empty means unset, as `FAKE_MARKETPLACE_URL=` in an env file.
  const rawFakeMarketplaceUrl = env['FAKE_MARKETPLACE_URL'];
  const fakeMarketplaceUrl = rawFakeMarketplaceUrl === '' ? undefined : rawFakeMarketplaceUrl;
  if (fakeMarketplaceUrl !== undefined && !/^https?:\/\/[^\s]+$/.test(fakeMarketplaceUrl)) {
    issues.push('FAKE_MARKETPLACE_URL must be an http:// or https:// URL');
  }

  if (issues.length > 0 || !isLogLevel(logLevel)) throw new ConfigError(issues);
  return { databaseUrl, logLevel, concurrency, fakeMarketplaceUrl };
}
