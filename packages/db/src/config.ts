import { isLogLevel, type LogLevel } from '@listora/shared';

export const MIGRATE_COMMANDS = ['latest', 'up', 'down', 'status'] as const;
export type MigrateCommand = (typeof MIGRATE_COMMANDS)[number];

export interface MigrateConfig {
  command: MigrateCommand;
  /** For `down`: the migration the caller expects to revert, which must be the latest one. */
  target: string | undefined;
  databaseUrl: string;
  logLevel: LogLevel;
}

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid migrate configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export const MIGRATE_USAGE =
  'usage: migrate latest | up | status | down <name of the latest applied migration>';

/**
 * Reads the migrate command's arguments and environment (see `.env.example`). Error messages
 * name the offending key but never echo its value, because DATABASE_URL can hold a password.
 */
export function loadMigrateConfig(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): MigrateConfig {
  const issues: string[] = [];

  const [rawCommand = 'latest', target, ...extra] = args;
  const command = MIGRATE_COMMANDS.find((known) => known === rawCommand);
  if (command === undefined) issues.push(`unknown command ${rawCommand}; ${MIGRATE_USAGE}`);
  if (command === 'down' && target === undefined) {
    issues.push(`down reverts one migration and needs its name; ${MIGRATE_USAGE}`);
  }
  if ((command !== 'down' && target !== undefined) || extra.length > 0) {
    issues.push(`unexpected arguments; ${MIGRATE_USAGE}`);
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

  if (issues.length > 0 || command === undefined || !isLogLevel(logLevel)) {
    throw new ConfigError(issues);
  }
  return { command, target, databaseUrl, logLevel };
}
