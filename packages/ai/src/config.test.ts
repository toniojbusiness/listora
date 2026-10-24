import { describe, expect, it } from 'vitest';

import { AnthropicProvider } from './anthropic-provider.ts';
import {
  AiConfigError,
  createAiClient,
  createAiProvider,
  DEFAULT_FAKE_FIXTURES_DIR,
  loadAiAlertConfig,
  loadAiConfig,
  parseDollarsToMicros,
} from './config.ts';
import { FakeAiProvider } from './fake-provider.ts';
import { staticKillSwitch } from './guards.ts';
import { COLOR_OUTPUT } from './test-support.ts';
import { InMemoryUsageStore } from './usage-store.ts';

function issuesOf(env: NodeJS.ProcessEnv): readonly string[] {
  try {
    loadAiConfig(env);
  } catch (error) {
    if (error instanceof AiConfigError) return error.issues;
    throw error;
  }
  throw new Error('expected an AiConfigError');
}

describe('loadAiConfig', () => {
  it('defaults to the fake provider, Haiku/Sonnet tiers, and a $1 daily budget', () => {
    expect(loadAiConfig({})).toEqual({
      provider: 'fake',
      anthropicApiKey: undefined,
      models: { standard: 'claude-haiku-5-5', premium: 'claude-sonnet-5-5' },
      dailyBudgetMicros: 1_000_000,
      killSwitch: false,
      fakeFixturesDir: DEFAULT_FAKE_FIXTURES_DIR,
      requestTimeoutMs: 600_000,
    });
  });

  it('switches a tier to another priced model by configuration alone', () => {
    const config = loadAiConfig({
      AI_MODEL_PREMIUM: 'claude-opus-5-5',
      AI_MODEL_STANDARD: 'claude-sonnet-5-5',
    });
    expect(config.models).toEqual({ standard: 'claude-sonnet-5-5', premium: 'claude-opus-5-5' });
  });

  it('reads the Anthropic settings, the budget, and the kill switch', () => {
    const config = loadAiConfig({
      AI_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-test-not-a-real-key',
      AI_DAILY_BUDGET_USD: '2.5',
      AI_KILL_SWITCH: 'on',
      AI_REQUEST_TIMEOUT_MS: '30000',
    });
    expect(config).toMatchObject({
      provider: 'anthropic',
      anthropicApiKey: 'sk-test-not-a-real-key',
      dailyBudgetMicros: 2_500_000,
      killSwitch: true,
      requestTimeoutMs: 30_000,
    });
  });

  it('requires an API key for the Anthropic provider and never echoes values', () => {
    expect(issuesOf({ AI_PROVIDER: 'anthropic' })).toEqual([
      'ANTHROPIC_API_KEY is required when AI_PROVIDER is anthropic',
    ]);
    const issues = issuesOf({
      AI_PROVIDER: 'secret-provider',
      AI_MODEL_STANDARD: 'secret-model',
      AI_DAILY_BUDGET_USD: 'secret-budget',
      AI_KILL_SWITCH: 'secret-switch',
      AI_REQUEST_TIMEOUT_MS: 'secret-timeout',
    });
    expect(issues).toHaveLength(5);
    expect(issues.join('\n')).not.toContain('secret');
  });

  it('rejects unpriced models, so every call can be metered', () => {
    expect(issuesOf({ AI_MODEL_STANDARD: 'claude-haiku-4-5' })).toEqual([
      'AI_MODEL_STANDARD must be a model in price table 2026-10-24',
    ]);
  });

  it('does not keep an API key that the selected provider does not use', () => {
    expect(loadAiConfig({ ANTHROPIC_API_KEY: 'sk-test' }).anthropicApiKey).toBeUndefined();
  });
});

describe('parseDollarsToMicros', () => {
  it.each([
    ['1', 1_000_000],
    ['1.00', 1_000_000],
    ['0.5', 500_000],
    ['0', 0],
    ['0.000001', 1],
    ['25.123456', 25_123_456],
  ])('parses %s', (input, micros) => {
    expect(parseDollarsToMicros(input)).toBe(micros);
  });

  it.each(['', '-1', '1.', '.5', '1.1234567', '1e3', ' 1', 'abc', '1,00'])(
    'rejects %j',
    (input) => {
      expect(parseDollarsToMicros(input)).toBeUndefined();
    },
  );
});

describe('loadAiAlertConfig', () => {
  function alertIssuesOf(env: NodeJS.ProcessEnv): readonly string[] {
    try {
      loadAiAlertConfig(env);
    } catch (error) {
      if (error instanceof AiConfigError) return error.issues;
      throw error;
    }
    throw new Error('expected an AiConfigError');
  }

  it('defaults to the $1 daily budget, a $25 global threshold, and warnings from 80%', () => {
    expect(loadAiAlertConfig({})).toEqual({
      dailyBudgetMicros: 1_000_000,
      globalDailyAlertMicros: 25_000_000,
      warnPercent: 80,
    });
  });

  it('reads the thresholds from the environment', () => {
    expect(
      loadAiAlertConfig({
        AI_DAILY_BUDGET_USD: '0.50',
        AI_GLOBAL_DAILY_ALERT_USD: '120',
        AI_ALERT_WARN_PERCENT: '100',
      }),
    ).toEqual({
      dailyBudgetMicros: 500_000,
      globalDailyAlertMicros: 120_000_000,
      warnPercent: 100,
    });
  });

  it('rejects bad values, naming every bad key but not its value', () => {
    const issues = alertIssuesOf({
      AI_DAILY_BUDGET_USD: 'lots',
      AI_GLOBAL_DAILY_ALERT_USD: '0',
      AI_ALERT_WARN_PERCENT: '0',
    });
    expect(issues).toEqual([
      'AI_DAILY_BUDGET_USD must be a dollar amount such as 1.00 (up to 6 decimals)',
      'AI_GLOBAL_DAILY_ALERT_USD must be a dollar amount above zero such as 25.00',
      'AI_ALERT_WARN_PERCENT must be an integer from 1 to 100',
    ]);
    expect(issues.join(' ')).not.toContain('lots');
  });

  it.each(['101', '-5', '80.5', '', 'eighty'])('rejects AI_ALERT_WARN_PERCENT=%j', (value) => {
    expect(alertIssuesOf({ AI_ALERT_WARN_PERCENT: value })).toEqual([
      'AI_ALERT_WARN_PERCENT must be an integer from 1 to 100',
    ]);
  });
});

describe('createAiProvider', () => {
  it('builds the provider the configuration selects', () => {
    expect(createAiProvider(loadAiConfig({}))).toBeInstanceOf(FakeAiProvider);
    expect(
      createAiProvider(loadAiConfig({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-test' })),
    ).toBeInstanceOf(AnthropicProvider);
  });

  it('wires a client whose kill switch follows the configuration', async () => {
    const client = createAiClient(loadAiConfig({ AI_KILL_SWITCH: 'on' }), {
      usageStore: new InMemoryUsageStore(),
    });
    await expect(
      client.generate({
        context: { accountId: 'account', purpose: 'test' },
        tier: 'standard',
        system: 's',
        prompt: 'p',
        images: [],
        output: COLOR_OUTPUT,
      }),
    ).rejects.toMatchObject({ name: 'AiGuardError', reason: { kind: 'kill_switch' } });
  });

  it('wires the operator controls: their kill switch and account blocks refuse calls too', async () => {
    let engaged = false;
    let blocked = false;
    const client = createAiClient(loadAiConfig({}), {
      usageStore: new InMemoryUsageStore(),
      controls: {
        isEngaged: () => Promise.resolve(engaged),
        isBlocked: () => Promise.resolve(blocked),
      },
    });
    const call = () =>
      client.generate({
        context: { accountId: 'account', purpose: 'test' },
        tier: 'standard',
        system: 's',
        prompt: 'p',
        images: [],
        output: COLOR_OUTPUT,
      });
    blocked = true;
    await expect(call()).rejects.toMatchObject({ reason: { kind: 'account_blocked' } });
    engaged = true;
    await expect(call()).rejects.toMatchObject({ reason: { kind: 'kill_switch' } });
  });

  it('keeps AI_KILL_SWITCH=on in force when the operator switch is off', async () => {
    const client = createAiClient(loadAiConfig({ AI_KILL_SWITCH: 'on' }), {
      usageStore: new InMemoryUsageStore(),
      controls: { ...staticKillSwitch(false), isBlocked: () => Promise.resolve(false) },
    });
    await expect(
      client.generate({
        context: { accountId: 'account', purpose: 'test' },
        tier: 'standard',
        system: 's',
        prompt: 'p',
        images: [],
        output: COLOR_OUTPUT,
      }),
    ).rejects.toMatchObject({ reason: { kind: 'kill_switch' } });
  });
});
