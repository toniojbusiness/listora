import { valuesOf, type TagFacts, type TagTextInput, type TagValues } from '@listora/tag-parse';

/**
 * What the eval harness hands an attribute provider for one corpus item. It mirrors the
 * production analysis input: the tag photo, the on-device reads, and the deterministic facts.
 */
export interface EvalProviderInput {
  readonly caseId: string;
  readonly image: {
    readonly path: string;
    readonly mediaType: 'image/png';
    readonly width: number;
    readonly height: number;
  };
  readonly ocr: TagTextInput;
  readonly parsed: TagFacts;
}

export interface EvalProviderResult {
  /** The provider's answer per field; a missing field counts as "no value found". */
  readonly values: Partial<TagValues>;
  readonly usage: {
    /** Cost of this call in micro-dollars (1,000,000 = $1), as an integer. */
    readonly costMicros: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
  };
}

/**
 * The seam between the harness and an AI provider. The provider package (plan task T-08)
 * supplies the real implementation behind its own interface; an adapter maps it onto this one,
 * so the harness never depends on a vendor SDK or credential.
 */
export interface EvalProvider {
  readonly id: string;
  readonly description: string;
  extract(input: EvalProviderInput): Promise<EvalProviderResult>;
}

export interface StubProviderOptions {
  /** Cost to report per call; defaults to 0 because the stub makes no paid call. */
  readonly costMicrosPerItem?: number;
}

/**
 * Stand-in provider until the AI provider package lands. It makes no network call and returns
 * the deterministic parser facts as its answer, which is the floor a real provider must beat.
 */
export class StubProvider implements EvalProvider {
  readonly id = 'stub';
  readonly description = 'stub provider: echoes the deterministic parser facts; makes no AI call';
  readonly #costMicrosPerItem: number;

  constructor(options: StubProviderOptions = {}) {
    this.#costMicrosPerItem = options.costMicrosPerItem ?? 0;
  }

  extract(input: EvalProviderInput): Promise<EvalProviderResult> {
    return Promise.resolve({
      values: valuesOf(input.parsed),
      usage: { costMicros: this.#costMicrosPerItem },
    });
  }
}
