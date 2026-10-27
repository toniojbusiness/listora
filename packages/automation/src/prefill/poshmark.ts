/**
 * Poshmark's listing form, pre-filled: the department, category, and subcategory from Poshmark's
 * own catalog (poshmark/data/catalog.json), the size from one of the category's size sets
 * (Standard, Plus, Big & Tall, Girls, Boys, ...), and the condition, brand, and colours, through
 * the mapping tables the Poshmark payload uses.
 */
import {
  mappedPoshmarkCatalogs,
  mapPoshmarkCatalog,
  parseCatalogRef,
  sizeSetsFor,
  subcategoriesOf,
  poshmarkCatalog,
  type PoshmarkCatalog,
  type SizeSets,
} from '../poshmark/catalog.ts';
import { poshmarkColors } from '../poshmark/colors.ts';
import { poshmarkCondition } from '../poshmark/conditions.ts';
import { poshmarkSize, type PoshmarkSize } from '../poshmark/sizes.ts';
import { chooseField, infoField, type FieldSpec } from './choose.ts';
import { namedChild } from './rank.ts';
import { categoryOptions, isGeneric, sizeSpec, type MarketplaceContext } from './shared.ts';
import type { MarketplacePrefill, PrefillField, PrefillOption } from './types.ts';

const NAME = 'Poshmark';

/** Poshmark's departments a seller's item can go in, by Listora's department. */
const DEPARTMENTS: Readonly<Record<string, readonly string[]>> = {
  women: ['Women', 'Home', 'Pets', 'Electronics'],
  men: ['Men', 'Home', 'Pets', 'Electronics'],
  unisex: ['Men', 'Women', 'Home', 'Pets', 'Electronics'],
  kids: ['Kids', 'Home', 'Pets', 'Electronics'],
};

/** The size sets Listora never picks by itself (nothing on an item says it is one). */
const UNTOLD_SETS = new Set(['Juniors', 'Maternity']);

function path(catalog: PoshmarkCatalog): string[] {
  return [
    catalog.department,
    catalog.category,
    ...(catalog.subcategory === null ? [] : [catalog.subcategory]),
  ];
}

function option(catalog: PoshmarkCatalog): PrefillOption {
  const names = path(catalog);
  return { value: names.join('/'), label: names.join(' > '), path: names };
}

export function poshmarkPrefill(context: MarketplaceContext): MarketplacePrefill {
  const { input, words, decisions, kidsGender } = context;
  const { item } = input;
  const key = (field: string) => `poshmark.${field}`;

  const allowed = DEPARTMENTS[item.department ?? ''] ?? null;
  const pool = mappedPoshmarkCatalogs().filter(
    (entry) => allowed === null || allowed.includes(entry.department),
  );
  const mapped = refine(mapPoshmarkCatalog(item.category, item.department), words);
  // Nothing to go on but the item's words (`other`), or a kind Poshmark has no place for in the
  // item's department (a men's dress): the AI chooses from the candidates, else the seller.
  const vague = isGeneric(item.category);
  const generic = vague || mapped === null;
  const unisex = item.department === 'unisex' && !generic;
  const elsewhere = (['women', 'men'] as const).flatMap((department) => {
    if (department === item.department) return [];
    const found = refine(mapPoshmarkCatalog(item.category, department), words);
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
      // Every category (refined by the item's words) of the departments it can go in.
      vague
        ? pool.flatMap((entry) =>
            entry.subcategory === null ? [refine(entry, words) ?? entry] : [],
          )
        : [],
    ),
    base: generic ? null : { option: option(mapped), source: unisex ? 'default' : 'listora' },
    note: unisex ? 'Poshmark puts unisex items under Men, whose sizes fit them.' : null,
    accepts: (value) => {
      const found = parseCatalogRef(value);
      return found === null ? null : option(found);
    },
    askAi: true,
  };
  const categoryField = chooseField(categorySpec, input, decisions);
  const catalog = categoryField.value === null ? null : parseCatalogRef(categoryField.value.value);

  const fields: PrefillField[] = [categoryField];
  let sizeValue: string | null = null;
  let plainSize: string | null = null;
  let sized = false;
  const sets = catalog === null ? null : sizeSetsFor(catalog.department, catalog.category);
  if (catalog !== null && sets !== null) {
    const usable = sets.filter((set) => !UNTOLD_SETS.has(set.name));
    const oneSize = usable.length > 0 && usable.every((set) => set.sizes.length === 1);
    sized = usable.some((set) => set.sizes.length > 0);
    const { options: formOptions, of } = sizeOptions(usable, catalog);
    const read = (label: string | null) =>
      poshmarkSize(label, item.sizeSystem, sets, catalog.department);
    const plain = read(item.sizeLabel);
    plainSize = plain === null ? null : of(plain);
    // A kids' size Girls and Boys both have is the one the girls-or-boys answer names.
    const ambiguousKids =
      plain === null &&
      catalog.department === 'Kids' &&
      read(`Girls ${item.sizeLabel ?? ''}`) !== null &&
      read(`Boys ${item.sizeLabel ?? ''}`) !== null;
    const gendered =
      ambiguousKids && kidsGender !== null
        ? read(`${kidsGender === 'girls' ? 'Girls' : 'Boys'} ${item.sizeLabel ?? ''}`)
        : null;
    const resolved = plain ?? gendered;
    const spec = sizeSpec(
      key('size'),
      `${NAME} size`,
      item.sizeLabel,
      formOptions,
      resolved === null ? null : of(resolved),
    );
    const waits = ambiguousKids && kidsGender === null;
    const sizeField = chooseField(
      {
        ...spec,
        note: waits
          ? 'Answer girls or boys above, and the size follows.'
          : oneSize
            ? 'Poshmark picks the one size with the category.'
            : (spec.note ?? null),
        waitsFor: waits ? 'kids_gender' : null,
      },
      input,
      decisions,
    );
    sizeValue = sizeField.value?.value ?? null;
    if (sized) fields.push(sizeField);
  }

  const condition = item.condition === null ? null : poshmarkCondition(item.condition);
  fields.push(
    infoField(
      'condition',
      'Condition',
      condition?.label ?? null,
      condition === null ? "Set the item's condition above." : null,
    ),
  );
  const brand = item.brand?.trim() ?? '';
  fields.push(infoField('brand', 'Brand', brand === '' ? null : brand));
  const colors = poshmarkColors(item.colors);
  if (colors.length > 0) fields.push(infoField('colors', 'Colours', colors.join(', ')));

  const plainCatalog = mapPoshmarkCatalog(item.category, item.department);
  const categoryRef = catalog === null ? null : option(catalog).value;
  return {
    marketplace: 'poshmark',
    fields,
    ready: catalog !== null && (!sized || sizeValue !== null) && condition !== null,
    listing: {
      categoryRef:
        categoryRef === (plainCatalog === null ? null : option(plainCatalog).value)
          ? null
          : categoryRef,
      size: sizeValue === plainSize ? null : sizeValue,
    },
  };
}

/**
 * A mapped category without a subcategory, refined into the subcategory the item's own name
 * says (`Men > Shirts` into `Tees - Short Sleeve` only when the title says so).
 */
function refine(
  catalog: PoshmarkCatalog | null,
  words: MarketplaceContext['words'],
): PoshmarkCatalog | null {
  if (catalog?.subcategory !== null) return catalog;
  const children = (subcategoriesOf(catalog.department, catalog.category) ?? []).flatMap(
    (subcategory) => {
      const found = poshmarkCatalog(catalog.department, catalog.category, subcategory);
      return found === null ? [] : [{ ...found, value: subcategory, path: path(found) }];
    },
  );
  return namedChild(children, words) ?? catalog;
}

/**
 * Every size of the category's sets as an option whose value the Poshmark payload reads back as
 * exactly that size (a `Size` aspect: `M`, `14W`, `Girls 8`), labelled with its set when the
 * category has several (`8 (Girls)`), and the option of a size Poshmark's reader found. A size no
 * spelling reads back to is left out, so an answer can never name a size the form would not get.
 */
function sizeOptions(
  sets: SizeSets,
  catalog: PoshmarkCatalog,
): { options: PrefillOption[]; of: (size: PoshmarkSize) => string | null } {
  // A one-size category's sets (Baby, Girls, Boys) all hold the one size: no set to tell apart.
  const oneSize = sets.every((set) => set.sizes.length <= 1);
  const several = !oneSize && sets.filter((set) => set.sizes.length > 0).length > 1;
  const byId = new Map<string, PrefillOption>();
  const options = sets.flatMap((set) =>
    set.sizes.flatMap(([id, label]) => {
      const spellings = [label, `${set.name} ${label}`, id];
      const value = spellings.find((spelling) => {
        const read = poshmarkSize(spelling, null, sets, catalog.department);
        return read !== null && read.set === set.name && read.size === id;
      });
      if (value === undefined) return [];
      const entry = { value, label: several ? `${label} (${set.name})` : label };
      byId.set(`${set.name}\n${id}`, entry);
      return [entry];
    }),
  );
  return { options, of: (size) => byId.get(`${size.set}\n${size.size}`)?.value ?? null };
}
