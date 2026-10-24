import type { AiProvider as AiProviderId, AnalysisTier } from '@listora/db';
import type { z } from 'zod';

export type { AiProviderId };

/**
 * Quality tiers. `standard` is the "Fast" tier every item gets; `premium` is the escalation
 * ("Identify harder"). The same names are used by `ai_analysis.tier` and `ai_usage_event.tier`.
 */
export type AiTier = AnalysisTier;

export const AI_EFFORTS = ['low', 'medium', 'high'] as const;
export type AiEffort = (typeof AI_EFFORTS)[number];

export const AI_IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export type AiImageMediaType = (typeof AI_IMAGE_MEDIA_TYPES)[number];

export interface AiImage {
  readonly mediaType: AiImageMediaType;
  readonly data: Uint8Array;
  /** Pixel size; the fake provider estimates image tokens from it. */
  readonly width: number;
  readonly height: number;
}

/**
 * The structured output a call must return. The Zod schema is the single source of truth: the
 * JSON schema sent to the provider is derived from it, and every response is validated with it.
 */
export interface OutputSchema<T> {
  /** Stable snake_case name, for example `tag_facts`; the fake provider's fixtures use it. */
  readonly name: string;
  readonly schema: z.ZodType<T>;
}

/** Token and tool usage of one call, as billed by the provider. */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly webSearches: number;
}

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  webSearches: 0,
};
