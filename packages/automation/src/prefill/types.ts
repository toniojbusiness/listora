/**
 * The types of the marketplace pre-fill (docs/features/marketplace-prefill.md): what each
 * marketplace's real sell form will get for an item, worked out on the review screen, so a
 * listing needs no marketplace picking in the normal case.
 */
import type { ItemCondition } from '@listora/marketplaces';

import type { ItemText } from './rank.ts';

/** The marketplaces whose own category trees and forms Listora fills (eBay has its taxonomy). */
export const PREFILL_MARKETPLACES = ['depop', 'poshmark', 'mercari'] as const;
export type PrefillMarketplace = (typeof PREFILL_MARKETPLACES)[number];

export function isPrefillMarketplace(value: string): value is PrefillMarketplace {
  return (PREFILL_MARKETPLACES as readonly string[]).includes(value);
}

/**
 * Where a field's value comes from: `listora` (Listora's own mapping tables, checked against the
 * marketplace's data), `default` (the marketplace's convention for an in-between item, such as
 * Men for a unisex tee on Depop), `ai` (the AI picked it from the short list, sure enough), or
 * `you` (the seller tapped it).
 */
export type PrefillSource = 'listora' | 'default' | 'ai' | 'you';

/** The fields a marketplace's form asks for that the pre-fill fills. */
export type PrefillFieldKey =
  'kids_gender' | 'category' | 'size' | 'condition' | 'brand' | 'colors' | 'material';

/** One choice: what an answer sends, and what the seller reads. */
export interface PrefillOption {
  /** A category's `variant.categoryRef`, a size's label, `girls` or `boys`. */
  readonly value: string;
  /** What tells it apart from the others on the list (`Men`, `Women`). */
  readonly label: string;
  /** A category's names, top level first. */
  readonly path?: readonly string[];
}

export interface PrefillField {
  readonly key: PrefillFieldKey;
  /** The field as the form names it: "Category", "Size", "Girls or boys". */
  readonly label: string;
  /** The pre-selected value; `null` while the seller has to choose (or fix the item). */
  readonly value: PrefillOption | null;
  /** The ranked short list, the value first; empty when there is nothing to choose between. */
  readonly options: readonly PrefillOption[];
  /** Every value the form offers, when the list is short enough to show whole (sizes). */
  readonly choices: readonly PrefillOption[] | null;
  readonly source: PrefillSource | null;
  /** Whether this is a question: the seller taps one of `options` before listing. */
  readonly needsAnswer: boolean;
  /** Why the value is what it is, when that is not obvious ("Depop lists unisex under Men"). */
  readonly note: string | null;
}

/** What a listing on the marketplace names so its form gets the pre-filled values. */
export interface PrefillListing {
  /** The `variant.categoryRef`, or `null` when the payload's own mapping already gives it. */
  readonly categoryRef: string | null;
  /** The `Size` aspect, or `null` when the payload's own reading of the tag already gives it. */
  readonly size: string | null;
}

export interface MarketplacePrefill {
  readonly marketplace: PrefillMarketplace;
  readonly fields: readonly PrefillField[];
  /** Whether every field the form requires has a value, so a listing can go as it is. */
  readonly ready: boolean;
  readonly listing: PrefillListing;
}

/** A question the AI is asked to answer from the short list before the seller sees it. */
export interface PrefillDecision {
  /** The answer key (`kids_gender`, `mercari.category`). */
  readonly key: string;
  /** What is being chosen, for the model: "Mercari category". */
  readonly question: string;
  readonly options: readonly PrefillOption[];
}

/** The AI's pick for a decision; `value` is `null` when it could not tell (or the call failed). */
export interface PrefillPick {
  readonly value: string | null;
  readonly confidence: number;
}

/** The item details the pre-fill reads. */
export interface PrefillItem extends ItemText {
  readonly department: string | null;
  readonly sizeLabel: string | null;
  readonly sizeSystem: string | null;
  readonly brand: string | null;
  readonly condition: ItemCondition | null;
  readonly colors: readonly string[];
  readonly materials: readonly string[];
}

export interface PrefillInput {
  readonly item: PrefillItem;
  /** The seller's answers by key (`depop.category`, `kids_gender`). */
  readonly answers: ReadonlyMap<string, string>;
  /** The AI's picks by decision key. */
  readonly picks: ReadonlyMap<string, PrefillPick>;
}

export interface ItemPrefill {
  /** Questions about the item that every marketplace's answer follows (girls or boys). */
  readonly item: readonly PrefillField[];
  readonly marketplaces: readonly MarketplacePrefill[];
  /** The open questions the AI has not been asked yet. */
  readonly decisions: readonly PrefillDecision[];
}

/** The key an answer and a decision go by: `kids_gender`, or `<marketplace>.<field>`. */
export function prefillKey(marketplace: PrefillMarketplace | null, field: PrefillFieldKey): string {
  return marketplace === null ? field : `${marketplace}.${field}`;
}
