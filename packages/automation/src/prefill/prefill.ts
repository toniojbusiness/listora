/**
 * The marketplace pre-fill (docs/features/marketplace-prefill.md): for an item, what Depop's,
 * Poshmark's, and Mercari's real sell forms will get, field by field, from the item analysis and
 * each marketplace's own category tree and form data, so a listing needs no marketplace picking
 * in the normal case. It is pure and free: the AI's picks and the seller's answers come in, and
 * the questions the AI has not been asked yet go out as `decisions`, which the caller asks in one
 * cheap call and passes back in.
 */
import { matchMercariCategory } from '../mercari/categories.ts';
import { mapPoshmarkCatalog, sizeSetsFor } from '../poshmark/catalog.ts';
import { poshmarkSize } from '../poshmark/sizes.ts';
import { chooseField } from './choose.ts';
import { depopPrefill } from './depop.ts';
import { mercariPrefill } from './mercari.ts';
import { poshmarkPrefill } from './poshmark.ts';
import { distinguishingLabels, itemWords, words as wordsOf } from './rank.ts';
import type { KidsGender, MarketplaceContext } from './shared.ts';
import {
  PREFILL_MARKETPLACES,
  type ItemPrefill,
  type MarketplacePrefill,
  type PrefillDecision,
  type PrefillField,
  type PrefillInput,
  type PrefillMarketplace,
} from './types.ts';

const BUILDERS: Readonly<
  Record<PrefillMarketplace, (context: MarketplaceContext) => MarketplacePrefill>
> = {
  depop: depopPrefill,
  poshmark: poshmarkPrefill,
  mercari: mercariPrefill,
};

/** The pre-fill of every marketplace with its own category tree, for the item. */
export function prefillItem(input: PrefillInput): ItemPrefill {
  const decisions: PrefillDecision[] = [];
  const words = itemWords(input.item);
  const gender = kidsGenderField(input, decisions);
  const kidsGender = (gender?.value?.value ?? null) as KidsGender | null;
  const context: MarketplaceContext = { input, words, kidsGender, decisions };
  return {
    item: gender === null ? [] : [gender],
    marketplaces: PREFILL_MARKETPLACES.map((marketplace) =>
      relabel(BUILDERS[marketplace](context)),
    ),
    decisions,
  };
}

/**
 * Girls or boys, for a kids' item where a marketplace files them apart (Mercari's Kids tree,
 * Poshmark's Girls and Boys size sets) and the kind doesn't say (a dress is a girls' item): from
 * the item's own words, else the AI, else one tap. `null` when no marketplace needs it.
 */
function kidsGenderField(input: PrefillInput, decisions: PrefillDecision[]): PrefillField | null {
  const { item } = input;
  if (item.department !== 'kids') return null;
  const mercari = matchMercariCategory(item.category, 'kids', item.sizeLabel);
  const kind =
    mercari.type === 'mapped'
      ? mercari.category.path.some((name) => name.startsWith('Girls'))
        ? 'girls'
        : mercari.category.path.some((name) => name.startsWith('Boys'))
          ? 'boys'
          : null
      : null;
  if (mercari.type !== 'choose' && !poshmarkNeedsGender(input)) return null;
  const said = new Set([
    ...wordsOf(item.title),
    ...wordsOf(item.productName),
    ...item.keywords.flatMap((keyword) => wordsOf(keyword)),
    ...wordsOf(item.sizeLabel),
    ...wordsOf(item.description),
  ]);
  const girls = said.has('girl');
  const boys = said.has('boy');
  const told: KidsGender | null = kind ?? (girls !== boys ? (girls ? 'girls' : 'boys') : null);
  const girlsOption = { value: 'girls', label: 'Girls' };
  const boysOption = { value: 'boys', label: 'Boys' };
  const options = [girlsOption, boysOption];
  return chooseField(
    {
      key: 'kids_gender',
      field: 'kids_gender',
      label: 'Girls or boys',
      question: "Is this kids' item for girls or for boys?",
      options,
      base:
        told === null
          ? null
          : { option: told === 'girls' ? girlsOption : boysOption, source: 'listora' },
      note: 'Mercari and Poshmark file kids’ clothes as girls’ or boys’.',
      askAi: true,
    },
    input,
    decisions,
  );
}

/** Whether the item's Poshmark size is one both Girls and Boys have, so it needs one named. */
function poshmarkNeedsGender(input: PrefillInput): boolean {
  const { item } = input;
  const catalog = mapPoshmarkCatalog(item.category, 'kids');
  if (catalog === null || item.sizeLabel === null) return false;
  const sets = sizeSetsFor(catalog.department, catalog.category);
  if (sets === null) return false;
  const read = (label: string) => poshmarkSize(label, item.sizeSystem, sets, 'Kids');
  return (
    read(item.sizeLabel) === null &&
    read(`Girls ${item.sizeLabel}`) !== null &&
    read(`Boys ${item.sizeLabel}`) !== null
  );
}

/** Category options labelled by what tells them apart (`Men`, `Women`). */
function relabel(prefill: MarketplacePrefill): MarketplacePrefill {
  return {
    ...prefill,
    fields: prefill.fields.map((field) => {
      const paths = field.options.flatMap((option) =>
        option.path === undefined ? [] : [option.path],
      );
      if (paths.length !== field.options.length || paths.length < 2) return field;
      const labels = distinguishingLabels(paths);
      const options = field.options.map((option, index) => ({
        ...option,
        label: labels[index] ?? option.label,
      }));
      const value =
        field.value === null
          ? null
          : (options.find((option) => option.value === field.value?.value) ?? field.value);
      return { ...field, options, value };
    }),
  };
}
