/**
 * Mercari's sell form, pre-filled: the category from Mercari's own catalog
 * (mercari/catalog/catalog.json), three levels deep, the size from the category's size group,
 * and the condition and brand, through the mapping tables the Mercari payload uses. Mercari's
 * form has no colour or item-specific fields.
 */
import { mercariCatalog, type MercariCategory } from '../mercari/catalog/catalog.ts';
import {
  mappedMercariCategories,
  matchMercariCategory,
  parseCategoryRef,
} from '../mercari/categories.ts';
import { mercariCondition } from '../mercari/conditions.ts';
import { mercariSize } from '../mercari/sizes.ts';
import { chooseField, infoField, type FieldSpec } from './choose.ts';
import { namedChild } from './rank.ts';
import {
  categoryOptions,
  isGeneric,
  labelOptions,
  sizeSpec,
  snapshot,
  type MarketplaceContext,
} from './shared.ts';
import type { MarketplacePrefill, PrefillField, PrefillOption } from './types.ts';

const NAME = 'Mercari';

/** Mercari's departments for everyone: the rest are Women, Men, and Kids. */
const SHARED_DEPARTMENTS = new Set(
  mercariCatalog()
    .departments.map((department) => department.name)
    .filter((name) => !['Women', 'Men', 'Kids'].includes(name)),
);

const OWN_DEPARTMENTS: Readonly<Record<string, readonly string[]>> = {
  women: ['Women'],
  men: ['Men'],
  unisex: ['Men', 'Women'],
  kids: ['Kids'],
};

/** What Mercari's form takes when the item's brand isn't on its list, or there is none. */
export const MERCARI_NO_BRAND = 'No brand / Not sure';

function option(category: MercariCategory): PrefillOption {
  return {
    value: category.path.join(' > '),
    label: category.path.join(' > '),
    path: [...category.path],
  };
}

export function mercariPrefill(context: MarketplaceContext): MarketplacePrefill {
  const { input, words, decisions, kidsGender } = context;
  const { item } = input;
  const key = (field: string) => `mercari.${field}`;
  const catalog = mercariCatalog();

  const own = OWN_DEPARTMENTS[item.department ?? ''] ?? null;
  // A phone category's form asks for an IMEI Listora doesn't have, so none is ever offered.
  const pool = mappedMercariCategories().filter(
    (entry) =>
      !entry.imei &&
      (own === null ||
        own.includes(entry.path[0] ?? '') ||
        SHARED_DEPARTMENTS.has(entry.path[0] ?? '')),
  );
  const match = matchMercariCategory(item.category, item.department, item.sizeLabel);
  const generic = isGeneric(item.category) || match.type === 'unmapped';
  const unisex = item.department === 'unisex' && match.type === 'mapped' && !generic;
  const refineIn = (category: MercariCategory): MercariCategory => {
    if (!category.hasChildren) return category;
    const children = catalog
      .children(category.id)
      .filter((child) => !child.imei)
      .map((child) => ({
        ...child,
        value: child.path.join(' > '),
      }));
    return namedChild(children, words) ?? category;
  };

  let mapped: MercariCategory | null = null;
  let alternatives: MercariCategory[] = [];
  let waits = false;
  let kidsNote: string | null = null;
  if (match.type === 'mapped' && !generic) {
    mapped = refineIn(match.category);
    if (unisex) {
      // The other department's category, for a seller who lists it the other way.
      const other = (['men', 'women'] as const).flatMap((department) => {
        const found = matchMercariCategory(item.category, department, item.sizeLabel);
        return found.type === 'mapped' ? [refineIn(found.category)] : [];
      });
      alternatives = other.filter((entry) => entry.id !== mapped?.id);
    }
  } else if (match.type === 'choose') {
    alternatives = [...match.options];
    const chosen =
      kidsGender === null
        ? null
        : (match.options.find((entry) =>
            entry.path.some((name) => name.startsWith(kidsGender === 'girls' ? 'Girls' : 'Boys')),
          ) ?? null);
    if (chosen === null) {
      waits = true;
      kidsNote = 'Mercari files kids’ items as girls’ or boys’: answer it above.';
    } else {
      mapped = chosen;
    }
  }

  const categorySpec: FieldSpec = {
    key: key('category'),
    field: 'category',
    label: 'Category',
    question: `${NAME} category`,
    options: categoryOptions(
      [mapped, ...alternatives].flatMap((entry) => (entry === null ? [] : [entry])),
      generic ? pool : [],
      words,
      option,
      // Every second-level category (refined by the item's words) of the departments it can go
      // in, so the AI can place what the item's words don't name.
      generic ? pool.filter((entry) => entry.path.length === 2).map(refineIn) : [],
    ),
    base:
      mapped === null ? null : { option: option(mapped), source: unisex ? 'default' : 'listora' },
    note: unisex
      ? 'Mercari has no unisex department: Listora files it under Men, except kinds Mercari keeps under Women.'
      : kidsNote,
    accepts: (value) => {
      const found = parseCategoryRef(value);
      return found === null || found.imei ? null : option(found);
    },
    askAi: generic,
    waitsFor: waits ? 'kids_gender' : null,
  };
  const categoryField = chooseField(categorySpec, input, decisions);
  const category =
    categoryField.value === null ? null : parseCategoryRef(categoryField.value.value);

  const fields: PrefillField[] = [categoryField];
  const group = category?.sizeGroupId ?? null;
  const labels = group === null ? [] : catalog.sizeLabels(group);
  let sizeValue: string | null = null;
  let plainSize: string | null = null;
  if (labels.length > 0) {
    plainSize = mercariSize(snapshot(item), catalog.sizeSets(group ?? 0))?.label ?? null;
    const sizeField = chooseField(
      sizeSpec(key('size'), `${NAME} size`, item.sizeLabel, labelOptions(labels), plainSize),
      input,
      decisions,
    );
    sizeValue = sizeField.value?.value ?? null;
    fields.push(sizeField);
  }

  const condition = item.condition === null ? null : mercariCondition(item.condition);
  fields.push(
    infoField(
      'condition',
      'Condition',
      condition?.label ?? null,
      condition === null ? "Set the item's condition above." : null,
    ),
  );
  const brand = item.brand?.trim() ?? '';
  fields.push(
    infoField(
      'brand',
      'Brand',
      brand === '' ? MERCARI_NO_BRAND : brand,
      brand === ''
        ? null
        : `If Mercari's brand list doesn't have it, the form takes "${MERCARI_NO_BRAND}".`,
    ),
  );

  const plain =
    item.category === null
      ? null
      : matchMercariCategory(item.category, item.department, item.sizeLabel);
  const plainRef = plain?.type === 'mapped' ? plain.category.path.join(' > ') : null;
  const categoryRef = category === null ? null : category.path.join(' > ');
  return {
    marketplace: 'mercari',
    fields,
    ready: category !== null && (labels.length === 0 || sizeValue !== null) && condition !== null,
    listing: {
      categoryRef: categoryRef === plainRef ? null : categoryRef,
      size: sizeValue === plainSize ? null : sizeValue,
    },
  };
}
