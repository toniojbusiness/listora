import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

import { AiProviderError, type AiErrorCode } from './errors.ts';
import type { AiProvider, ProviderRequest, ProviderResponse } from './provider.ts';
import type { TokenUsage } from './types.ts';

/** The one SDK method the provider uses; tests substitute it. */
export interface AnthropicMessagesApi {
  create(
    params: Anthropic.MessageCreateParamsNonStreaming,
    options: { signal?: AbortSignal },
  ): Promise<Anthropic.Message>;
}

export interface AnthropicProviderOptions {
  readonly apiKey: string;
  /** Per-request timeout. */
  readonly timeoutMs: number;
  /** Replaces the SDK client, for tests. */
  readonly messages?: AnthropicMessagesApi;
}

/**
 * Claude through the official SDK. Each call is one Messages API request with:
 * - strict structured output (`output_config.format`, a JSON schema derived from the Zod
 *   schema; constrained decoding guarantees it parses) and the tier's `effort`;
 * - the photos as base64 image blocks, then the per-request text;
 * - a cache breakpoint on the system prompt, so the stable prefix (system prompt and the
 *   structured-output instructions) is billed at the cache-read price on repeat calls.
 *
 * The SDK's own retries are off (`maxRetries: 0`): every request the API sees becomes one
 * metered event, and retrying is the caller's decision.
 */
export class AnthropicProvider implements AiProvider {
  readonly id = 'anthropic';
  readonly #messages: AnthropicMessagesApi;

  constructor(options: AnthropicProviderOptions) {
    if (options.messages !== undefined) {
      this.#messages = options.messages;
    } else {
      const client = new Anthropic({
        apiKey: options.apiKey,
        timeout: options.timeoutMs,
        maxRetries: 0,
      });
      this.#messages = {
        create: (params, requestOptions) => client.messages.create(params, requestOptions),
      };
    }
  }

  async generate<T>(request: ProviderRequest<T>): Promise<ProviderResponse<T>> {
    let message: Anthropic.Message;
    try {
      message = await this.#messages.create(
        buildParams(request),
        request.signal === undefined ? {} : { signal: request.signal },
      );
    } catch (error) {
      throw toProviderError(error);
    }
    return readResponse(request, message);
  }
}

export function buildParams(
  request: ProviderRequest<unknown>,
): Anthropic.MessageCreateParamsNonStreaming {
  const format = zodOutputFormat(request.output.schema);
  return {
    model: request.model,
    max_tokens: request.maxOutputTokens,
    system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          ...request.images.map((image): Anthropic.ImageBlockParam => ({
            type: 'image',
            source: {
              type: 'base64',
              media_type: image.mediaType,
              data: Buffer.from(image.data).toString('base64'),
            },
          })),
          { type: 'text', text: request.prompt },
        ],
      },
    ],
    // Only the JSON schema goes on the wire; parsing happens below so that a response that
    // fails validation is still metered.
    output_config: {
      effort: request.effort,
      format: { type: 'json_schema', schema: format.schema },
    },
  };
}

function readResponse<T>(
  request: ProviderRequest<T>,
  message: Anthropic.Message,
): ProviderResponse<T> {
  const usage = usageOf(message.usage);
  switch (message.stop_reason) {
    case 'refusal':
      throw new AiProviderError('refusal', 'the model declined to answer', { usage });
    case 'max_tokens':
    case 'model_context_window_exceeded':
      throw new AiProviderError(
        'truncated',
        `the output stopped at the token limit (${message.stop_reason})`,
        { usage },
      );
    case 'pause_turn':
    case 'tool_use':
      throw new AiProviderError('invalid_output', `unexpected stop reason ${message.stop_reason}`, {
        usage,
      });
    case 'end_turn':
    case 'stop_sequence':
    case null:
      break;
  }

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AiProviderError('invalid_output', 'the output is not valid JSON', { usage });
  }
  const parsed = request.output.schema.safeParse(json);
  if (!parsed.success) {
    throw new AiProviderError(
      'invalid_output',
      `the output does not match the ${request.output.name} schema: ${parsed.error.message}`,
      { usage },
    );
  }
  return { output: parsed.data, usage };
}

function usageOf(usage: Anthropic.Usage): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    webSearches: usage.server_tool_use?.web_search_requests ?? 0,
  };
}

/**
 * Maps SDK errors, most specific first. A request the API rejected or never answered is not
 * billed, so these carry no usage. A timeout is the exception that may have been billed; the
 * API reports no usage for it, so it is metered at zero and flagged by its code.
 */
export function toProviderError(error: unknown): AiProviderError {
  const fail = (code: AiErrorCode, retryable: boolean, message: string): AiProviderError =>
    new AiProviderError(code, message, { retryable, cause: error });

  if (error instanceof AiProviderError) return error;
  if (error instanceof Anthropic.APIUserAbortError)
    return fail('aborted', false, 'the call was aborted');
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return fail('timeout', true, 'the Anthropic API did not answer in time');
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return fail('connection', true, 'could not reach the Anthropic API');
  }
  if (error instanceof Anthropic.RateLimitError) {
    return fail('rate_limited', true, 'the Anthropic API rate limit was hit (429)');
  }
  if (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError
  ) {
    return fail(
      'auth',
      false,
      `the Anthropic API rejected the credential (${String(error.status)})`,
    );
  }
  if (error instanceof Anthropic.InternalServerError) {
    return fail(
      'provider_unavailable',
      true,
      `the Anthropic API is unavailable (${String(error.status)})`,
    );
  }
  if (error instanceof Anthropic.APIError) {
    const status: number = typeof error.status === 'number' ? error.status : 0;
    if (status === 408) {
      return fail('timeout', true, 'the Anthropic API timed out the request (408)');
    }
    if (status === 409) {
      return fail('provider_unavailable', true, 'the Anthropic API reported a conflict (409)');
    }
    if (status >= 400 && status < 500) {
      return fail('bad_request', false, `the Anthropic API rejected the request: ${error.message}`);
    }
    return fail('unknown', status >= 500, `Anthropic API error: ${error.message}`);
  }
  return fail('unknown', false, error instanceof Error ? error.message : String(error));
}
