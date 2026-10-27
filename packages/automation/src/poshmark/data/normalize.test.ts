/**
 * Turning what Poshmark's listing form holds into catalog.json, and checking the committed
 * catalog.json, which `refresh.ts` writes.
 */
import { describe, expect, it } from 'vitest';

import catalogJson from './catalog.json' with { type: 'json' };
import { catalogDataSchema, formCatalogSchema, normalizeCatalog } from './normalize.ts';
import { describeChanges } from './refresh.ts';

const size = (id: string, display = id, short = display) => ({ id, display, short });
const set = (name: string, sizes: ReturnType<typeof size>[]) => ({
  name,
  size_systems: { us: { sizes } },
});

/** A form's page state in miniature, with Poshmark's own keys. */
const FORM = formCatalogSchema.parse({
  catalogMeta: {
    updated_at: '2026-10-12T12:33:53-07:00',
    colors: [{ name: 'Red' }, { name: 'Blue' }],
    catalog: {
      departments: [
        {
          id: 'd1',
          display: 'Men',
          categories: [
            {
              id: 'c1',
              display: 'Shirts',
              size_sets: [set('Standard', [size('M'), size('15.5', 'Neck 15.5')])],
              category_features: [{ display: 'Polos' }],
            },
            { group: 'Global & Traditional Wear', display: 'Global & Traditional Wear' },
            {
              id: 'c2',
              display: 'Kurtas',
              size_sets: [set('Standard', [size('M'), size('15.5', 'Neck 15.5')])],
            },
            {
              id: 'c3',
              display: 'Bags',
              size_sets: [set('Standard', [size('OS', 'One Size', 'OS')])],
            },
          ],
        },
      ],
    },
  },
  grouping: { d1: { c2: { group: 'Global & Traditional Wear' } } },
  conditions: [{ type: 'nwt', label: 'New With Tags (NWT)' }],
});

describe('normalizeCatalog', () => {
  it("keeps the form's names, groups, subcategories, and US sizes, each size set once", () => {
    const data = normalizeCatalog(FORM, '2026-10-27');
    expect(data.departments).toEqual([
      {
        name: 'Men',
        id: 'd1',
        categories: [
          {
            name: 'Shirts',
            id: 'c1',
            group: null,
            subcategories: ['Polos'],
            sizeSets: ['Men/Shirts/Standard'],
          },
          {
            name: 'Kurtas',
            id: 'c2',
            group: 'Global & Traditional Wear',
            subcategories: [],
            sizeSets: ['Men/Shirts/Standard'],
          },
          { name: 'Bags', id: 'c3', group: null, subcategories: [], sizeSets: ['Standard: OS'] },
        ],
      },
    ]);
    expect(data.sizeSets['Men/Shirts/Standard']?.sizes).toEqual([
      ['M', 'M', 'M'],
      ['15.5', 'Neck 15.5', 'Neck 15.5'],
    ]);
    expect(data).toMatchObject({
      readAt: '2026-10-27',
      catalogUpdatedAt: '2026-10-12T12:33:53-07:00',
      conditions: [{ code: 'nwt', label: 'New With Tags (NWT)' }],
      colors: ['Red', 'Blue'],
    });
    expect(catalogDataSchema.parse(data)).toEqual(data);
  });

  it('refuses page state without the catalog, rather than writing an empty one', () => {
    expect(() => formCatalogSchema.parse({ grouping: {}, conditions: [] })).toThrow();
  });

  it('names every category a refresh adds, changes, or drops', () => {
    const before = normalizeCatalog(FORM, '2026-10-27');
    const after = structuredClone(before);
    const [men] = after.departments;
    if (men === undefined) throw new Error('no department');
    men.categories = men.categories.filter((category) => category.name !== 'Bags');
    men.categories[0]?.subcategories.push('Tank Tops');
    expect(describeChanges(before, after)).toEqual([
      '~ Men/Shirts: 1 subcategories, size sets Men/Shirts/Standard → 2 subcategories, size sets Men/Shirts/Standard',
      '- Men/Bags',
    ]);
  });
});

describe('catalog.json', () => {
  it('is what the schema says, with every size set a category names', () => {
    const data = catalogDataSchema.parse(catalogJson);
    for (const department of data.departments) {
      for (const category of department.categories) {
        for (const key of category.sizeSets) expect(data.sizeSets[key], key).toBeDefined();
      }
    }
  });
});
