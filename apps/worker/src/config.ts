import { USER_POOL_ID_PATTERN, userPoolRegion } from '@listora/accounts';
import {
  AiConfigError,
  loadAiAlertConfig,
  loadAiConfig,
  type AiAlertThresholds,
  type AiConfig,
} from '@listora/ai';
import { AnalysisConfigError, loadAnalysisConfig, type AnalysisConfig } from '@listora/analysis';
import {
  AutomationConfigError,
  loadAutomationSettings,
  loadRunnerLaunchConfig,
  RunnerLaunchConfigError,
  type AutomationSettings,
  type RunnerLaunchConfig,
} from '@listora/automation';
import {
  loadMarketplaceConfig,
  MarketplaceConfigError,
  type MarketplaceConfig,
} from '@listora/connections';
import {
  EmailIngestConfigError,
  loadEmailIngestConfig,
  type EmailIngestConfig,
} from '@listora/email-sales';
import { loadPushConfig, PushConfigError, type PushConfig } from '@listora/push';
import { isLogLevel, type LogLevel } from '@listora/shared';
import { loadStorageConfig, StorageConfigError, type StorageConfig } from '@listora/storage';

export interface WorkerConfig {
  databaseUrl: string;
  logLevel: LogLevel;
  /** Marketplace operation steps run at the same time. */
  concurrency: number;
  /** Photo processing and item analysis jobs run at the same time, in their own pool. */
  taskConcurrency: number;
  /**
   * OPERATION_RETRY_DELAY_SCALE: the operation engine's retry and confirmation delays,
   * multiplied by this (1 in production; local stacks and tests shorten them).
   */
  operationRetryDelayScale: number;
  /**
   * FAKE_MARKETPLACE_URL, EBAY_*, and TOKEN_* keys, read by @listora/connections: the adapters,
   * the marketplaces whose connections the worker refreshes and checks, and the token vault.
   */
  marketplaces: MarketplaceConfig;
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
  /** PUSH_DRIVER, read by @listora/push: how sale and delist alerts reach the seller's phone. */
  push: PushConfig;
  /**
   * AUTOMATION_*, SALE_CHECK_*, FAKE_AUTOMATION_SITE_URL, FAKE_POSHMARK_URL: which marketplaces
   * are automated, and where.
   */
  automation: AutomationSettings;
  /** BROWSER_RUNNER_*: how the worker starts the browser runner when automated work waits. */
  runnerLaunch: RunnerLaunchConfig;
  /** EMAIL_*, read by @listora/email-sales: where forwarded sale emails are read from. */
  emailIngest: EmailIngestConfig;
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
  const rawScale = env['OPERATION_RETRY_DELAY_SCALE'] ?? '';
  const operationRetryDelayScale = rawScale === '' ? 1 : Number(rawScale);
  if (!(operationRetryDelayScale >= 0.001 && operationRetryDelayScale <= 1)) {
    issues.push('OPERATION_RETRY_DELAY_SCALE must be a number from 0.001 to 1');
  }

  // Empty means unset, as `FAKE_MARKETPLACE_URL=` in an env file.
  const marketplaces = collect(issues, MarketplaceConfigError, () => loadMarketplaceConfig(env));

  const rawUserPoolId = env['COGNITO_USER_POOL_ID'];
  const userPoolId = rawUserPoolId === '' ? undefined : rawUserPoolId;
  if (userPoolId !== undefined && !USER_POOL_ID_PATTERN.test(userPoolId)) {
    issues.push('COGNITO_USER_POOL_ID must be a user pool id such as us-east-1_AbC123xyZ');
  }

  const storage = collect(issues, StorageConfigError, () => loadStorageConfig(env));
  const ai = collect(issues, AiConfigError, () => loadAiConfig(env));
  const analysis = collect(issues, AnalysisConfigError, () => loadAnalysisConfig(env));
  const aiAlerts = collect(issues, AiConfigError, () => loadAiAlertConfig(env));
  const push = collect(issues, PushConfigError, () => loadPushConfig(env));
  const automation = collect(issues, AutomationConfigError, () => loadAutomationSettings(env));
  const runnerLaunch = collect(issues, RunnerLaunchConfigError, () => loadRunnerLaunchConfig(env));
  const emailIngest = collect(issues, EmailIngestConfigError, () => loadEmailIngestConfig(env));

  if (
    issues.length > 0 ||
    !isLogLevel(logLevel) ||
    storage === undefined ||
    ai === undefined ||
    analysis === undefined ||
    aiAlerts === undefined ||
    push === undefined ||
    marketplaces === undefined ||
    automation === undefined ||
    runnerLaunch === undefined ||
    emailIngest === undefined
  ) {
    throw new ConfigError(issues);
  }
  return {
    databaseUrl,
    logLevel,
    concurrency,
    taskConcurrency,
    operationRetryDelayScale,
    marketplaces,
    storage,
    ai,
    analysis,
    cognitoUserPool:
      userPoolId === undefined ? undefined : { region: userPoolRegion(userPoolId), userPoolId },
    aiAlerts,
    push,
    automation,
    runnerLaunch,
    emailIngest,
  };
}

/** A job pool's size from `key`: an integer from 1 to 100. */
export function poolSize(
  issues: string[],
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: string,
): number {
  const raw = env[key] ?? fallback;
  const size = Number(raw);
  if (!/^\d+$/.test(raw) || size < 1 || size > 100) {
    issues.push(`${key} must be an integer from 1 to 100`);
  }
  return size;
}

/** A package's own configuration, or undefined with its problems added to `issues`. */
export function collect<T>(
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
