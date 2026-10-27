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
 * item's men's and women's categories) come first. The API's `getItemMarketplaceCategories`
 * answers the marketplace pre-fill's category and short list instead (prefill/, which also
 * asks the AI), and keeps `choices` from here.
 */
import type { Marketplace } from '@listora/db';

import {
  allDepopCategories,
  mapDepopCategory,
  parseCategoryRef as parseDepopCategoryRef,
} from './depop/categories.ts';
import {
  mapMercariCategory,
  mappedMercariCategories,
  parseCategoryRef as parseMercariCategoryRef,
} from './mercari/categories.ts';
import {
  mappedPoshmarkCatalogs,
  mapPoshmarkCatalog,
  parseCatalogRef,
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

/** An imported listing's category: the marketplace's own, and Listora's canonical one. */
export interface ImportedCategory {
  /** The marketplace's category as a listing names it, when Listora knows it. */
  marketplace: CategoryChoice | null;
  /** Listora's canonical category path (`clothing/dresses/dresses`), when one fits. */
  category: string | null;
  /** Who it is for (`women`, `men`, `kids`), when the marketplace's department says. */
  department: string | null;
}

/**
 * The category of a listing an import read (docs/features/imports.md): the marketplace's own,
 * checked against its tree (Depop's taxonomy, Poshmark's catalog, Mercari's catalog), and the
 * canonical category among `canonical` (Listora's vocabulary, every `<category>/<subcategory>`)
 * whose mapping onto that marketplace lands closest to it: on the same category, else under the
 * same parent, then the one whose name the marketplace's names say (an `other` before a guess).
 * A department the marketplace names (Women, Men, Kids) is the item's.
 */
export function importedCategory(
  marketplace: Marketplace,
  ref: string | null,
  canonical: readonly string[],
): ImportedCategory {
  const own = ref === null ? null : ownCategory(marketplace, ref);
  if (own === null) return { marketplace: null, category: null, department: null };
  const department = departmentOf(own.path[0]);
  const departments = department === null ? ['women', 'men', 'kids', null] : [department];
  let best: { category: string; score: number } | null = null;
  for (const path of canonical) {
    for (const candidate of departments) {
      const mapped = forward(marketplace, path, candidate);
      if (mapped === null) continue;
      const shared = sharedLevels(mapped.path, own.path);
      if (shared < Math.min(2, own.path.length)) continue;
      // Closest first; among as close, the one whose own name the marketplace's names say.
      const score = shared * 10 + (shared === own.path.length ? 5 : 0) + named(path, own.path);
      if (best === null || score > best.score) best = { category: path, score };
    }
  }
  return { marketplace: own, category: best?.category ?? null, department };
}

function ownCategory(marketplace: Marketplace, ref: string): CategoryChoice | null {
  switch (marketplace) {
    case 'depop': {
      const found = parseDepopCategoryRef(ref, null);
      return found === null ? null : namedChoice(found.path);
    }
    case 'poshmark': {
      const found = parseCatalogRef(ref);
      return found === null ? null : poshmarkChoice(found);
    }
    case 'mercari': {
      const found = parseMercariCategoryRef(ref);
      return found === null ? null : namedChoice(found.path);
    }
    case 'ebay':
      return null;
  }
}

function forward(
  marketplace: Marketplace,
  canonical: string,
  department: string | null,
): CategoryChoice | null {
  switch (marketplace) {
    case 'depop': {
      const found = mapDepopCategory(canonical, department);
      return found === null ? null : namedChoice(found.path);
    }
    case 'poshmark': {
      const found = mapPoshmarkCatalog(canonical, department);
      return found === null ? null : poshmarkChoice(found);
    }
    case 'mercari': {
      const found = mapMercariCategory(canonical, department);
      return found === null ? null : namedChoice(found.path);
    }
    case 'ebay':
      return null;
  }
}

/** How many levels two category paths share from the top. */
function sharedLevels(a: readonly string[], b: readonly string[]): number {
  let shared = 0;
  while (shared < a.length && shared < b.length && same(a[shared], b[shared])) shared += 1;
  return shared;
}

function same(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && a.toLowerCase() === b?.toLowerCase();
}

/**
 * How well a canonical subcategory's name fits the marketplace's: named by its own category
 * (Mercari's `Dresses > Maxi` is a dress), else by its parent, else an `other`, which claims
 * nothing.
 */
function named(canonical: string, path: readonly string[]): number {
  const subcategory = canonical.split('/').at(-1) ?? '';
  if (subcategory === 'other') return 1;
  const words = new Set(subcategory.split('_').map(stem));
  const says = (name: string | undefined) =>
    (name ?? '')
      .toLowerCase()
      .split(/[^a-z]+/)
      .some((word) => word !== '' && words.has(stem(word)));
  if (says(path.at(-1))) return 3;
  if (path.length > 2 && says(path[1])) return 2;
  return 0;
}

/** A word without its plural ending, so `dress` and `dresses` compare. */
function stem(word: string): string {
  return word.replace(/(es|s)$/, '');
}

function departmentOf(name: string | undefined): string | null {
  switch ((name ?? '').toLowerCase()) {
    case 'women':
      return 'women';
    case 'men':
      return 'men';
    case 'kids':
      return 'kids';
    default:
      return null;
  }
}
