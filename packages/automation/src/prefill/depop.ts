/**
 * Depop's sell form, pre-filled: its product type (department, category, and type), the size
 * from that type's own list, the condition, brand, colours, and material, from Depop's taxonomy
 * (depop/taxonomy/taxonomy.json) and the mapping tables the Depop payload uses, so what the
 * review shows is what the form gets.
 */
import { depopDetails } from '../depop/attributes.ts';
import {
  allDepopCategories,
  mapDepopCategory,
  parseCategoryRef,
  type DepopCategory,
} from '../depop/categories.ts';
import { depopFormCondition } from '../depop/conditions.ts';
import { depopSize } from '../depop/sizes.ts';
import { chooseField, infoField, type FieldSpec } from './choose.ts';
import {
  categoryOptions,
  isGeneric,
  labelOptions,
  sizeSpec,
  snapshot,
  type MarketplaceContext,
} from './shared.ts';
import type { MarketplacePrefill, PrefillField, PrefillOption } from './types.ts';

const NAME = 'Depop';

/** Depop's departments a seller's item can go in, by Listora's department. */
const DEPARTMENTS: Readonly<Record<string, readonly string[]>> = {
  women: ['Women', 'Everything else'],
  men: ['Men', 'Everything else'],
  unisex: ['Men', 'Women', 'Everything else'],
  kids: ['Kids', 'Everything else'],
};

export function depopPrefill(context: MarketplaceContext): MarketplacePrefill {
  const { input, words, decisions } = context;
  const { item } = input;
  const key = (field: string) => `depop.${field}`;
  const option = (category: DepopCategory): PrefillOption => ({
    value: category.path.join(' > '),
    label: category.path.join(' > '),
    path: [...category.path],
  });

  const all = allDepopCategories();
  const allowed = DEPARTMENTS[item.department ?? ''] ?? null;
  const pool = all.filter((entry) => allowed === null || allowed.includes(entry.path[0]));
  const mapped = mapDepopCategory(item.category, item.department);
  // Nothing to go on but the item's words (`other`), or a kind Depop has no place for in the
  // item's department (a men's dress): the AI chooses from the candidates, else the seller.
  const vague = isGeneric(item.category);
  const generic = vague || mapped === null;
  const unisex = item.department === 'unisex' && mapped !== null && !generic;
  const elsewhere = (['women', 'men'] as const).flatMap((department) => {
    if (department === item.department) return [];
    const found = mapDepopCategory(item.category, department);
    return found === null ? [] : [found];
  });
  const categorySpec: FieldSpec = {
    key: key('category'),
    field: 'category',
    label: 'Category',
    question: `${NAME} category`,
    options: categoryOptions(
      vague ? [] : generic ? elsewhere : [mapped, ...(unisex ? elsewhere.slice(0, 1) : [])],
      generic ? pool : [],
      words,
      option,
      vague ? pool.filter((entry) => entry.path[0] === 'Everything else') : [],
    ),
    base: generic ? null : { option: option(mapped), source: unisex ? 'default' : 'listora' },
    note: unisex ? 'Depop has no unisex department, so unisex items go under Men.' : null,
    accepts: (value) => {
      const found = parseCategoryRef(value, item.department);
      return found === null ? null : option(found);
    },
    askAi: true,
  };
  const categoryField = chooseField(categorySpec, input, decisions);
  const category =
    categoryField.value === null ? null : parseCategoryRef(categoryField.value.value, null);

  const fields: PrefillField[] = [categoryField];
  let sizeValue: string | null = null;
  let plainSize: string | null = null;
  if (category !== null && category.sizes.length > 0) {
    const own = snapshot(item);
    plainSize = depopSize(own, category.sizes);
    const sizeField = chooseField(
      sizeSpec(
        key('size'),
        `${NAME} size`,
        item.sizeLabel,
        labelOptions(category.sizes),
        plainSize,
      ),
      input,
      decisions,
    );
    sizeValue = sizeField.value?.value ?? null;
    fields.push(sizeField);
  }

  const condition = depopFormCondition(item.condition);
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
      brand === '' ? null : brand,
      brand === '' ? 'No brand: Depop keeps the one it suggests from the photos, if any.' : null,
    ),
  );
  const details = depopDetails(snapshot(item), category?.attributes ?? []);
  const colours = details.find((pick) => pick.field === 'colour')?.values ?? [];
  if (colours.length > 0) fields.push(infoField('colors', 'Colours', colours.join(', ')));
  const materials = details.find((pick) => pick.field === 'attributes.material')?.values ?? [];
  if (materials.length > 0) fields.push(infoField('material', 'Material', materials.join(', ')));

  const plainCategory = mapped === null ? null : mapped.path.join(' > ');
  const categoryRef = category === null ? null : category.path.join(' > ');
  return {
    marketplace: 'depop',
    fields,
    ready:
      category !== null &&
      (category.sizes.length === 0 || sizeValue !== null) &&
      condition !== null,
    listing: {
      categoryRef: categoryRef === plainCategory ? null : categoryRef,
      size: sizeValue === plainSize ? null : sizeValue,
    },
  };
}
