/**
 * Mercari's catalog (`catalog.json`, refreshed by `refresh.ts`): every category its sell form
 * offers, level by level, and what each one's form asks for besides the fields every listing has
 * (docs/features/mercari.md, "The catalog"):
 *
 * - a size, from the category's size group (Women's clothing, Men's, adult pants by waist, suits,
 *   women's, men's, and kids' shoes, kids' clothing, bras), or none;
 * - the phone's IMEI, for the categories whose form asked for one when it was read.
 *
 * Server-side only: the scripts the phone runs get the category and size the payload names, so
 * this file never goes into the phone's bundle.
 */
import { readFileSync } from 'node:fs';

import type { MercariCatalogFile, MercariCategoryRecord, MercariSizeGroupRecord } from './build.ts';
import { MERCARI_CATALOG_VERSION } from './build.ts';

export interface MercariCategory {
  id: number;
  name: string;
  /** The names to pick in the category dialog, top level first: `['Men', 'Tops', 'T-shirts']`. */
  path: readonly string[];
  /** The size group the form shows; `null` when it asks no size. */
  sizeGroupId: number | null;
  /** Whether the form asks for the phone's IMEI. */
  imei: boolean;
  /** Whether it has subcategories (the dialog then picks it whole by its "All ..." row). */
  hasChildren: boolean;
}

export type MercariSizeGroup = MercariSizeGroupRecord;

export interface MercariCatalog {
  readAt: string;
  /** Every category, by id. */
  byId: ReadonlyMap<number, MercariCategory>;
  /** The departments, in the dialog's order. */
  departments: readonly MercariCategory[];
  sizeGroups: ReadonlyMap<number, MercariSizeGroup>;
  /** Every category's subcategories, in the dialog's order. */
  children(id: number): readonly MercariCategory[];
  /** The category the dialog reaches by these names (the first of two siblings sharing one). */
  find(path: readonly string[]): MercariCategory | null;
  /** The labels the form's size list offers, in its order, each once. */
  sizeLabels(sizeGroupId: number): readonly string[];
  /**
   * The size list's parts in its order (`Standard`, `Petite`, `Maternity`, `Tall`, ...), each
   * with its labels; the form heads each part with its name, and the same label can be in
   * several (`S (4-6)` in Standard and in Petite).
   */
  sizeSets(sizeGroupId: number): readonly { name: string; labels: readonly string[] }[];
}

let loaded: MercariCatalog | undefined;

/** The catalog in the repository, read once. */
export function mercariCatalog(): MercariCatalog {
  loaded ??= indexCatalog(
    JSON.parse(readFileSync(new URL('catalog.json', import.meta.url), 'utf8')) as Omit<
      MercariCatalogFile,
      'version'
    > & { version: number },
  );
  return loaded;
}

/** `version` is read as any number, so a file of another version is refused, not misread. */
export function indexCatalog(
  file: Omit<MercariCatalogFile, 'version'> & { version: number },
): MercariCatalog {
  if (file.version !== MERCARI_CATALOG_VERSION) {
    throw new Error(`catalog.json is version ${String(file.version)}; this code reads version 1`);
  }
  const imei = new Set(file.imeiCategoryIds);
  const byId = new Map<number, MercariCategory>();
  const below = new Map<number, MercariCategory[]>();
  const add = (record: MercariCategoryRecord, parent: readonly string[]): MercariCategory => {
    const category: MercariCategory = {
      id: record.id,
      name: record.name,
      path: [...parent, record.name],
      sizeGroupId: record.sizeGroupId ?? null,
      imei: imei.has(record.id),
      hasChildren: (record.children?.length ?? 0) > 0,
    };
    if (byId.has(record.id))
      throw new Error(`catalog.json has category ${String(record.id)} twice`);
    byId.set(record.id, category);
    below.set(
      record.id,
      (record.children ?? []).map((child) => add(child, category.path)),
    );
    return category;
  };
  const departments = file.categories.map((record) => add(record, []));
  const sizeGroups = new Map(file.sizeGroups.map((group) => [group.id, group]));
  return {
    readAt: file.readAt,
    byId,
    departments,
    sizeGroups,
    children: (id) => below.get(id) ?? [],
    find: (path) => {
      let level: readonly MercariCategory[] = departments;
      let found: MercariCategory | null = null;
      for (const name of path) {
        found = level.find((category) => category.name === name) ?? null;
        if (found === null) return null;
        level = below.get(found.id) ?? [];
      }
      return found;
    },
    sizeLabels: (id) => [
      ...new Set(
        (sizeGroups.get(id)?.subgroups ?? []).flatMap((subgroup) =>
          subgroup.sizes.map((size) => size.label),
        ),
      ),
    ],
    sizeSets: (id) =>
      (sizeGroups.get(id)?.subgroups ?? []).map((subgroup) => ({
        name: subgroup.title,
        labels: subgroup.sizes.map((size) => size.label),
      })),
  };
}
