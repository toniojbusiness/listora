import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import {
  AnthropicProvider,
  buildParams,
  toProviderError,
  type AnthropicMessagesApi,
} from './anthropic-provider.ts';
import { AiClient } from './client.ts';
import { AiProviderError } from './errors.ts';
import { staticKillSwitch } from './guards.ts';
import { createModelRegistry } from './models.ts';
import { CURRENT_PRICE_TABLE } from './prices.ts';
import type { ProviderRequest } from './provider.ts';
import { COLOR_OUTPUT, image, RED_PIXEL_PNG } from './test-support.ts';
import { InMemoryUsageStore } from './usage-store.ts';

type Color = z.infer<typeof COLOR_OUTPUT.schema>;

const REQUEST: ProviderRequest<Color> = {
  model: 'claude-haiku-5-5',
  effort: 'low',
  system: 'You name the dominant color of a photo.',
  prompt: 'Which color dominates?',
  photoSetHash: 'e'.repeat(64),
  images: [image(RED_PIXEL_PNG, 1, 1)],
  output: COLOR_OUTPUT,
  maxOutputTokens: 1_000,
};

function message(overrides: {
  text?: string;
  stop_reason?: Anthropic.StopReason | null;
  usage?: Partial<Anthropic.Usage>;
}): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      {
        type: 'text',
        text: overrides.text ?? '{"color":"red","confidence":0.97}',
        citations: null,
      },
    ],
    stop_reason: overrides.stop_reason === undefined ? 'end_turn' : overrides.stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: 1_200,
      output_tokens: 80,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 0,
      server_tool_use: null,
      ...overrides.usage,
    },
  } as unknown as Anthropic.Message;
}

function providerReturning(reply: Anthropic.Message | Error): {
  provider: AnthropicProvider;
  create: ReturnType<typeof vi.fn<AnthropicMessagesApi['create']>>;
} {
  const create = vi.fn<AnthropicMessagesApi['create']>(() =>
    reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply),
  );
  return {
    provider: new AnthropicProvider({ apiKey: 'unused', timeoutMs: 1_000, messages: { create } }),
    create,
  };
}

async function failure(work: Promise<unknown>): Promise<AiProviderError> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(AiProviderError);
  return error as AiProviderError;
}

describe('AnthropicProvider request', () => {
  it('sends strict structured output, base64 images, effort, and a cached system prompt', () => {
    const params = buildParams(REQUEST);
    expect(params).toMatchObject({
      model: 'claude-haiku-5-5',
      max_tokens: 1_000,
      system: [
        {
          type: 'text',
          text: 'You name the dominant color of a photo.',
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: Buffer.from(RED_PIXEL_PNG).toString('base64'),
              },
            },
            { type: 'text', text: 'Which color dominates?' },
          ],
        },
      ],
      output_config: {
        effort: 'low',
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: { color: { type: 'string' }, confidence: { type: 'number' } },
            required: ['color', 'confidence'],
            additionalProperties: false,
          },
        },
      },
    });
    // Only data goes on the wire: no parse function and no extra request fields.
    expect(JSON.parse(JSON.stringify(params))).toEqual(params);
    expect(Object.keys(params).sort()).toEqual(
      ['max_tokens', 'messages', 'model', 'output_config', 'system'].sort(),
    );
  });

  it('passes the caller abort signal to the SDK', async () => {
    const { provider, create } = providerReturning(message({}));
    const controller = new AbortController();
    await provider.generate({ ...REQUEST, signal: controller.signal });
    expect(create).toHaveBeenCalledWith(expect.anything(), { signal: controller.signal });
  });
});

describe('AnthropicProvider response', () => {
  it('returns the validated output and the billed usage', async () => {
    const { provider } = providerReturning(
      message({ usage: { server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 } } }),
    );
    expect(await provider.generate(REQUEST)).toEqual({
      output: { color: 'red', confidence: 0.97 },
      usage: {
        inputTokens: 1_200,
        outputTokens: 80,
        cacheReadTokens: 900,
        cacheWriteTokens: 0,
        webSearches: 2,
      },
    });
  });

  it.each([
    ['refusal', 'refusal'],
    ['max_tokens', 'truncated'],
    ['model_context_window_exceeded', 'truncated'],
    ['pause_turn', 'invalid_output'],
  ] as const)('maps stop reason %s to %s and keeps the usage', async (stopReason, code) => {
    const { provider } = providerReturning(message({ stop_reason: stopReason }));
    const error = await failure(provider.generate(REQUEST));
    expect(error).toMatchObject({
      code,
      retryable: false,
      usage: { inputTokens: 1_200, outputTokens: 80 },
    });
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['JSON that breaks the schema', '{"color":7}'],
  ])('fails with invalid_output on %s, keeping the usage', async (_, text) => {
    const { provider } = providerReturning(message({ text }));
    const error = await failure(provider.generate(REQUEST));
    expect(error).toMatchObject({ code: 'invalid_output', usage: { outputTokens: 80 } });
  });
});

describe('toProviderError', () => {
  const headers = new Headers();
  const body = (type: string) => ({ type: 'error', error: { type, message: 'detail' } });

  it.each([
    [
      Anthropic.APIError.generate(429, body('rate_limit_error'), 'rate limited', headers),
      'rate_limited',
      true,
    ],
    [
      Anthropic.APIError.generate(529, body('overloaded_error'), 'overloaded', headers),
      'provider_unavailable',
      true,
    ],
    [
      Anthropic.APIError.generate(500, body('api_error'), 'boom', headers),
      'provider_unavailable',
      true,
    ],
    [
      Anthropic.APIError.generate(401, body('authentication_error'), 'bad key', headers),
      'auth',
      false,
    ],
    [Anthropic.APIError.generate(403, body('permission_error'), 'denied', headers), 'auth', false],
    [
      Anthropic.APIError.generate(400, body('invalid_request_error'), 'bad', headers),
      'bad_request',
      false,
    ],
    [
      Anthropic.APIError.generate(404, body('not_found_error'), 'no model', headers),
      'bad_request',
      false,
    ],
    [
      Anthropic.APIError.generate(408, body('timeout_error'), 'request timeout', headers),
      'timeout',
      true,
    ],
    [
      Anthropic.APIError.generate(409, body('conflict_error'), 'conflict', headers),
      'provider_unavailable',
      true,
    ],
    [new Anthropic.APIConnectionTimeoutError(), 'timeout', true],
    [new Anthropic.APIConnectionError({ message: 'reset' }), 'connection', true],
    [new Anthropic.APIUserAbortError(), 'aborted', false],
    [new Error('surprise'), 'unknown', false],
  ] as const)('maps %o to %s', (error, code, retryable) => {
    const mapped = toProviderError(error);
    expect(mapped).toMatchObject({ code, retryable, usage: { inputTokens: 0, outputTokens: 0 } });
    expect(mapped.cause).toBe(error);
  });

  it('turns an SDK failure into a typed provider error without usage', async () => {
    const { provider } = providerReturning(
      Anthropic.APIError.generate(429, body('rate_limit_error'), 'rate limited', headers),
    );
    expect(await failure(provider.generate(REQUEST))).toMatchObject({
      code: 'rate_limited',
      retryable: true,
    });
  });
});

describe('AnthropicProvider with the schema in the prompt', () => {
  const PROMPTED = { ...REQUEST, output: { ...COLOR_OUTPUT, enforcement: 'prompt' as const } };

  it('sends the JSON schema as cached system instructions instead of a grammar', () => {
    const params = buildParams(PROMPTED);
    expect(params.output_config).toEqual({ effort: 'low' });
    expect(params.system).toEqual([
      { type: 'text', text: REQUEST.system },
      {
        type: 'text',
        text: expect.stringContaining('"color"') as unknown,
        cache_control: { type: 'ephemeral' },
      },
    ]);
    // The full schema, as Zod states it.
    expect(JSON.stringify(params.system)).toContain('required');
  });

  it('validates the answer against the schema, tolerating a code fence', async () => {
    const fenced = providerReturning(
      message({ text: '```json\n{"color":"red","confidence":0.9}\n```' }),
    );
    await expect(fenced.provider.generate(PROMPTED)).resolves.toMatchObject({
      output: { color: 'red', confidence: 0.9 },
    });
    const wrong = providerReturning(message({ text: '{"colour":"red"}' }));
    expect(await failure(wrong.provider.generate(PROMPTED))).toMatchObject({
      code: 'invalid_output',
      usage: { inputTokens: 1_200, outputTokens: 80 },
    });
    const wrapped = providerReturning(
      message({ text: 'Here is the answer:\n{"color":"red","confidence":0.8}\nDone.' }),
    );
    await expect(wrapped.provider.generate(PROMPTED)).resolves.toMatchObject({
      output: { color: 'red' },
    });
    const prose = providerReturning(message({ text: 'The color is red.' }));
    expect((await failure(prose.provider.generate(PROMPTED))).code).toBe('invalid_output');
  });
});

// Live smoke test against the real API. It runs only when ANTHROPIC_API_KEY is set (never in
// CI) and costs a fraction of a cent: one tiny image on Haiku 5.5.
const apiKey = process.env['ANTHROPIC_API_KEY'] ?? '';
describe.skipIf(apiKey === '')('AnthropicProvider live smoke test', () => {
  it('answers a structured image question and meters it', async () => {
    const store = new InMemoryUsageStore();
    const client = new AiClient({
      provider: new AnthropicProvider({ apiKey, timeoutMs: 60_000 }),
      registry: createModelRegistry({}, CURRENT_PRICE_TABLE),
      usageStore: store,
      killSwitch: staticKillSwitch(false),
      dailyBudgetMicros: 100_000,
    });
    const result = await client.generate({
      context: { accountId: 'smoke-test', purpose: 'smoke_test' },
      tier: 'standard',
      system: REQUEST.system,
      prompt: 'Which color dominates this image? Use a lowercase color name.',
      photoSetHash: REQUEST.photoSetHash,
      images: [{ mediaType: 'image/png', data: RED_PIXEL_PNG, width: 1, height: 1 }],
      output: COLOR_OUTPUT,
    });
    expect(result.output.color).toMatch(/red/);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.costMicros).toBeGreaterThan(0);
    expect(store.events).toHaveLength(1);
  }, 90_000);
});
