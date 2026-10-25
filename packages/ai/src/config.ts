import { fileURLToPath } from 'node:url';

import { AI_PROVIDERS } from '@listora/db';
import { assertNever } from '@listora/shared';

import type { AiAlertThresholds } from './alerts.ts';
import { AnthropicProvider } from './anthropic-provider.ts';
import { directoryFixtures, FakeAiProvider } from './fake-provider.ts';
import { anyKillSwitch, staticKillSwitch, type AiControls, type QuotaPolicy } from './guards.ts';
import { AiClient } from './client.ts';
import { AI_TIERS, createModelRegistry, DEFAULT_MODEL_REGISTRY } from './models.ts';
import { CURRENT_PRICE_TABLE, isPriced, type PriceTable } from './prices.ts';
import type { AiProvider } from './provider.ts';
import type { AiProviderId, AiTier } from './types.ts';
import type { UsageStore } from './usage-store.ts';
import type { Logger } from '@listora/shared';

/** The fixtures that ship with this package. */
export const DEFAULT_FAKE_FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));

export interface AiConfig {
  readonly provider: AiProviderId;
  /** Set only when `provider` is `anthropic`. */
  readonly anthropicApiKey: string | undefined;
  readonly models: Readonly<Record<AiTier, string>>;
  readonly dailyBudgetMicros: number;
  readonly killSwitch: boolean;
  readonly fakeFixturesDir: string;
  readonly requestTimeoutMs: number;
}

export class AiConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid AI configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'AiConfigError';
    this.issues = issues;
  }
}

/**
 * The Anthropic SDK's own default for non-streaming requests. A Premium call (medium effort,
 * up to 16,000 output tokens) can run for minutes, and a timed-out call may still be billed
 * while it is metered at zero, so the default must not cut long calls short.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

const MODEL_KEYS: Readonly<Record<AiTier, string>> = {
  standard: 'AI_MODEL_STANDARD',
  premium: 'AI_MODEL_PREMIUM',
};

/**
 * Reads the AI settings from the environment (see `.env.example`), once at startup. Errors
 * name the bad key but never echo its value.
 */
export function loadAiConfig(
  env: NodeJS.ProcessEnv = process.env,
  prices: PriceTable = CURRENT_PRICE_TABLE,
): AiConfig {
  const issues: string[] = [];

  const provider = env['AI_PROVIDER'] ?? 'fake';
  const knownProvider = AI_PROVIDERS.find((known) => known === provider);
  if (knownProvider === undefined)
    issues.push(`AI_PROVIDER must be one of ${AI_PROVIDERS.join(', ')}`);

  const apiKey = env['ANTHROPIC_API_KEY'] ?? '';
  if (knownProvider === 'anthropic' && apiKey === '') {
    issues.push('ANTHROPIC_API_KEY is required when AI_PROVIDER is anthropic');
  }

  const models = Object.fromEntries(
    AI_TIERS.map((tier) => {
      const key = MODEL_KEYS[tier];
      const model = env[key] ?? DEFAULT_MODEL_REGISTRY[tier].model;
      if (!isPriced(prices, model)) {
        issues.push(`${key} must be a model in price table ${prices.version}`);
      }
      return [tier, model];
    }),
  ) as Record<AiTier, string>;

  const dailyBudgetMicros = parseDailyBudget(env, issues);

  const killSwitch = env['AI_KILL_SWITCH'] ?? 'off';
  if (killSwitch !== 'on' && killSwitch !== 'off') issues.push('AI_KILL_SWITCH must be on or off');

  const timeout = env['AI_REQUEST_TIMEOUT_MS'] ?? String(DEFAULT_REQUEST_TIMEOUT_MS);
  const requestTimeoutMs = Number(timeout);
  if (!/^\d+$/.test(timeout) || requestTimeoutMs < 1_000 || requestTimeoutMs > 600_000) {
    issues.push('AI_REQUEST_TIMEOUT_MS must be an integer from 1000 to 600000');
  }

  const fakeFixturesDir = env['AI_FAKE_FIXTURES_DIR'] ?? DEFAULT_FAKE_FIXTURES_DIR;
  if (fakeFixturesDir === '') issues.push('AI_FAKE_FIXTURES_DIR must not be empty');

  if (issues.length > 0 || knownProvider === undefined || dailyBudgetMicros === undefined) {
    throw new AiConfigError(issues);
  }
  return {
    provider: knownProvider,
    anthropicApiKey: knownProvider === 'anthropic' ? apiKey : undefined,
    models,
    dailyBudgetMicros,
    killSwitch: killSwitch === 'on',
    fakeFixturesDir,
    requestTimeoutMs,
  };
}

/** Default for `AI_GLOBAL_DAILY_ALERT_USD`: AI spend by every account together per UTC day. */
export const DEFAULT_GLOBAL_DAILY_ALERT_USD = '25.00';
/** Default for `AI_ALERT_WARN_PERCENT`. */
export const DEFAULT_ALERT_WARN_PERCENT = 80;

/**
 * Reads the AI spend check's thresholds from the environment (see `.env.example`). The daily
 * budget is the same `AI_DAILY_BUDGET_USD` the guard enforces.
 */
export function loadAiAlertConfig(env: NodeJS.ProcessEnv = process.env): AiAlertThresholds {
  const issues: string[] = [];
  const dailyBudgetMicros = parseDailyBudget(env, issues);

  const globalDailyAlertMicros = parseDollarsToMicros(
    env['AI_GLOBAL_DAILY_ALERT_USD'] ?? DEFAULT_GLOBAL_DAILY_ALERT_USD,
  );
  if (globalDailyAlertMicros === undefined || globalDailyAlertMicros === 0) {
    issues.push('AI_GLOBAL_DAILY_ALERT_USD must be a dollar amount above zero such as 25.00');
  }

  const warn = env['AI_ALERT_WARN_PERCENT'] ?? String(DEFAULT_ALERT_WARN_PERCENT);
  const warnPercent = Number(warn);
  if (!/^\d{1,3}$/.test(warn) || warnPercent < 1 || warnPercent > 100) {
    issues.push('AI_ALERT_WARN_PERCENT must be an integer from 1 to 100');
  }

  if (
    issues.length > 0 ||
    dailyBudgetMicros === undefined ||
    globalDailyAlertMicros === undefined
  ) {
    throw new AiConfigError(issues);
  }
  return { dailyBudgetMicros, globalDailyAlertMicros, warnPercent };
}

function parseDailyBudget(env: NodeJS.ProcessEnv, issues: string[]): number | undefined {
  const micros = parseDollarsToMicros(env['AI_DAILY_BUDGET_USD'] ?? '1.00');
  if (micros === undefined) {
    issues.push('AI_DAILY_BUDGET_USD must be a dollar amount such as 1.00 (up to 6 decimals)');
  }
  return micros;
}

/** "1", "1.5", or "0.000001" dollars as integer micro-dollars, without floating point. */
export function parseDollarsToMicros(value: string): number | undefined {
  const match = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(value);
  if (match === null) return undefined;
  const [, whole = '0', fraction = ''] = match;
  return Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'));
}

export function createAiProvider(config: AiConfig): AiProvider {
  switch (config.provider) {
    case 'fake':
      return new FakeAiProvider({ fixtures: directoryFixtures(config.fakeFixturesDir) });
    case 'anthropic':
      if (config.anthropicApiKey === undefined) {
        throw new AiConfigError(['ANTHROPIC_API_KEY is required when AI_PROVIDER is anthropic']);
      }
      return new AnthropicProvider({
        apiKey: config.anthropicApiKey,
        timeoutMs: config.requestTimeoutMs,
      });
    default:
      return assertNever(config.provider);
  }
}

/**
 * The client a process uses, wired from its configuration. With `controls` (the operator's
 * kill switch and account blocks), a call is refused when either `AI_KILL_SWITCH` or the
 * operator's kill switch is on.
 */
export function createAiClient(
  config: AiConfig,
  dependencies: {
    readonly usageStore: UsageStore;
    readonly controls?: AiControls;
    readonly quota?: QuotaPolicy;
    readonly logger?: Logger;
    readonly provider?: AiProvider;
  },
): AiClient {
  return new AiClient({
    provider: dependencies.provider ?? createAiProvider(config),
    registry: createModelRegistry(config.models, CURRENT_PRICE_TABLE),
    usageStore: dependencies.usageStore,
    killSwitch:
      dependencies.controls === undefined
        ? staticKillSwitch(config.killSwitch)
        : anyKillSwitch(staticKillSwitch(config.killSwitch), dependencies.controls),
    ...(dependencies.controls === undefined ? {} : { accountBlocks: dependencies.controls }),
    dailyBudgetMicros: config.dailyBudgetMicros,
    prices: CURRENT_PRICE_TABLE,
    ...(dependencies.quota === undefined ? {} : { quota: dependencies.quota }),
    ...(dependencies.logger === undefined ? {} : { logger: dependencies.logger }),
  });
}
