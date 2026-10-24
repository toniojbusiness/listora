import {
  TAG_FIELDS,
  valueKey,
  type TagField,
  type TagValues,
  type TagValueTypes,
} from '@listora/tag-parse';

/**
 * Scoring rules:
 *
 * - `exact` (the default): an item's field is correct when the predicted set of values equals
 *   the ground-truth set exactly (order ignored). A tag with no RN is correct only when
 *   nothing is predicted, so false positives cost accuracy.
 * - `one_of`, for systems that report one value per field (an item has one size even when its
 *   tag prints US, UK, and EU sizes): correct when the one predicted value is among the
 *   ground-truth values, or when both are empty.
 * - Precision and recall count individual values, so a partly right fiber list gets credit.
 */
export const SCORING_MODES = ['exact', 'one_of'] as const;
export type ScoringMode = (typeof SCORING_MODES)[number];
export interface FieldTally {
  items: number;
  correct: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
}

export interface FieldMismatch {
  readonly field: TagField;
  readonly expected: readonly string[];
  readonly actual: readonly string[];
}

export function emptyTally(): FieldTally {
  return { items: 0, correct: 0, truePositives: 0, falsePositives: 0, falseNegatives: 0 };
}

export function keysOf<F extends TagField>(
  field: F,
  values: readonly TagValueTypes[F][] | undefined,
): string[] {
  return [...new Set((values ?? []).map((value) => valueKey(field, value)))].sort();
}

/** Adds one item to the tallies of the fields they hold and returns the fields it got wrong. */
export function scoreItem(
  tallies: Partial<Record<TagField, FieldTally>>,
  truth: TagValues,
  predicted: Partial<TagValues>,
  mode: ScoringMode = 'exact',
): FieldMismatch[] {
  const mismatches: FieldMismatch[] = [];
  for (const field of TAG_FIELDS) {
    const tally = tallies[field];
    if (tally === undefined) continue;
    const expected = keysOf(field, truth[field]);
    const actual = keysOf(field, predicted[field]);
    const expectedSet = new Set(expected);
    const truePositives = actual.filter((key) => expectedSet.has(key)).length;
    tally.items += 1;
    tally.truePositives += truePositives;
    tally.falsePositives += actual.length - truePositives;
    tally.falseNegatives += expected.length - truePositives;
    const correct =
      mode === 'exact'
        ? truePositives === expected.length && actual.length === expected.length
        : expected.length === 0
          ? actual.length === 0
          : actual.length === 1 && truePositives === 1;
    if (correct) {
      tally.correct += 1;
    } else {
      mismatches.push({ field, expected, actual });
    }
  }
  return mismatches;
}

export function accuracy(tally: FieldTally): number {
  return tally.items === 0 ? 0 : tally.correct / tally.items;
}

/** Null when nothing was predicted (precision) or nothing was expected (recall). */
export function precision(tally: FieldTally): number | null {
  const predicted = tally.truePositives + tally.falsePositives;
  return predicted === 0 ? null : tally.truePositives / predicted;
}

export function recall(tally: FieldTally): number | null {
  const expected = tally.truePositives + tally.falseNegatives;
  return expected === 0 ? null : tally.truePositives / expected;
}
