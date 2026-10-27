/**
 * The categories an item can be listed in on an automated marketplace (Poshmark, Mercari,
 * Depop), in that marketplace's own names, for the List flow: the one Listora maps the item to
 * when it can tell, and otherwise the seller's choice. A listing names its choice in its
 * `variant.categoryRef`, in the form each marketplace's payload reads (`Men > Tops > T-shirts`,
 * Poshmark's `Men/Shirts/Tees - Short Sleeve`), so what the seller picks is exactly what the
 * listing form is filled with.
 *
 * Items Listora can't place with confidence (unisex items on Mercari, and items a marketplace's
 * map has no category for) get no suggestion, so the seller picks; the likely ones (a unisex
 * item's men's and women's categories) come first.
 */
import type { Marketplace } from '@listora/db';

import { allDepopCategories, mapDepopCategory } from './depop/categories.ts';
import { mapMercariCategory, mappedMercariCategories } from './mercari/categories.ts';
import {
  mappedPoshmarkCatalogs,
  mapPoshmarkCatalog,
  type PoshmarkCatalog,
} from './poshmark/catalog.ts';

/** One category, as a listing names it and as the seller reads it. */
export interface CategoryChoice {
  /** What `variant.categoryRef` takes. */
  ref: string;
  /** The marketplace's names, top level first. */
  path: string[];
}

export interface MarketplaceCategories {
  /** The category Listora maps the item to; `null` when the seller has to pick. */
  suggested: CategoryChoice | null;
  /** The ones the item most likely belongs in, for a seller who picks. */
  likely: CategoryChoice[];
  /** Every category Listora can list in on the marketplace. */
  choices: CategoryChoice[];
}

/** The item fields its category comes from. */
export interface CategorizedItem {
  category: string | null;
  department: string | null;
}

/** The marketplace's categories for the item; `null` for a marketplace without a picker. */
export function marketplaceCategories(
  marketplace: Marketplace,
  item: CategorizedItem,
): MarketplaceCategories | null {
  switch (marketplace) {
    case 'poshmark':
      return assemble(
        mappedPoshmarkCatalogs().map(poshmarkChoice),
        (department) => {
          const found = mapPoshmarkCatalog(item.category, department);
          return found === null ? null : poshmarkChoice(found);
        },
        item,
        // Poshmark's own form puts unisex items under Men, whose letter sizes fit them.
        true,
      );
    case 'mercari':
      return assemble(
        mappedMercariCategories().map((entry) => namedChoice(entry.path)),
        (department) => {
          const found = mapMercariCategory(item.category, department);
          return found === null ? null : namedChoice(found.path);
        },
        item,
        false,
      );
    case 'depop':
      return assemble(
        allDepopCategories().map((entry) => namedChoice(entry.path)),
        (department) => {
          const found = mapDepopCategory(item.category, department);
          return found === null ? null : namedChoice(found.path);
        },
        item,
        // Depop has no unisex department; Listora lists unisex items under Men.
        true,
      );
    case 'ebay':
      // eBay's categories come from its own taxonomy (packages/marketplaces/src/ebay).
      return null;
  }
}

function assemble(
  all: readonly CategoryChoice[],
  mapped: (department: string | null) => CategoryChoice | null,
  item: CategorizedItem,
  unisexMaps: boolean,
): MarketplaceCategories {
  const choices = [...new Map(all.map((choice) => [choice.ref, choice])).values()].sort((a, b) =>
    a.ref.localeCompare(b.ref),
  );
  const own = mapped(item.department);
  const suggested = own !== null && (item.department !== 'unisex' || unisexMaps) ? own : null;
  const likely =
    suggested !== null
      ? [suggested]
      : distinct(
          ['women', 'men'].flatMap((department) => {
            const found = mapped(department);
            return found === null ? [] : [found];
          }),
        );
  return { suggested, likely, choices };
}

function namedChoice(path: readonly string[]): CategoryChoice {
  return { ref: path.join(' > '), path: [...path] };
}

function poshmarkChoice(catalog: PoshmarkCatalog): CategoryChoice {
  const path = [
    catalog.department,
    catalog.category,
    ...(catalog.subcategory === null ? [] : [catalog.subcategory]),
  ];
  return { ref: path.join('/'), path };
}

function distinct(choices: readonly CategoryChoice[]): CategoryChoice[] {
  return [...new Map(choices.map((choice) => [choice.ref, choice])).values()];
}
