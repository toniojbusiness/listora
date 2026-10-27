/**
 * How one field of the pre-fill gets its value, the same way for every field: the seller's
 * answer, else Listora's mapping (or the marketplace's default for an in-between item), else the
 * AI's pick when it is sure, else a question with the ranked short list. A question the AI has
 * not seen yet is collected as a decision, so one AI call answers all of them.
 */
import type {
  PrefillDecision,
  PrefillField,
  PrefillFieldKey,
  PrefillInput,
  PrefillOption,
  PrefillSource,
} from './types.ts';

/** How many options the review shows for a question (the rest are behind "More"). */
export const SHORT_LIST = 4;
/**
 * How many candidates the AI chooses among, at most: enough for every top-level kind of
 * Mercari's tree (230) for an item whose category says nothing, at a few tokens each.
 */
export const AI_CANDIDATES = 300;
/** The AI's pick is the value at or above this confidence; below it, the seller is asked. */
export const AI_PICK_CONFIDENCE = 0.7;

export interface FieldSpec {
  readonly key: string;
  readonly field: PrefillFieldKey;
  readonly label: string;
  /** What is chosen, for the AI: "Depop category". */
  readonly question: string;
  /** The candidates, best first. */
  readonly options: readonly PrefillOption[];
  /** Listora's own value, when its mapping has one. */
  readonly base: {
    option: PrefillOption;
    source: Extract<PrefillSource, 'listora' | 'default'>;
  } | null;
  readonly note?: string | null;
  /** An answer that is not one of `options` but the form takes (any category of the tree). */
  readonly accepts?: (value: string) => PrefillOption | null;
  /** Whether an open question goes to the AI: only when the item says something to go on. */
  readonly askAi: boolean;
  /** Every value the form offers, when short enough to show whole. */
  readonly choices?: readonly PrefillOption[] | null;
  /**
   * A field that waits for another answer (a kids' Mercari category waits for girls or boys):
   * no value and no question of its own.
   */
  readonly waitsFor?: string | null;
}

export function chooseField(
  spec: FieldSpec,
  input: PrefillInput,
  decisions: PrefillDecision[],
): PrefillField {
  const field = (
    value: PrefillOption | null,
    source: PrefillSource | null,
    needsAnswer: boolean,
    note: string | null,
  ): PrefillField => ({
    key: spec.field,
    label: spec.label,
    value,
    options: shortList(value, spec.options),
    choices: spec.choices ?? null,
    source,
    needsAnswer,
    note,
  });

  const answer = input.answers.get(spec.key);
  if (answer !== undefined) {
    const chosen =
      spec.options.find((option) => option.value === answer) ?? spec.accepts?.(answer) ?? null;
    if (chosen !== null) return field(chosen, 'you', false, null);
  }
  if (spec.base !== null)
    return field(spec.base.option, spec.base.source, false, spec.note ?? null);
  if (spec.waitsFor !== undefined && spec.waitsFor !== null) {
    return field(null, null, false, spec.note ?? null);
  }

  const pick = input.picks.get(spec.key);
  const picked =
    pick?.value === undefined || pick.value === null
      ? null
      : (spec.options.find((option) => option.value === pick.value) ?? null);
  if (picked !== null && pick !== undefined && pick.confidence >= AI_PICK_CONFIDENCE) {
    return field(picked, 'ai', false, null);
  }
  if (picked !== null) {
    // The AI's best guess leads the list the seller chooses from.
    return {
      ...field(null, null, true, spec.note ?? null),
      options: shortList(picked, spec.options),
    };
  }
  // Asked once: a pick the AI could not make (or a failed call) is not asked again.
  if (spec.askAi && spec.options.length >= 2 && pick === undefined) {
    decisions.push({
      key: spec.key,
      question: spec.question,
      options: spec.options.slice(0, AI_CANDIDATES),
    });
  }
  return field(null, null, true, spec.note ?? null);
}

/** `first` and then the others, without repeats, at most `SHORT_LIST` long. */
function shortList(
  first: PrefillOption | null,
  options: readonly PrefillOption[],
): PrefillOption[] {
  const all = first === null ? [...options] : [first, ...options];
  const seen = new Set<string>();
  return all
    .filter((option) => {
      if (seen.has(option.value)) return false;
      seen.add(option.value);
      return true;
    })
    .slice(0, SHORT_LIST);
}

/** An info field (condition, brand, colours): the form's value, nothing to choose. */
export function infoField(
  field: PrefillFieldKey,
  label: string,
  value: string | null,
  note: string | null = null,
): PrefillField {
  return {
    key: field,
    label,
    value: value === null ? null : { value, label: value },
    options: [],
    choices: null,
    source: value === null ? null : 'listora',
    needsAnswer: false,
    note,
  };
}
