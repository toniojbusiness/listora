import { isLogLevel, type LogLevel } from '@listora/shared';

export interface WorkerConfig {
  logLevel: LogLevel;
}

/** Reads worker settings from the environment (see `.env.example`). */
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const logLevel = env['LOG_LEVEL'] ?? 'info';
  if (!isLogLevel(logLevel)) {
    throw new Error(
      'Invalid worker configuration: LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent',
    );
  }
  return { logLevel };
}
