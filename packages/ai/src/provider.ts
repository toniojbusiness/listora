import type { AiEffort, AiImage, AiProviderId, OutputSchema, TokenUsage } from './types.ts';

/** One multimodal structured-output request, already resolved to a concrete model. */
export interface ProviderRequest<T> {
  readonly model: string;
  readonly effort: AiEffort;
  /**
   * Stable instructions. Providers cache it (with the schema), so it must not contain
   * per-request values such as ids or timestamps.
   */
  readonly system: string;
  /** The per-request text, for example the parsed tag facts. */
  readonly prompt: string;
  /** In order; the order is part of the photo-set hash. */
  readonly images: readonly AiImage[];
  readonly output: OutputSchema<T>;
  readonly maxOutputTokens: number;
  readonly signal?: AbortSignal;
}

export interface ProviderResponse<T> {
  readonly output: T;
  readonly usage: TokenUsage;
}

/**
 * The seam between Listora and an AI vendor. Implementations send exactly one request per
 * call and never retry, so every request the vendor sees is metered as its own event; retries
 * belong to the caller (for example a job's backoff). On failure they throw `AiProviderError`
 * carrying whatever usage the vendor billed.
 *
 * Callers do not use providers directly: `AiClient` adds the budget guards and metering.
 */
export interface AiProvider {
  readonly id: AiProviderId;
  generate<T>(request: ProviderRequest<T>): Promise<ProviderResponse<T>>;
}
