/**
 * Depop's whole category tree and the sell form's fields for each kind of category, as Depop's
 * own sell form loads them from its web API (`taxonomy.json`, written by `refresh.ts`; see
 * docs/features/depop-automation.md, "The taxonomy"):
 *
 * - every department (Men, Women, Kids, Everything else), its categories ("groups": Tops,
 *   Footwear, Home, Beauty, ...), and each one's product types, with the US size list the
 *   product type takes in that department (`sizeSet`, none for unsized ones) and the item
 *   specifics the form offers for it (`attributes`: material, occasion, bag type, ...);
 * - the size lists, with their labels exactly as the form offers them;
 * - the colours, styles, ages, sources, and every item specific's values;
 * - the hashtags Depop refuses (`bannedHashtags`).
 *
 * The data is read once, checked against its schema, and indexed. It stays out of the phone
 * runtime's bundle: the payload carries the names the scripts pick.
 */
import {
  taxonomySchema,
  type DepopAttributeData,
  type DepopDepartmentData,
  type DepopGroupData,
  type DepopProductTypeData,
  type DepopTaxonomy,
} from './schema.ts';
import data from './taxonomy.json' with { type: 'json' };

export type {
  DepopAttributeData,
  DepopDepartmentData,
  DepopGroupData,
  DepopProductTypeData,
  DepopTaxonomy,
};

/** Depop's department ids. */
export type DepopDepartmentId = 'menswear' | 'womenswear' | 'kidswear' | 'everything-else';

/** One product type in one department, with everything the form needs to list it. */
export interface DepopProductType {
  department: DepopDepartmentData;
  group: DepopGroupData;
  productType: DepopProductTypeData;
  /** The labels of its size list, in the form's order; empty when it takes no size. */
  sizes: readonly string[];
}

export const DEPOP_TAXONOMY: DepopTaxonomy = taxonomySchema.parse(data);

const byKey = new Map<string, DepopProductType>();
for (const department of DEPOP_TAXONOMY.departments) {
  for (const group of department.groups) {
    for (const productType of group.productTypes) {
      const sizes =
        productType.sizeSet === null
          ? []
          : (DEPOP_TAXONOMY.sizeSets[String(productType.sizeSet)]?.sizes ?? []);
      byKey.set(key(department.id, group.id, productType.id), {
        department,
        group,
        productType,
        sizes,
      });
    }
  }
}

function key(department: string, group: string, productType: string): string {
  return `${department}/${group}/${productType}`;
}

/** The product type with these ids, or `null` when Depop has no such one. */
export function depopProductType(
  department: string,
  group: string,
  productType: string,
): DepopProductType | null {
  return byKey.get(key(department, group, productType)) ?? null;
}

/** Every product type in every department, in Depop's order. */
export function depopProductTypes(): DepopProductType[] {
  return [...byKey.values()];
}

/** An attribute (`colour`, `material`, ...), or `null` when the form has none by that id. */
export function depopAttribute(id: string): DepopAttributeData | null {
  return DEPOP_TAXONOMY.attributes[id] ?? null;
}

const banned = new Set(DEPOP_TAXONOMY.bannedHashtags.map((tag) => tag.toLowerCase()));

/** Whether Depop refuses this hashtag (without the `#`), ignoring case. */
export function isBannedDepopHashtag(tag: string): boolean {
  return banned.has(tag.toLowerCase());
}
