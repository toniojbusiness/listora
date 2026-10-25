import { USER_POOL_ID_PATTERN, userPoolRegion } from '@listora/accounts';
import {
  AiConfigError,
  loadAiAlertConfig,
  loadAiConfig,
  type AiAlertThresholds,
  type AiConfig,
} from '@listora/ai';
import { AnalysisConfigError, loadAnalysisConfig, type AnalysisConfig } from '@listora/analysis';
import { EbayConfigError, loadEbayConfig, type EbayConfig } from '@listora/marketplaces';
import { isLogLevel, type LogLevel } from '@listora/shared';
import { loadStorageConfig, StorageConfigError, type StorageConfig } from '@listora/storage';

export interface WorkerConfig {
  databaseUrl: string;
  logLevel: LogLevel;
  /** Marketplace operation steps run at the same time. */
  concurrency: number;
  /** Photo processing and item analysis jobs run at the same time, in their own pool. */
  taskConcurrency: number;
  /** Base URL of the fake marketplace every adapter uses (development and tests only). */
  fakeMarketplaceUrl: string | undefined;
  /** EBAY_* keys, read by @listora/marketplaces; `undefined` when EBAY_ENV is unset. */
  ebay: EbayConfig | undefined;
  /** STORAGE_* keys, read by @listora/storage: where photo processing and analysis read. */
  storage: StorageConfig;
  /** AI_* keys, read by @listora/ai: the provider and guards item analysis calls through. */
  ai: AiConfig;
  /** AI_AUTO_ESCALATE, read by @listora/analysis. */
  analysis: AnalysisConfig;
  /**
   * The Cognito user pool whose users account deletion deletes (COGNITO_USER_POOL_ID; its
   * region comes from the id). Undefined without one: Cognito account deletions then wait.
   */
  cognitoUserPool: { region: string; userPoolId: string } | undefined;
  /** Thresholds of the hourly AI spend check; the daily budget is the guard's own. */
  aiAlerts: AiAlertThresholds;
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

  const concurrency = poolSize(issues, env, 'WORKER_CONCURRENCY', '5');
  const taskConcurrency = poolSize(issues, env, 'WORKER_TASK_CONCURRENCY', '2');

  // Empty means unset, as `FAKE_MARKETPLACE_URL=` in an env file.
  const rawFakeMarketplaceUrl = env['FAKE_MARKETPLACE_URL'];
  const fakeMarketplaceUrl = rawFakeMarketplaceUrl === '' ? undefined : rawFakeMarketplaceUrl;
  if (fakeMarketplaceUrl !== undefined && !/^https?:\/\/[^\s]+$/.test(fakeMarketplaceUrl)) {
    issues.push('FAKE_MARKETPLACE_URL must be an http:// or https:// URL');
  }

  const rawUserPoolId = env['COGNITO_USER_POOL_ID'];
  const userPoolId = rawUserPoolId === '' ? undefined : rawUserPoolId;
  if (userPoolId !== undefined && !USER_POOL_ID_PATTERN.test(userPoolId)) {
    issues.push('COGNITO_USER_POOL_ID must be a user pool id such as us-east-1_AbC123xyZ');
  }

  const storage = collect(issues, StorageConfigError, () => loadStorageConfig(env));
  const ai = collect(issues, AiConfigError, () => loadAiConfig(env));
  const analysis = collect(issues, AnalysisConfigError, () => loadAnalysisConfig(env));
  const aiAlerts = collect(issues, AiConfigError, () => loadAiAlertConfig(env));
  const ebay = collect(issues, EbayConfigError, () => loadEbayConfig(env));

  if (
    issues.length > 0 ||
    !isLogLevel(logLevel) ||
    storage === undefined ||
    ai === undefined ||
    analysis === undefined ||
    aiAlerts === undefined
  ) {
    throw new ConfigError(issues);
  }
  return {
    databaseUrl,
    logLevel,
    concurrency,
    taskConcurrency,
    fakeMarketplaceUrl,
    ebay,
    storage,
    ai,
    analysis,
    cognitoUserPool:
      userPoolId === undefined ? undefined : { region: userPoolRegion(userPoolId), userPoolId },
    aiAlerts,
  };
}

/** A job pool's size from `key`: an integer from 1 to 100. */
function poolSize(issues: string[], env: NodeJS.ProcessEnv, key: string, fallback: string): number {
  const raw = env[key] ?? fallback;
  const size = Number(raw);
  if (!/^\d+$/.test(raw) || size < 1 || size > 100) {
    issues.push(`${key} must be an integer from 1 to 100`);
  }
  return size;
}

/** A package's own configuration, or undefined with its problems added to `issues`. */
function collect<T>(
  issues: string[],
  type: new (...args: never[]) => Error & { readonly issues: readonly string[] },
  load: () => T,
): T | undefined {
  try {
    return load();
  } catch (error) {
    if (!(error instanceof type)) throw error;
    issues.push(...error.issues);
    return undefined;
  }
}
