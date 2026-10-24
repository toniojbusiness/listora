import { fileURLToPath } from 'node:url';

import { AI_PROVIDERS } from '@listora/db';
import { assertNever } from '@listora/shared';

import { AnthropicProvider } from './anthropic-provider.ts';
import { directoryFixtures, FakeAiProvider } from './fake-provider.ts';
import { staticKillSwitch, type QuotaPolicy } from './guards.ts';
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

  const dailyBudgetMicros = parseDollarsToMicros(env['AI_DAILY_BUDGET_USD'] ?? '1.00');
  if (dailyBudgetMicros === undefined) {
    issues.push('AI_DAILY_BUDGET_USD must be a dollar amount such as 1.00 (up to 6 decimals)');
  }

  const killSwitch = env['AI_KILL_SWITCH'] ?? 'off';
  if (killSwitch !== 'on' && killSwitch !== 'off') issues.push('AI_KILL_SWITCH must be on or off');

  const timeout = env['AI_REQUEST_TIMEOUT_MS'] ?? '60000';
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

/** The client a process uses, wired from its configuration. */
export function createAiClient(
  config: AiConfig,
  dependencies: {
    readonly usageStore: UsageStore;
    readonly quota?: QuotaPolicy;
    readonly logger?: Logger;
    readonly provider?: AiProvider;
  },
): AiClient {
  return new AiClient({
    provider: dependencies.provider ?? createAiProvider(config),
    registry: createModelRegistry(config.models, CURRENT_PRICE_TABLE),
    usageStore: dependencies.usageStore,
    killSwitch: staticKillSwitch(config.killSwitch),
    dailyBudgetMicros: config.dailyBudgetMicros,
    prices: CURRENT_PRICE_TABLE,
    ...(dependencies.quota === undefined ? {} : { quota: dependencies.quota }),
    ...(dependencies.logger === undefined ? {} : { logger: dependencies.logger }),
  });
}
