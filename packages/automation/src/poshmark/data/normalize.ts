/**
 * Turns what Poshmark's listing form knows about its catalog into Listora's versioned catalog
 * data (`catalog.json`, which `refresh.ts` rewrites). The form embeds Poshmark's whole catalog in
 * its page state, `$_listing_editor.catalogMeta`: every department, its categories (some in a
 * display group, such as "Global & Traditional Wear"), each category's subcategories
 * (`category_features`), and its size sets with their sizes in every size system; and its
 * conditions in `featureSettings.featureSettingsV3.web_resell_v2_guest.conditions`. Listora keeps
 * the names the form shows, the US sizes, and the ids, and leaves out the size charts.
 *
 * A size has three spellings: its id (what Poshmark stores, `14.5`, `2TG`), the label its button
 * in the size picker shows (`Neck 14.5`, `2T`), and what the picker shows once it is chosen
 * (`Neck 14.5`, `2T (Girls)`). Identical size sets are kept once: a one-size set under its set
 * and size (`Standard: OS`), any other under the name of the first category that has it.
 */
import { z } from 'zod';

/** Bumped when the shape of `catalog.json` changes. */
export const CATALOG_DATA_SCHEMA = 1;

/** A size: its id, its button's label, and what the picker shows once it is chosen. */
export type CatalogSize = readonly [id: string, label: string, chosen: string];

export interface CatalogSizeSet {
  /** The size set's tab in the size picker: `Standard`, `Plus`, `Big & Tall`, `Girls`. */
  name: string;
  sizes: CatalogSize[];
}

export interface CatalogCategory {
  name: string;
  id: string;
  /** The display group the category picker files it under, or `null`. */
  group: string | null;
  subcategories: string[];
  /** Keys into `CatalogData.sizeSets`, in the picker's order. */
  sizeSets: string[];
}

export interface CatalogDepartment {
  name: string;
  id: string;
  categories: CatalogCategory[];
}

export interface CatalogData {
  schema: typeof CATALOG_DATA_SCHEMA;
  source: string;
  /** The day the catalog was read (`YYYY-MM-DD`). */
  readAt: string;
  /** When Poshmark last changed its catalog, as the catalog says. */
  catalogUpdatedAt: string;
  conditions: { code: string; label: string }[];
  /** The colors the form offers (a listing takes up to two). */
  colors: string[];
  sizeSets: Record<string, CatalogSizeSet>;
  departments: CatalogDepartment[];
}

const sizeSchema = z.object({ id: z.string(), display: z.string(), short: z.string() });

const sizeSetSchema = z.object({
  name: z.string(),
  size_systems: z.object({ us: z.object({ sizes: z.array(sizeSchema) }) }),
});

const categorySchema = z.object({
  id: z.string(),
  display: z.string(),
  size_sets: z.array(sizeSetSchema).default([]),
  category_features: z.array(z.object({ display: z.string() })).default([]),
});

/** A display group's own entry in a department's categories: a name, no id. */
const groupEntrySchema = z.object({ group: z.string(), display: z.string() });

/** What `refresh.ts` reads from the form's page state. */
export const formCatalogSchema = z.object({
  catalogMeta: z.object({
    updated_at: z.string(),
    colors: z.array(z.object({ name: z.string() })),
    catalog: z.object({
      departments: z.array(
        z.object({
          id: z.string(),
          display: z.string(),
          categories: z.array(z.union([categorySchema, groupEntrySchema])),
        }),
      ),
    }),
  }),
  /** `catalogDisplayGroupingData`: department id → category id → its display group. */
  grouping: z.record(z.string(), z.record(z.string(), z.object({ group: z.string() }))),
  conditions: z.array(z.object({ type: z.string(), label: z.string() })).min(1),
});
export type FormCatalog = z.infer<typeof formCatalogSchema>;

/** `catalog.json` itself, checked as it is loaded. */
export const catalogDataSchema = z.object({
  schema: z.literal(CATALOG_DATA_SCHEMA),
  source: z.string(),
  readAt: z.string(),
  catalogUpdatedAt: z.string(),
  conditions: z.array(z.object({ code: z.string(), label: z.string() })),
  colors: z.array(z.string()),
  sizeSets: z.record(
    z.string(),
    z.object({ name: z.string(), sizes: z.array(z.tuple([z.string(), z.string(), z.string()])) }),
  ),
  departments: z.array(
    z.object({
      name: z.string(),
      id: z.string(),
      categories: z.array(
        z.object({
          name: z.string(),
          id: z.string(),
          group: z.string().nullable(),
          subcategories: z.array(z.string()),
          sizeSets: z.array(z.string()),
        }),
      ),
    }),
  ),
}) satisfies z.ZodType<CatalogData>;

export const FORM_CATALOG_SOURCE =
  "Poshmark's listing form (/create-listing): $_listing_editor.catalogMeta and " +
  'catalogDisplayGroupingData, featureSettings.featureSettingsV3.web_resell_v2_guest.conditions';

export function normalizeCatalog(input: FormCatalog, readAt: string): CatalogData {
  const sizeSets: Record<string, CatalogSizeSet> = {};
  const keyOf = new Map<string, string>();
  const departments = input.catalogMeta.catalog.departments.map((department) => {
    const groups = input.grouping[department.id] ?? {};
    const categories = department.categories.flatMap((category): CatalogCategory[] => {
      if (!('id' in category)) return [];
      const keys = category.size_sets.map((set) => {
        const sizes = set.size_systems.us.sizes.map((size): CatalogSize => [
          size.id,
          size.display,
          size.short,
        ]);
        const content = JSON.stringify([set.name, sizes]);
        const known = keyOf.get(content);
        if (known !== undefined) return known;
        // A one-size set is named by its size; any other by the first category that has it.
        const [only, ...more] = sizes;
        const key =
          only !== undefined && more.length === 0
            ? `${set.name}: ${only[0]}`
            : `${department.display}/${category.display}/${set.name}`;
        keyOf.set(content, key);
        sizeSets[key] = { name: set.name, sizes };
        return key;
      });
      return [
        {
          name: category.display,
          id: category.id,
          group: groups[category.id]?.group ?? null,
          subcategories: category.category_features.map((feature) => feature.display),
          sizeSets: keys,
        },
      ];
    });
    return { name: department.display, id: department.id, categories };
  });
  return {
    schema: CATALOG_DATA_SCHEMA,
    source: FORM_CATALOG_SOURCE,
    readAt,
    catalogUpdatedAt: input.catalogMeta.updated_at,
    conditions: input.conditions.map(({ type, label }) => ({ code: type, label })),
    colors: input.catalogMeta.colors.map((color) => color.name),
    sizeSets,
    departments,
  };
}
