import { isLogLevel, type LogLevel } from '@listora/shared';

export interface ApiConfig {
  host: string;
  port: number;
  databaseUrl: string;
  logLevel: LogLevel;
}

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid API configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/**
 * Reads API settings from the environment (see `.env.example`). Error messages name the
 * offending key but never echo its value, because values such as DATABASE_URL hold secrets.
 */
export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const issues: string[] = [];

  const host = env['API_HOST'] ?? '127.0.0.1';

  const rawPort = env['API_PORT'] ?? '3000';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port > 65_535) {
    issues.push('API_PORT must be an integer from 0 to 65535');
  }

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

  if (issues.length > 0 || !isLogLevel(logLevel)) throw new ConfigError(issues);
  return { host, port, databaseUrl, logLevel };
}
