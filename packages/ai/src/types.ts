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

/**
 * Whether the model may think before it answers. `adaptive` (the default): it decides, within
 * the tier's effort. `off`: it answers at once, for a short, latency-bound call whose answer
 * does not gain from reasoning (the thrift scan's read).
 */
export const AI_THINKING = ['adaptive', 'off'] as const;
export type AiThinking = (typeof AI_THINKING)[number];

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
  /**
   * How the provider holds the model to the schema. `grammar` (the default): constrained
   * decoding (strict structured outputs), so the answer always parses. `prompt`: the JSON
   * schema goes in the system prompt instead, for schemas whose compiled grammar the provider
   * refuses as too large. Either way every answer is validated against `schema`, and one that
   * fails is an `invalid_output` call.
   */
  readonly enforcement?: SchemaEnforcement;
  /**
   * With `grammar`, also hold the answer to the schema's string enums. The SDK's schema helper
   * relaxes every `enum` into a description, so by default the model can still answer a value
   * outside the list (an `invalid_output` call). Turn it on per schema once its grammar is
   * proven to compile live, since a stricter grammar is a larger one.
   */
  readonly strictEnums?: boolean;
}

export const SCHEMA_ENFORCEMENTS = ['grammar', 'prompt'] as const;
export type SchemaEnforcement = (typeof SCHEMA_ENFORCEMENTS)[number];

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

/** A page a web search returned, as the provider read it. */
export interface WebSource {
  readonly url: string;
  readonly title: string;
}

/** The provider's web search, for a call that grounds its answer on the web. */
export interface WebSearchOptions {
  /** Most searches the call may make; each is billed (`webSearchMicros`). */
  readonly maxUses: number;
}
