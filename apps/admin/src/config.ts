import { isLogLevel, type LogLevel } from '@listora/shared';

export interface AdminConfig {
  readonly databaseUrl: string;
  readonly logLevel: LogLevel;
}

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid admin configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/**
 * Reads the admin CLI's settings from the environment (see `.env.example`). Error messages
 * name the offending key but never echo its value, because DATABASE_URL can hold a password.
 */
export function loadAdminConfig(env: NodeJS.ProcessEnv = process.env): AdminConfig {
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

  if (issues.length > 0 || !isLogLevel(logLevel)) throw new ConfigError(issues);
  return { databaseUrl, logLevel };
}
