import type {
  AiEffort,
  AiImage,
  AiProviderId,
  OutputSchema,
  TokenUsage,
  WebSearchOptions,
  WebSource,
} from './types.ts';

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
  /**
   * The item's photo-set hash (`ai_analysis.photo_set_hash`): `photoSetHash` over the upload
   * sha256s (in any order), not over the bytes in `images`. The fake provider keys its fixtures by it.
   */
  readonly photoSetHash: string;
  /** In order; usually the photos' `ai` derivatives. */
  readonly images: readonly AiImage[];
  readonly output: OutputSchema<T>;
  readonly maxOutputTokens: number;
  /** Lets the model search the web before it answers; absent, it never does. */
  readonly webSearch?: WebSearchOptions;
  readonly signal?: AbortSignal;
}

export interface ProviderResponse<T> {
  readonly output: T;
  readonly usage: TokenUsage;
  /** Every page the call's web searches returned, so an answer's sources can be checked. */
  readonly webSources?: readonly WebSource[];
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
