import { ZERO_USAGE, type AiTier, type TokenUsage } from './types.ts';

/**
 * Why a provider call failed. The code is stored in `ai_usage_event.error_code`, so the
 * values are snake_case and must stay stable.
 */
export const AI_ERROR_CODES = [
  /** 429 from the provider. */
  'rate_limited',
  /** 5xx or overloaded. */
  'provider_unavailable',
  /** No response in time; the request may or may not have run. */
  'timeout',
  /** The network failed before a response arrived. */
  'connection',
  /** The caller's signal aborted the call. */
  'aborted',
  /** The credential was rejected. */
  'auth',
  /** The provider rejected the request as invalid (a bug on our side). */
  'bad_request',
  /** The model declined to answer. */
  'refusal',
  /** The output hit the token limit before it was complete. */
  'truncated',
  /** The output did not match the schema. */
  'invalid_output',
  /** The fake provider has no fixture for this photo set and schema. */
  'fixture_missing',
  'unknown',
] as const;
export type AiErrorCode = (typeof AI_ERROR_CODES)[number];

/**
 * A provider call that failed. `usage` is what the provider billed for it (zero when nothing
 * was billed), so a failed call is still metered at its real cost.
 */
export class AiProviderError extends Error {
  readonly code: AiErrorCode;
  /** Whether the same request may succeed if sent again later. */
  readonly retryable: boolean;
  readonly usage: TokenUsage;

  constructor(
    code: AiErrorCode,
    message: string,
    options: { retryable?: boolean; usage?: TokenUsage; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AiProviderError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.usage = options.usage ?? ZERO_USAGE;
  }
}

/**
 * A metered call that failed. The failure is already recorded as an `ai_usage_event` with
 * its real usage and cost; the fields say what was recorded.
 */
export class AiCallError extends Error {
  readonly code: AiErrorCode;
  readonly retryable: boolean;
  readonly tier: AiTier;
  readonly model: string;
  readonly usage: TokenUsage;
  readonly costMicros: number;
  readonly usageEventId: string;

  constructor(
    failure: AiProviderError,
    recorded: { tier: AiTier; model: string; costMicros: number; usageEventId: string },
  ) {
    super(`AI call failed (${failure.code}): ${failure.message}`, { cause: failure });
    this.name = 'AiCallError';
    this.code = failure.code;
    this.retryable = failure.retryable;
    this.usage = failure.usage;
    this.tier = recorded.tier;
    this.model = recorded.model;
    this.costMicros = recorded.costMicros;
    this.usageEventId = recorded.usageEventId;
  }
}

/** Why a budget guard refused a call before it reached the provider. */
export type AiGuardReason =
  | { readonly kind: 'kill_switch' }
  | {
      readonly kind: 'daily_budget';
      readonly spentMicros: number;
      readonly limitMicros: number;
      /** Start of the next UTC day, when the budget resets. */
      readonly resetsAt: Date;
    }
  | {
      readonly kind: 'quota';
      readonly metric: string;
      readonly used: number;
      readonly limit: number;
    };

/**
 * A guard refused the call. Nothing was sent to the provider and nothing billable was
 * recorded, so the caller may show the reason and try again once it clears.
 */
export class AiGuardError extends Error {
  readonly reason: AiGuardReason;

  constructor(reason: AiGuardReason) {
    super(guardMessage(reason));
    this.name = 'AiGuardError';
    this.reason = reason;
  }
}

function guardMessage(reason: AiGuardReason): string {
  switch (reason.kind) {
    case 'kill_switch':
      return 'AI is turned off for every account (global kill switch)';
    case 'daily_budget':
      return (
        `AI daily budget reached for this account: ${dollars(reason.spentMicros)} of ` +
        `${dollars(reason.limitMicros)} used today (UTC); it resets at ` +
        reason.resetsAt.toISOString()
      );
    case 'quota':
      return `AI quota ${reason.metric} used up: ${String(reason.used)} of ${String(reason.limit)}`;
  }
}

/** Micro-dollars as dollars, at the message edge only. */
function dollars(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(micros % 10_000 === 0 ? 2 : 6)}`;
}
