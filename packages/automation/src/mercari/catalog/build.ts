/**
 * Mercari's catalog as Listora keeps it (`catalog.json`, docs/features/mercari.md, "The
 * catalog"): the category tree and, for each category, what its sell form asks for. It is built
 * from what Mercari's own sell page reads: its master data (the `masterQuery` the page's scripts
 * run: categories, size groups and sizes, conditions) and the page's sell check (`sellQuery`),
 * which says whether a category's form asks for a phone's IMEI. `refresh.ts` reads both on the
 * seller's signed-in session; this module turns them into the stored file, purely.
 */

/** The catalog file's shape; bump `version` with any change to it. */
export const MERCARI_CATALOG_VERSION = 1;

export interface MercariCatalogFile {
  version: typeof MERCARI_CATALOG_VERSION;
  /** The day it was read (`YYYY-MM-DD`). */
  readAt: string;
  source: string;
  /** Mercari's conditions, best first, as the sell form's radios name them. */
  conditions: { id: number; name: string }[];
  /** The size lists a category's form offers, by `sizeGroupId`. */
  sizeGroups: MercariSizeGroupRecord[];
  /** Categories whose sell form asked for the phone's IMEI when it was read. */
  imeiCategoryIds: number[];
  /** The departments in the order the category dialog shows them, each with its categories. */
  categories: MercariCategoryRecord[];
}

export interface MercariCategoryRecord {
  id: number;
  name: string;
  /** The size list the form shows for this category; absent when it asks no size. */
  sizeGroupId?: number;
  /** The subcategories, in the dialog's order; absent on a leaf. */
  children?: MercariCategoryRecord[];
}

export interface MercariSizeGroupRecord {
  id: number;
  title: string;
  /** Mercari's own name for whom the group is for (`Women`, `Men`, `Kids`, `Adult Pants`). */
  department: string;
  /** The form's size list in order, a part per subgroup (`Standard`, `Petite`, ...). */
  subgroups: { id: number; title: string; sizes: { id: number; label: string }[] }[];
}

/** Mercari's master data, as its `masterQuery` answers. */
export interface MercariMasterData {
  itemCategories: {
    id: number;
    name: string;
    parentId: number;
    itemSizeGroupId: number;
    displayOrder: number;
  }[];
  itemSizeGroups: {
    id: number;
    title: string;
    category: string;
    sizeIds: number[];
    subGroupIds: number[];
  }[];
  itemSizeSubGroups: { id: number; title: string; sizeIds: number[] }[];
  itemSizes: { id: number; title: string; subtitle: string | null }[];
  itemConditions: { id: number; name: string }[];
}

/**
 * The catalog file from Mercari's master data and the categories whose form asks for an IMEI.
 * The dialog lists departments by id and every other level by Mercari's display order (read
 * 2026-10-27), so the tree keeps those orders: a name two siblings share is picked as the first.
 */
export function buildMercariCatalog(
  master: MercariMasterData,
  imeiCategoryIds: readonly number[],
  readAt: string,
): MercariCatalogFile {
  const children = new Map<number, MercariMasterData['itemCategories']>();
  for (const category of master.itemCategories) {
    const siblings = children.get(category.parentId) ?? [];
    siblings.push(category);
    children.set(category.parentId, siblings);
  }
  const node = (category: MercariMasterData['itemCategories'][number]): MercariCategoryRecord => {
    const below = [...(children.get(category.id) ?? [])].sort(
      (a, b) => a.displayOrder - b.displayOrder || a.id - b.id,
    );
    return {
      id: category.id,
      name: category.name,
      ...(category.itemSizeGroupId === 0 ? {} : { sizeGroupId: category.itemSizeGroupId }),
      ...(below.length === 0 ? {} : { children: below.map(node) }),
    };
  };
  const sizes = new Map(master.itemSizes.map((size) => [size.id, size]));
  const subgroups = new Map(master.itemSizeSubGroups.map((group) => [group.id, group]));
  const label = (id: number): string => {
    const size = sizes.get(id);
    if (size === undefined) throw new Error(`Mercari's master data has no size ${String(id)}`);
    const subtitle = size.subtitle?.trim() ?? '';
    return subtitle === '' ? size.title.trim() : `${size.title.trim()} ${subtitle}`;
  };
  return {
    version: MERCARI_CATALOG_VERSION,
    readAt,
    source:
      "Mercari's sell page on the seller's own session: its master data (masterQuery) and its sell check (sellQuery) for the IMEI",
    conditions: master.itemConditions.map(({ id, name }) => ({ id, name })),
    sizeGroups: [...master.itemSizeGroups]
      .sort((a, b) => a.id - b.id)
      .map((group) => ({
        id: group.id,
        title: group.title,
        department: group.category,
        subgroups: group.subGroupIds.map((id) => {
          const subgroup = subgroups.get(id);
          if (subgroup === undefined) {
            throw new Error(`Mercari's master data has no size subgroup ${String(id)}`);
          }
          return {
            id,
            title: subgroup.title.trim(),
            sizes: subgroup.sizeIds.map((size) => ({ id: size, label: label(size) })),
          };
        }),
      })),
    imeiCategoryIds: [...new Set(imeiCategoryIds)].sort((a, b) => a - b),
    categories: [...(children.get(0) ?? [])].sort((a, b) => a.id - b.id).map(node),
  };
}

/**
 * The file's text: two-space JSON in which every record of plain values (a leaf category, a
 * size, a condition) is one line, and a record that ends in a list of records (a category with
 * subcategories) opens that list on its own line. A refresh's diff then shows each category or
 * size Mercari added, renamed, or removed as one line.
 */
export function formatMercariCatalog(catalog: MercariCatalogFile): string {
  return `${compactJson(catalog, 0)}\n`;
}

function compactJson(value: unknown, depth: number): string {
  const pad = '  '.repeat(depth);
  const inner = '  '.repeat(depth + 1);
  if (Array.isArray(value)) {
    if (value.every((entry) => !isRecord(entry) && !Array.isArray(entry))) {
      return JSON.stringify(value).replaceAll(',', ', ');
    }
    const lines = value.map((entry) => `${inner}${compactJson(entry, depth + 1)}`);
    return `[\n${lines.join(',\n')}\n${pad}]`;
  }
  if (!isRecord(value)) return JSON.stringify(value);
  const entries = Object.entries(value);
  const plain = ([, entry]: [string, unknown]): boolean =>
    !isRecord(entry) && (!Array.isArray(entry) || entry.every((item) => !isRecord(item)));
  const field = ([key, entry]: [string, unknown]): string =>
    `${JSON.stringify(key)}: ${compactJson(entry, depth)}`;
  if (entries.every(plain)) return `{${entries.map(field).join(', ')}}`;
  const last = entries.at(-1);
  if (last !== undefined && Array.isArray(last[1]) && entries.slice(0, -1).every(plain)) {
    const items = last[1].map((entry) => `${inner}${compactJson(entry, depth + 1)}`);
    const own = entries.slice(0, -1).map(field);
    return `{${[...own, `${JSON.stringify(last[0])}: [`].join(', ')}\n${items.join(',\n')}\n${pad}]}`;
  }
  const lines = entries.map(([key, entry]) => `${inner}${JSON.stringify(key)}: ${compactJson(entry, depth + 1)}`);
  return `{\n${lines.join(',\n')}\n${pad}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
