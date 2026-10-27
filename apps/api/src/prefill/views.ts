/** The pre-fill as the contract's `ItemMarketplacePrefill`. */
import type {
  ItemMarketplacePrefill,
  PrefillField as PrefillFieldView,
  PrefillOption as PrefillOptionView,
} from '@listora/api-contract';
import type {
  ItemPrefill,
  PrefillField,
  PrefillMarketplace,
  PrefillOption,
} from '@listora/automation';

/** The marketplaces that file kids' items as girls' or boys'. */
const BY_GENDER: readonly PrefillMarketplace[] = ['mercari', 'poshmark'];

export function prefillView(
  prefill: ItemPrefill,
  connected: ReadonlySet<PrefillMarketplace>,
): ItemMarketplacePrefill {
  const asked = (fields: readonly PrefillField[]) =>
    fields.filter((field) => field.needsAnswer).length;
  const itemQuestions = BY_GENDER.some((marketplace) => connected.has(marketplace))
    ? asked(prefill.item)
    : 0;
  return {
    itemFields: prefill.item.map(fieldView),
    marketplaces: prefill.marketplaces.map((entry) => ({
      marketplace: entry.marketplace,
      connected: connected.has(entry.marketplace),
      ready: entry.ready,
      fields: entry.fields.map(fieldView),
    })),
    questions:
      itemQuestions +
      prefill.marketplaces
        .filter((entry) => connected.has(entry.marketplace))
        .reduce((sum, entry) => sum + asked(entry.fields), 0),
  };
}

function fieldView(field: PrefillField): PrefillFieldView {
  return {
    key: field.key,
    label: field.label,
    ...(field.value === null ? {} : { value: optionView(field.value) }),
    options: field.options.map(optionView),
    ...(field.choices === null ? {} : { choices: field.choices.map(optionView) }),
    ...(field.source === null ? {} : { source: field.source }),
    needsAnswer: field.needsAnswer,
    ...(field.note === null ? {} : { note: field.note }),
  };
}

function optionView(option: PrefillOption): PrefillOptionView {
  return {
    value: option.value,
    label: option.label,
    ...(option.path === undefined ? {} : { path: [...option.path] }),
  };
}
