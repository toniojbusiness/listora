import { ANALYSIS_TIERS } from '@listora/db';

import { isPriced, UnpricedModelError, type PriceTable } from './prices.ts';
import type { AiEffort, AiTier } from './types.ts';

export const AI_TIERS = ANALYSIS_TIERS;

export interface TierSettings {
  readonly model: string;
  readonly effort: AiEffort;
  /** Output cap per call; structured JSON plus low-effort thinking fits comfortably. */
  readonly maxOutputTokens: number;
}

/** Which model and settings serve each tier. */
export type ModelRegistry = Readonly<Record<AiTier, TierSettings>>;

/** Plan section 5.1: Haiku 5.5 at low effort for every item, Sonnet 5.5 for escalation. */
export const DEFAULT_MODEL_REGISTRY: ModelRegistry = {
  standard: { model: 'claude-haiku-5-5', effort: 'low', maxOutputTokens: 8_000 },
  premium: { model: 'claude-sonnet-5-5', effort: 'medium', maxOutputTokens: 16_000 },
};

/**
 * How each model turns its thinking off (`thinking: 'off'`), since the API takes a different
 * setting per model and answers any other with a 400 (checked against the live API 2026-11-02):
 * - `disabled`: `thinking: { type: 'disabled' }` (Haiku 5.5);
 * - `between_tools`: `thinking: { type: 'between_tools' }`, the model does not think before
 *   answering and writes only short updates between tool calls (Sonnet 5.5);
 * - `unsupported`: the model's thinking cannot be turned off (Opus 5.5 takes neither), so the
 *   request sends no thinking setting and the model thinks adaptively within the tier's effort.
 */
export type ThinkingOff = 'disabled' | 'between_tools' | 'unsupported';

export const THINKING_OFF_BY_MODEL: Readonly<Record<string, ThinkingOff>> = {
  'claude-haiku-5-5': 'disabled',
  'claude-sonnet-5-5': 'between_tools',
  'claude-opus-5-5': 'unsupported',
};

/**
 * How `model` turns its thinking off. A model not in the table sends no thinking setting, so a
 * new model thinks rather than having every call rejected.
 */
export function thinkingOffFor(model: string): ThinkingOff {
  return THINKING_OFF_BY_MODEL[model] ?? 'unsupported';
}

/**
 * The default registry with the configured models swapped in, so switching a tier's model is
 * a configuration change. Every model must have a price, or its calls could not be metered.
 */
export function createModelRegistry(
  models: Partial<Readonly<Record<AiTier, string>>>,
  prices: PriceTable,
): ModelRegistry {
  const registry = Object.fromEntries(
    AI_TIERS.map((tier) => {
      const settings = DEFAULT_MODEL_REGISTRY[tier];
      const model = models[tier] ?? settings.model;
      if (!isPriced(prices, model)) throw new UnpricedModelError(model, prices.version);
      return [tier, { ...settings, model }];
    }),
  ) as Record<AiTier, TierSettings>;
  return registry;
}
