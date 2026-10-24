import { describe, expect, it, vi } from 'vitest';

import { AiClient, type AiCall } from './client.ts';
import { AiCallError, AiGuardError, AiProviderError } from './errors.ts';
import { FakeAiProvider, inMemoryFixtures, type FakeFixture } from './fake-provider.ts';
import { staticKillSwitch, type KillSwitch, type QuotaPolicy } from './guards.ts';
import { createModelRegistry } from './models.ts';
import { photoSetHashOfImages } from './photo-set-hash.ts';
import { costMicros, CURRENT_PRICE_TABLE } from './prices.ts';
import type { AiProvider } from './provider.ts';
import { COLOR_OUTPUT, image } from './test-support.ts';
import { InMemoryUsageStore } from './usage-store.ts';

const ACCOUNT = '00000000-0000-7000-8000-000000000001';
const OTHER_ACCOUNT = '00000000-0000-7000-8000-000000000002';
const PHOTOS = [image('front'), image('tag', 784, 784)];
const HASH = photoSetHashOfImages(PHOTOS);
const ANSWER = { color: 'navy', confidence: 0.9 };
/** Fixed usage so costs are easy to read: Haiku 1,430 micros, Sonnet 28,600 micros. */
const USAGE = { inputTokens: 6_800, outputTokens: 1_500 };

const NOW = new Date('2026-10-24T15:30:00Z');

function call(overrides: Partial<AiCall<typeof ANSWER>> = {}): AiCall<typeof ANSWER> {
  return {
    context: { accountId: ACCOUNT, userId: null, itemId: null, purpose: 'item_analysis' },
    tier: 'standard',
    system: 'Name the dominant color.',
    prompt: 'Answer in JSON.',
    photoSetHash: HASH,
    images: PHOTOS,
    output: COLOR_OUTPUT,
    ...overrides,
  };
}

interface Setup {
  fixture?: FakeFixture;
  provider?: AiProvider;
  killSwitch?: KillSwitch;
  dailyBudgetMicros?: number;
  quota?: QuotaPolicy;
}

function setup(options: Setup = {}) {
  const store = new InMemoryUsageStore({ now: () => NOW });
  const fake = new FakeAiProvider({
    fixtures: inMemoryFixtures({
      [HASH]: options.fixture ?? { outputs: { dominant_color: ANSWER }, usage: USAGE },
    }),
  });
  const provider = options.provider ?? fake;
  const generate = vi.spyOn(provider, 'generate');
  const client = new AiClient({
    provider,
    registry: createModelRegistry({}, CURRENT_PRICE_TABLE),
    usageStore: store,
    killSwitch: options.killSwitch ?? staticKillSwitch(false),
    dailyBudgetMicros: options.dailyBudgetMicros ?? 1_000_000,
    now: () => NOW,
    ...(options.quota === undefined ? {} : { quota: options.quota }),
  });
  return { client, store, generate };
}

async function rejection<T extends Error>(
  work: Promise<unknown>,
  type: new (...args: never[]) => T,
): Promise<T> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(type);
  return error as T;
}

describe('AiClient metering', () => {
  it('records one usage event per successful call, priced from the current price table', async () => {
    const { client, store } = setup();
    const result = await client.generate(
      call({
        context: { accountId: ACCOUNT, userId: 'user', itemId: 'item', purpose: 'item_analysis' },
      }),
    );

    expect(result).toMatchObject({
      output: ANSWER,
      provider: 'fake',
      tier: 'standard',
      model: 'claude-haiku-5-5',
      costMicros: 1_430,
      priceTableVersion: CURRENT_PRICE_TABLE.version,
    });
    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({
      id: result.usageEventId,
      accountId: ACCOUNT,
      userId: 'user',
      itemId: 'item',
      purpose: 'item_analysis',
      tier: 'standard',
      provider: 'fake',
      model: 'claude-haiku-5-5',
      usage: {
        inputTokens: 6_800,
        outputTokens: 1_500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        webSearches: 0,
      },
      images: 2,
      batch: false,
      costMicros: 1_430,
      outcome: 'succeeded',
      errorCode: null,
    });
    expect(store.events[0]?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('sends each tier to its configured model and effort', async () => {
    const { client, store, generate } = setup();
    const result = await client.generate(call({ tier: 'premium' }));
    expect(result.model).toBe('claude-sonnet-5-5');
    expect(result.costMicros).toBe(28_600);
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-5-5', effort: 'medium', photoSetHash: HASH }),
    );
    expect(store.events[0]).toMatchObject({ tier: 'premium', model: 'claude-sonnet-5-5' });
  });

  it('records a failed call with its real usage and cost, then throws AiCallError', async () => {
    const { client, store } = setup({
      fixture: {
        error: { code: 'truncated' },
        usage: { inputTokens: 6_800, outputTokens: 8_000 },
      },
    });
    const error = await rejection(client.generate(call()), AiCallError);

    const cost = costMicros(CURRENT_PRICE_TABLE, 'claude-haiku-5-5', {
      inputTokens: 6_800,
      outputTokens: 8_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearches: 0,
    });
    expect(cost).toBe(4_680);
    expect(error).toMatchObject({
      code: 'truncated',
      retryable: false,
      costMicros: cost,
      tier: 'standard',
    });
    expect(store.events).toEqual([
      expect.objectContaining({
        id: error.usageEventId,
        outcome: 'failed',
        errorCode: 'truncated',
        costMicros: cost,
        usage: expect.objectContaining({ outputTokens: 8_000 }) as unknown,
      }),
    ]);
  });

  it('meters an unexpected provider exception as a failed call', async () => {
    const broken: AiProvider = {
      id: 'fake',
      generate: () => Promise.reject(new Error('socket hang up')),
    };
    const { client, store } = setup({ provider: broken });
    const error = await rejection(client.generate(call()), AiCallError);
    expect(error.code).toBe('unknown');
    expect(store.events).toEqual([
      expect.objectContaining({ outcome: 'failed', errorCode: 'unknown', costMicros: 0 }),
    ]);
  });

  it('propagates a metering failure instead of returning unmetered output', async () => {
    const { client, store } = setup();
    vi.spyOn(store, 'record').mockRejectedValue(new Error('database is down'));
    await expect(client.generate(call())).rejects.toThrow('database is down');
  });

  it('rejects a purpose that the usage table would refuse, before calling the provider', async () => {
    const { client, store, generate } = setup();
    await expect(
      client.generate(call({ context: { accountId: ACCOUNT, purpose: 'Item Analysis' } })),
    ).rejects.toThrow(TypeError);
    await expect(client.generate(call({ photoSetHash: 'not a hash' }))).rejects.toThrow(TypeError);
    expect(generate).not.toHaveBeenCalled();
    expect(store.events).toEqual([]);
  });
});

describe('AiClient budget guards', () => {
  it('trips the daily dollar circuit breaker exactly at the cap and records nothing', async () => {
    // Three Haiku calls cost 4,290 micros; a cap of 4,290 allows exactly three.
    const { client, store, generate } = setup({ dailyBudgetMicros: 4_290 });
    for (let i = 0; i < 3; i += 1) await client.generate(call());
    expect(await store.spentTodayMicros(ACCOUNT)).toBe(4_290);

    const error = await rejection(client.generate(call()), AiGuardError);
    expect(error.reason).toEqual({
      kind: 'daily_budget',
      spentMicros: 4_290,
      limitMicros: 4_290,
      resetsAt: new Date('2026-10-25T00:00:00Z'),
    });
    expect(error.message).toContain('$0.004290 of $0.004290');
    expect(generate).toHaveBeenCalledTimes(3);
    expect(store.events).toHaveLength(3);
  });

  it('allows a call while spend is below the cap, even if that call ends above it', async () => {
    const { client, store } = setup({ dailyBudgetMicros: 1_431 });
    await client.generate(call());
    await client.generate(call());
    expect(await store.spentTodayMicros(ACCOUNT)).toBe(2_860);
    await expect(client.generate(call())).rejects.toBeInstanceOf(AiGuardError);
  });

  it('counts failed calls toward the budget', async () => {
    const { client } = setup({
      dailyBudgetMicros: 1_000,
      fixture: { error: { code: 'invalid_output' }, usage: USAGE },
    });
    await expect(client.generate(call())).rejects.toBeInstanceOf(AiCallError);
    await expect(client.generate(call())).rejects.toMatchObject({
      reason: { kind: 'daily_budget' },
    });
  });

  it('keeps budgets per account and per UTC day', async () => {
    let now = NOW;
    const store = new InMemoryUsageStore({ now: () => now });
    const client = new AiClient({
      provider: new FakeAiProvider({
        fixtures: inMemoryFixtures({
          [HASH]: { outputs: { dominant_color: ANSWER }, usage: USAGE },
        }),
      }),
      registry: createModelRegistry({}, CURRENT_PRICE_TABLE),
      usageStore: store,
      killSwitch: staticKillSwitch(false),
      dailyBudgetMicros: 1_430,
      now: () => now,
    });
    await client.generate(call());
    await expect(client.generate(call())).rejects.toBeInstanceOf(AiGuardError);
    // Another account is unaffected.
    await client.generate(
      call({ context: { accountId: OTHER_ACCOUNT, purpose: 'item_analysis' } }),
    );
    // The next UTC day starts fresh.
    now = new Date('2026-10-25T00:00:00Z');
    await client.generate(call());
  });

  it('a zero budget refuses every call', async () => {
    const { client, generate } = setup({ dailyBudgetMicros: 0 });
    await expect(client.generate(call())).rejects.toMatchObject({
      reason: { kind: 'daily_budget' },
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it('the global kill switch refuses every call before anything is sent or recorded', async () => {
    let engaged = false;
    const { client, store, generate } = setup({
      killSwitch: { isEngaged: () => Promise.resolve(engaged) },
    });
    await client.generate(call());
    engaged = true;
    const error = await rejection(client.generate(call()), AiGuardError);
    expect(error.reason).toEqual({ kind: 'kill_switch' });
    expect(error.message).toBe('AI is turned off for every account (global kill switch)');
    await expect(
      client.generate(call({ context: { accountId: OTHER_ACCOUNT, purpose: 'item_analysis' } })),
    ).rejects.toBeInstanceOf(AiGuardError);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(store.events).toHaveLength(1);
    // Turning it off again takes effect on the next call.
    engaged = false;
    await client.generate(call());
  });

  it('asks the plan quota hook before the call and consumes units only on success', async () => {
    let used = 0;
    const limit = 2;
    const quota: QuotaPolicy = {
      check: ({ charge }) =>
        Promise.resolve(
          used + charge.units <= limit ? { allowed: true } : { allowed: false, used, limit },
        ),
      consume: ({ charge }) => {
        used += charge.units;
        return Promise.resolve();
      },
    };
    const check = vi.spyOn(quota, 'check');
    const { client, store, generate } = setup({ quota });
    const charge = { metric: 'ai_items', units: 1 } as const;

    await client.generate(call({ quota: charge }));
    await client.generate(call({ quota: charge }));
    expect(used).toBe(2);
    expect(check).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      tier: 'standard',
      purpose: 'item_analysis',
      charge,
    });

    const error = await rejection(client.generate(call({ quota: charge })), AiGuardError);
    expect(error.reason).toEqual({ kind: 'quota', metric: 'ai_items', used: 2, limit: 2 });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(store.events).toHaveLength(2);
    // Calls that use no plan unit are not limited by it.
    await client.generate(call());
  });

  it('does not consume a quota unit when the call fails', async () => {
    const consume = vi.fn(() => Promise.resolve());
    const { client } = setup({
      quota: { check: () => Promise.resolve({ allowed: true }), consume },
      fixture: { error: { code: 'refusal' } },
    });
    await expect(
      client.generate(
        call({ tier: 'premium', quota: { metric: 'premium_identifications', units: 1 } }),
      ),
    ).rejects.toBeInstanceOf(AiCallError);
    expect(consume).not.toHaveBeenCalled();
  });

  it('rejects a quota charge that is not a positive whole number of units', async () => {
    const { client, generate } = setup();
    await expect(
      client.generate(call({ quota: { metric: 'ai_items', units: 0 } })),
    ).rejects.toThrow(RangeError);
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('AiClient.checkGuards', () => {
  it('refuses up front for the reason a call would be refused, without sending or recording', async () => {
    const { client, store, generate } = setup({ dailyBudgetMicros: 1_430 });
    await client.checkGuards({ accountId: ACCOUNT, tier: 'standard', purpose: 'item_analysis' });
    await client.generate(call());
    const error = await rejection(
      client.checkGuards({ accountId: ACCOUNT, tier: 'standard', purpose: 'item_analysis' }),
      AiGuardError,
    );
    expect(error.reason).toMatchObject({ kind: 'daily_budget', spentMicros: 1_430 });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(store.events).toHaveLength(1);
  });

  it('checks the kill switch and the quota the call would use, consuming nothing', async () => {
    const consume = vi.fn(() => Promise.resolve());
    const quota: QuotaPolicy = {
      check: () => Promise.resolve({ allowed: false, used: 15, limit: 15 }),
      consume,
    };
    const request = {
      accountId: ACCOUNT,
      tier: 'premium',
      purpose: 'item_analysis',
      quota: { metric: 'premium_identifications', units: 1 },
    } as const;
    const quotaError = await rejection(setup({ quota }).client.checkGuards(request), AiGuardError);
    expect(quotaError.reason).toEqual({
      kind: 'quota',
      metric: 'premium_identifications',
      used: 15,
      limit: 15,
    });
    expect(consume).not.toHaveBeenCalled();
    const killed = setup({ quota, killSwitch: staticKillSwitch(true) });
    const killError = await rejection(killed.client.checkGuards(request), AiGuardError);
    expect(killError.reason).toEqual({ kind: 'kill_switch' });
  });

  it('names the model each tier is served by', () => {
    const { client } = setup();
    expect(client.modelFor('standard')).toBe('claude-haiku-5-5');
    expect(client.modelFor('premium')).toBe('claude-sonnet-5-5');
  });
});

describe('AiProviderError defaults', () => {
  it('is not retryable and bills nothing unless told otherwise', () => {
    const error = new AiProviderError('bad_request', 'nope');
    expect(error.retryable).toBe(false);
    expect(error.usage.inputTokens).toBe(0);
  });
});
