import {
  AutomationConfigError,
  loadAutomationSettings,
  loadRunnerLaunchConfig,
  RunnerLaunchConfigError,
  type AutomationSettings,
  type RunnerLaunchConfig,
} from '@listora/automation';
import {
  loadTokenVaultConfig,
  TokenVaultConfigError,
  type TokenVaultConfig,
} from '@listora/connections';
import { isLogLevel, type LogLevel } from '@listora/shared';
import { loadStorageConfig, StorageConfigError, type StorageConfig } from '@listora/storage';

import { collect } from '../config.ts';

export interface RunnerConfig {
  databaseUrl: string;
  logLevel: LogLevel;
  /** The worker's FAKE_MARKETPLACE_URL, so both build the same adapters. */
  fakeMarketplaceUrl: string | undefined;
  /**
   * TOKEN_KMS_KEY_ID or TOKEN_ENCRYPTION_KEY (required): the token vault's key, which the
   * sessions in the session vault are sealed with.
   */
  tokenVault: TokenVaultConfig;
  /** STORAGE_* keys: where the redacted screenshots of failed runs go (private keys). */
  storage: StorageConfig;
  automation: AutomationSettings;
  /**
   * How long the runner stays up with nothing to do before it exits
   * (`RUNNER_IDLE_EXIT_SECONDS`, default 120; 0 keeps it running).
   */
  idleExitMs: number;
  /** BROWSER_RUNNER_LAUNCH: with `ecs`, the runner scales its own service to zero as it exits. */
  launch: RunnerLaunchConfig;
}

export class RunnerConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid browser runner configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'RunnerConfigError';
    this.issues = issues;
  }
}

/**
 * Reads the browser runner's settings from the environment (see `.env.example`). Error
 * messages name the offending key but never echo its value.
 */
export function loadRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const issues: string[] = [];
  const databaseUrl = env['DATABASE_URL'] ?? '';
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    issues.push('DATABASE_URL is required and must be a postgres:// URL');
  }
  const logLevel = env['LOG_LEVEL'] ?? 'info';
  if (!isLogLevel(logLevel)) {
    issues.push('LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent');
  }
  const rawFakeMarketplaceUrl = env['FAKE_MARKETPLACE_URL'];
  const fakeMarketplaceUrl = rawFakeMarketplaceUrl === '' ? undefined : rawFakeMarketplaceUrl;
  if (fakeMarketplaceUrl !== undefined && !/^https?:\/\/[^\s]+$/.test(fakeMarketplaceUrl)) {
    issues.push('FAKE_MARKETPLACE_URL must be an http:// or https:// URL');
  }
  const rawIdle = env['RUNNER_IDLE_EXIT_SECONDS'] ?? '120';
  const idleSeconds = Number(rawIdle);
  if (!/^\d+$/.test(rawIdle) || idleSeconds > 3_600) {
    issues.push('RUNNER_IDLE_EXIT_SECONDS must be an integer from 0 to 3600');
  }

  const issuesBeforeVault = issues.length;
  const tokenVault = collect(issues, TokenVaultConfigError, () => loadTokenVaultConfig(env));
  if (tokenVault === undefined && issues.length === issuesBeforeVault) {
    issues.push('set TOKEN_KMS_KEY_ID or TOKEN_ENCRYPTION_KEY: the runner opens sealed sessions');
  }
  const storage = collect(issues, StorageConfigError, () => loadStorageConfig(env));
  const automation = collect(issues, AutomationConfigError, () => loadAutomationSettings(env));
  const launch = collect(issues, RunnerLaunchConfigError, () => loadRunnerLaunchConfig(env));

  if (
    issues.length > 0 ||
    !isLogLevel(logLevel) ||
    tokenVault === undefined ||
    storage === undefined ||
    automation === undefined ||
    launch === undefined
  ) {
    throw new RunnerConfigError(issues);
  }
  return {
    databaseUrl,
    logLevel,
    fakeMarketplaceUrl,
    tokenVault,
    storage,
    automation,
    idleExitMs: idleSeconds * 1000,
    launch,
  };
}
