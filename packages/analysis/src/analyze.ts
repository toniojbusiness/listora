import {
  AiCallError,
  AiGuardError,
  type AiClient,
  type AiErrorCode,
  type AiTier,
  type QuotaCharge,
} from '@listora/ai';
import type { AnalysisResult } from '@listora/api-contract';
import { assertNever } from '@listora/shared';

import type { AnalysisInput } from './input.ts';
import { decodeAnalysisAnswer, ITEM_ANALYSIS_OUTPUT } from './output-schema.ts';
import { buildAnalysisRequest } from './prompt.ts';
import { buildAnalysisResult } from './result.ts';

/** `ai_usage_event.purpose` of every analysis call, both tiers. */
export const ANALYSIS_PURPOSE = 'item_analysis';

/** The plan unit each tier uses up when its call succeeds (plan section 5.4). */
export const ANALYSIS_QUOTA: Readonly<Record<AiTier, QuotaCharge>> = {
  standard: { metric: 'ai_items', units: 1 },
  premium: { metric: 'premium_identifications', units: 1 },
};

/** Provider calls one analysis makes at most: an answer that breaks the schema is retried once. */
export const MAX_ANALYSIS_ATTEMPTS = 2;

export interface AnalyzeOptions {
  readonly tier: AiTier;
  /** For an escalation: the standard analysis it re-checks. */
  readonly firstAnalysis?: AnalysisResult;
  readonly signal?: AbortSignal;
}

export interface AnalysisOutcome {
  readonly result: AnalysisResult;
  /** Whether the result is worth a premium identification without the user asking for it. */
  readonly autoEscalate: boolean;
  readonly model: string;
  /** Provider calls made, failed ones included. */
  readonly attempts: number;
  /** Metered cost of every call made, in micro-dollars. */
  readonly costMicros: number;
}

/**
 * Why an analysis failed, as the user sees it (`Analysis.failure`). `code` is stable
 * snake_case; `message` is safe to show; `retryable` says whether asking again may work.
 */
export class AnalysisFailedError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly attempts: number;
  readonly costMicros: number;

  constructor(
    failure: { code: string; message: string; retryable: boolean },
    spent: { attempts: number; costMicros: number },
    options?: ErrorOptions,
  ) {
    super(failure.message, options);
    this.name = 'AnalysisFailedError';
    this.code = failure.code;
    this.retryable = failure.retryable;
    this.attempts = spent.attempts;
    this.costMicros = spent.costMicros;
  }
}

/**
 * Analyzes one photo set with one structured call through `AiClient`, so the budget guards,
 * the plan quota, and metering apply to every attempt. An answer that does not match the
 * schema is rejected and the call is sent once more; a second bad answer, or any other
 * failure, throws `AnalysisFailedError`. Nothing here retries a provider outage: that is the
 * caller's decision, made visible to the user.
 */
export async function analyzeItem(
  client: AiClient,
  input: AnalysisInput,
  options: AnalyzeOptions,
): Promise<AnalysisOutcome> {
  const request = buildAnalysisRequest(
    input,
    options.firstAnalysis === undefined ? {} : { firstAnalysis: options.firstAnalysis },
  );
  let attempts = 0;
  let costMicros = 0;
  for (;;) {
    attempts += 1;
    try {
      const answer = await client.generate({
        context: {
          accountId: input.accountId,
          userId: input.userId,
          itemId: input.itemId,
          purpose: ANALYSIS_PURPOSE,
        },
        tier: options.tier,
        system: request.system,
        prompt: request.prompt,
        photoSetHash: input.photoSetHash,
        images: request.images,
        output: ITEM_ANALYSIS_OUTPUT,
        quota: ANALYSIS_QUOTA[options.tier],
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      costMicros += answer.costMicros;
      const { result, autoEscalate } = buildAnalysisResult(
        decodeAnalysisAnswer(answer.output),
        input,
        request.tagFacts,
        options.tier,
      );
      return {
        result,
        autoEscalate,
        model: answer.model,
        attempts,
        costMicros,
      };
    } catch (error) {
      if (error instanceof AiCallError) {
        costMicros += error.costMicros;
        if (error.code === 'invalid_output' && attempts < MAX_ANALYSIS_ATTEMPTS) continue;
      }
      throw new AnalysisFailedError(
        analysisFailure(error),
        { attempts, costMicros },
        {
          cause: error,
        },
      );
    }
  }
}

/** The user-facing failure for an error thrown by `AiClient.generate` or its guards. */
export function analysisFailure(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof AiGuardError) {
    const { reason } = error;
    switch (reason.kind) {
      case 'kill_switch':
        return {
          code: 'ai_unavailable',
          message: 'AI analysis is paused right now. Try again later.',
          retryable: true,
        };
      case 'daily_budget':
        return {
          code: 'ai_budget_exceeded',
          message: `Today's AI budget for this account is used up. Try again after ${reason.resetsAt.toISOString()}.`,
          retryable: true,
        };
      case 'quota':
        return {
          code: 'quota_exceeded',
          message:
            reason.metric === 'premium_identifications'
              ? "This month's premium identifications in your plan are used up."
              : "This month's AI item analyses in your plan are used up.",
          retryable: false,
        };
      default:
        return assertNever(reason);
    }
  }
  if (error instanceof AiCallError) {
    return { code: error.code, ...callFailure(error.code, error.retryable) };
  }
  return {
    code: 'internal_error',
    message: 'The analysis failed unexpectedly. Try again.',
    retryable: true,
  };
}

function callFailure(
  code: AiErrorCode,
  retryable: boolean,
): { message: string; retryable: boolean } {
  switch (code) {
    case 'invalid_output':
      return {
        message: 'The AI gave an unusable answer twice in a row. Try again.',
        retryable: true,
      };
    case 'truncated':
      return { message: "The AI's answer was cut off. Try again.", retryable: true };
    case 'refusal':
      return {
        message: 'The AI could not analyze these photos. Try different photos.',
        retryable: false,
      };
    case 'rate_limited':
    case 'provider_unavailable':
    case 'timeout':
    case 'connection':
      return {
        message: 'The AI service is busy or unreachable. Try again in a few minutes.',
        retryable: true,
      };
    case 'aborted':
      return { message: 'The analysis was stopped. Try again.', retryable: true };
    case 'fixture_missing':
      return {
        message: 'The development AI provider has no answer for these photos.',
        retryable: false,
      };
    case 'auth':
    case 'bad_request':
    case 'unknown':
      return { message: 'The analysis failed. Try again later.', retryable };
    default:
      return assertNever(code);
  }
}
