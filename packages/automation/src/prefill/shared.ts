/** What every marketplace's pre-fill shares: its context, the option lists, the size field. */
import type { ItemSnapshot } from '@listora/marketplaces';

import { AI_CANDIDATES, type FieldSpec } from './choose.ts';
import { rankCandidates, rankSizes, type ItemWords } from './rank.ts';
import type { PrefillDecision, PrefillInput, PrefillOption } from './types.ts';

export interface MarketplaceContext {
  readonly input: PrefillInput;
  readonly words: ItemWords;
  /** Girls or boys, once the item-level question has an answer; `null` while it hasn't. */
  readonly kidsGender: KidsGender | null;
  /** The open questions for the AI, which each field adds to. */
  readonly decisions: PrefillDecision[];
}

export type KidsGender = 'girls' | 'boys';

/**
 * A canonical category that says nothing about what the item is (`other`, or none): Listora's
 * mapping can only file it under a marketplace's catch-all, so its words choose instead.
 */
export function isGeneric(category: string | null): boolean {
  return category === null || category === 'other' || category.startsWith('other/');
}

/** How many of the best word matches a category question lists. */
const RANKED = 20;

/**
 * A category field's candidates: the mapped ones first (Listora's category and, for an
 * in-between item, the other department's), then the marketplace's categories the item's words
 * match best, then `broad` (for an item whose category says nothing, every top-level kind of
 * the marketplace's tree it could be, so the AI can place a lamp its words don't name), then the
 * catch-alls (`Other`) of the item's departments, so the list is never empty.
 */
export function categoryOptions<C>(
  mapped: readonly C[],
  pool: readonly C[],
  words: ItemWords,
  option: (entry: C) => PrefillOption,
  broad: readonly C[] = [],
): PrefillOption[] {
  const candidates = pool.map(option).map((entry) => ({ ...entry, path: entry.path ?? [] }));
  const ranked = rankCandidates(candidates, words, RANKED);
  const catchAlls = candidates
    .filter((entry) => /^other\b/i.test(entry.path.at(-1) ?? ''))
    .slice(0, 6);
  const seen = new Set<string>();
  return [...mapped.map(option), ...ranked, ...broad.map(option), ...catchAlls]
    .filter((entry) => {
      if (seen.has(entry.value)) return false;
      seen.add(entry.value);
      return true;
    })
    .slice(0, AI_CANDIDATES);
}

/** A size list's labels as options, in the form's order. */
export function labelOptions(labels: readonly string[]): PrefillOption[] {
  return labels.map((label) => ({ value: label, label }));
}

/**
 * The size field: Listora's reading of the tag when the list has it, else a question whose
 * short list starts with the sizes closest to the tag's. `formOptions` are in the form's order.
 */
export function sizeSpec(
  key: string,
  question: string,
  tagSize: string | null,
  formOptions: readonly PrefillOption[],
  plain: string | null,
): FieldSpec {
  const tag = tagSize?.trim() ?? '';
  const byLabel = new Map(formOptions.map((option) => [option.label, option]));
  const options = rankSizes(
    tag,
    formOptions.map((option) => option.label),
  ).flatMap((label) => {
    const option = byLabel.get(label);
    return option === undefined ? [] : [option];
  });
  const base =
    plain === null ? null : (formOptions.find((option) => option.value === plain) ?? null);
  return {
    key,
    field: 'size',
    label: 'Size',
    question,
    // A tag size the list has is the size: the seller changes it on the item, not per marketplace.
    options: base === null ? options : [base],
    base: base === null ? null : { option: base, source: 'listora' },
    note:
      base !== null
        ? null
        : tag === ''
          ? 'The item has no size yet: add it above, or pick one.'
          : `"${tag}" isn't one of its sizes for this category.`,
    accepts: (value) =>
      base === null ? (formOptions.find((option) => option.value === value) ?? null) : null,
    // The AI can read a tag's size (a UK 10, a 2X) into the list; without one it has nothing.
    askAi: tag !== '',
    choices: formOptions.length <= 80 ? formOptions : null,
  };
}

/** The item as the marketplaces' own size and detail readers take it. */
export function snapshot(item: PrefillInput['item'], sizeLabel = item.sizeLabel): ItemSnapshot {
  return {
    itemId: '',
    sku: '',
    brand: item.brand,
    productName: item.productName,
    styleNumber: null,
    upc: null,
    department: item.department,
    category: item.category,
    sizeLabel,
    sizeSystem: item.sizeSystem,
    colors: [...item.colors],
    pattern: null,
    materials: [...item.materials],
    condition: item.condition,
    conditionNotes: null,
    flaws: [],
    measurements: [],
    photos: [],
  };
}
