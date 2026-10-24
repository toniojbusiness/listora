import {
  TAG_FIELDS,
  parseTagText,
  valuesOf,
  type TagField,
  type TagValues,
} from '@listora/tag-parse';

import { imagePath, type LoadedCorpus } from './corpus/store.ts';
import { EvalProviderError, type EvalProvider } from './provider.ts';
import {
  accuracy,
  emptyTally,
  precision,
  recall,
  scoreItem,
  type FieldMismatch,
  type FieldTally,
} from './scoring.ts';

export interface FieldReport {
  readonly items: number;
  readonly correct: number;
  readonly accuracy: number;
  readonly precision: number | null;
  readonly recall: number | null;
  readonly falsePositives: number;
}

export interface SystemReport {
  /** `parsers` for the deterministic parsers, otherwise `provider:<id>`. */
  readonly id: string;
  readonly description: string;
  readonly fields: Readonly<Record<TagField, FieldReport>>;
  /** Correct (item, field) pairs over all pairs. */
  readonly overallAccuracy: number;
  /** The lowest per-field accuracy, which the CLI's --min-accuracy gate checks. */
  readonly minFieldAccuracy: number;
  readonly costMicrosTotal: number;
  readonly costMicrosPerItem: number;
  /**
   * Items whose provider call failed; scored as "no values" so failures cost accuracy. A
   * failure's billed cost (from `EvalProviderError.usage`) is included in the cost totals.
   */
  readonly errors: readonly { readonly caseId: string; readonly message: string }[];
  readonly mismatches: readonly (FieldMismatch & { readonly caseId: string })[];
}

export interface EvalReport {
  readonly corpus: {
    readonly name: string;
    readonly generatorVersion: number;
    readonly seed: number;
    readonly items: number;
  };
  readonly systems: readonly SystemReport[];
}

/**
 * Runs the deterministic parsers, and the provider when one is given, over every corpus item
 * and scores each against the ground truth. Items run one at a time so a provider sees a
 * steady, predictable call rate.
 */
export async function runEval(
  corpus: LoadedCorpus,
  options: { provider?: EvalProvider } = {},
): Promise<EvalReport> {
  const parsers = new SystemAccumulator('parsers', 'deterministic tag-text parsers (no AI)');
  const provider = options.provider;
  const providerSystem =
    provider === undefined
      ? undefined
      : new SystemAccumulator(`provider:${provider.id}`, provider.description);

  for (const corpusCase of corpus.cases) {
    const facts = parseTagText(corpusCase.ocr);
    parsers.add(corpusCase.id, corpusCase.truth, valuesOf(facts), 0);
    if (provider === undefined || providerSystem === undefined) continue;
    try {
      const result = await provider.extract({
        caseId: corpusCase.id,
        image: {
          path: imagePath(corpus, corpusCase),
          mediaType: corpusCase.image.mediaType,
          width: corpusCase.image.width,
          height: corpusCase.image.height,
        },
        ocr: corpusCase.ocr,
        parsed: facts,
      });
      assertCostMicros(result.usage.costMicros);
      providerSystem.add(corpusCase.id, corpusCase.truth, result.values, result.usage.costMicros);
    } catch (error) {
      providerSystem.fail(corpusCase.id, corpusCase.truth, failedCall(error));
    }
  }

  return {
    corpus: {
      name: corpus.manifest.name,
      generatorVersion: corpus.manifest.generatorVersion,
      seed: corpus.manifest.seed,
      items: corpus.cases.length,
    },
    systems: [parsers.report(), ...(providerSystem ? [providerSystem.report()] : [])],
  };
}

function assertCostMicros(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`provider reported an invalid costMicros: ${String(value)}`);
  }
}

/** The message and billed cost of a failed call; an invalid reported cost counts as 0. */
function failedCall(error: unknown): { message: string; costMicros: number } {
  const message = errorMessage(error);
  const usage = error instanceof EvalProviderError ? error.usage : undefined;
  if (usage === undefined) return { message, costMicros: 0 };
  try {
    assertCostMicros(usage.costMicros);
  } catch (costError) {
    return { message: `${message}; ${errorMessage(costError)}`, costMicros: 0 };
  }
  return { message, costMicros: usage.costMicros };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class SystemAccumulator {
  readonly #id: string;
  readonly #description: string;
  readonly #tallies = Object.fromEntries(
    TAG_FIELDS.map((field) => [field, emptyTally()]),
  ) as Record<TagField, FieldTally>;
  readonly #errors: { caseId: string; message: string }[] = [];
  readonly #mismatches: (FieldMismatch & { caseId: string })[] = [];
  #items = 0;
  #costMicros = 0;

  constructor(id: string, description: string) {
    this.#id = id;
    this.#description = description;
  }

  add(caseId: string, truth: TagValues, predicted: Partial<TagValues>, costMicros: number): void {
    this.#items += 1;
    this.#costMicros += costMicros;
    for (const mismatch of scoreItem(this.#tallies, truth, predicted)) {
      this.#mismatches.push({ caseId, ...mismatch });
    }
  }

  fail(
    caseId: string,
    truth: TagValues,
    failure: { readonly message: string; readonly costMicros: number },
  ): void {
    this.#errors.push({ caseId, message: failure.message });
    this.add(caseId, truth, {}, failure.costMicros);
  }

  report(): SystemReport {
    const fields = Object.fromEntries(
      TAG_FIELDS.map((field) => {
        const tally = this.#tallies[field];
        const report: FieldReport = {
          items: tally.items,
          correct: tally.correct,
          accuracy: accuracy(tally),
          precision: precision(tally),
          recall: recall(tally),
          falsePositives: tally.falsePositives,
        };
        return [field, report];
      }),
    ) as Record<TagField, FieldReport>;
    const all = Object.values(fields);
    const correct = all.reduce((sum, field) => sum + field.correct, 0);
    const pairs = all.reduce((sum, field) => sum + field.items, 0);
    return {
      id: this.#id,
      description: this.#description,
      fields,
      overallAccuracy: pairs === 0 ? 0 : correct / pairs,
      minFieldAccuracy: Math.min(...all.map((field) => field.accuracy)),
      costMicrosTotal: this.#costMicros,
      costMicrosPerItem: this.#items === 0 ? 0 : this.#costMicros / this.#items,
      errors: this.#errors,
      mismatches: this.#mismatches,
    };
  }
}
